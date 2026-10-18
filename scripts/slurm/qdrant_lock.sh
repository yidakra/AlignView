# shellcheck shell=bash
# One Qdrant server per storage folder.
#
# Every serving/eval/ingest job starts its own Qdrant on the shared project
# index. Two servers on the same storage can corrupt it, so a job takes this
# lock before it starts anything and releases it on exit.
#
#   source scripts/slurm/qdrant_lock.sh
#   qdrant_lock "$QSTORE" || exit 4     # before starting any server
#   trap 'qdrant_unlock' EXIT           # later traps keep "; qdrant_unlock"
#
# The lock file records user, Slurm job id, host and time. It is taken over
# only when Slurm positively says the holder job has ended; anything else
# (running, pending, requeued, unknown, hidden, or Slurm errors) keeps it, so
# a Slurm hiccup can never put two servers on one index. A takeover runs
# under a mutex directory that records its owner job, and a mutex is only
# cleared when its owner job has ended, so a live contender is never evicted.

_qdrant_job_ended() {
  # 0 only if Slurm positively says job $1 (owned by user $2) is over.
  local job="$1" owner="$2" state out err rc
  state="$(sacct -j "$job" -X -n -S 2000-01-01 -o State 2>/dev/null | head -1 | awk '{print $1}')"
  if [ -n "$state" ]; then
    case "$state" in
      COMPLETED|FAILED|CANCELLED*|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE) return 0 ;;
      *) return 1 ;;
    esac
  fi
  # No accounting record (purged, no accounting, or another user's job that
  # sacct hides). The controller saying the id is invalid is proof; an empty
  # list is proof only for our own jobs, since clusters may hide other
  # users' running jobs from squeue.
  err="$(mktemp)"
  out="$(squeue -h -j "$job" -o %T 2>"$err")"; rc=$?
  if [ $rc -ne 0 ] && grep -qi "invalid job id" "$err"; then rm -f "$err"; return 0; fi
  rm -f "$err"
  if [ $rc -eq 0 ] && [ -z "$out" ] && [ "$owner" = "${USER:-}" ]; then return 0; fi
  return 1
}

_qdrant_read_line() {
  # Sets QDRANT_LINE to the first line of $1 once it has 4 fields, waiting
  # briefly for a writer that has created the file but not yet written it.
  local tries=0 max_tries="${QDRANT_LOCK_READ_TRIES:-5}"
  QDRANT_LINE=""
  while [ $tries -lt "$max_tries" ]; do
    QDRANT_LINE="$(head -1 "$1" 2>/dev/null || true)"
    [ "$(printf '%s' "$QDRANT_LINE" | wc -w)" -ge 4 ] && return 0
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

_qdrant_mutex_take() {
  # Take mutex dir $1 for QDRANT_LOCK_ID, clearing it first if its recorded
  # owner job has ended. 0 on success.
  local mutex="$1" owner_user owner_job rest moved
  if mkdir "$mutex" 2>/dev/null; then
    printf '%s\n' "$QDRANT_LOCK_ID" > "$mutex/owner"
    return 0
  fi
  local age
  age=$(( $(date +%s) - $(stat -c %Y "$mutex" 2>/dev/null || stat -f %m "$mutex" 2>/dev/null || date +%s) ))
  if _qdrant_read_line "$mutex/owner"; then
    read -r owner_user owner_job rest <<< "$QDRANT_LINE"
    if [ "$owner_job" = "nojob" ]; then
      # Owner ran outside Slurm, so there is no job to ask about: a takeover
      # takes well under a second, so only a clearly old mutex is stale.
      [ "$age" -gt "${QDRANT_LOCK_MUTEX_STALE_SECONDS:-60}" ] || return 1
    elif ! _qdrant_job_ended "$owner_job" "$owner_user"; then
      return 1   # a live (or unknowable) contender holds it
    fi
  else
    # No owner recorded: a job died between mkdir and writing the owner.
    # That window is microseconds, so only a clearly old dir counts.
    [ "$age" -gt "${QDRANT_LOCK_MUTEX_STALE_SECONDS:-60}" ] || return 1
    QDRANT_LINE=""
  fi
  # Move the stale mutex aside atomically and make sure it is the one judged.
  moved="${mutex}.stale.$$.${RANDOM}"
  mv "$mutex" "$moved" 2>/dev/null || return 1
  if [ "$(head -1 "$moved/owner" 2>/dev/null || true)" != "$QDRANT_LINE" ]; then
    # Not the mutex we judged: a contender replaced it in between. Never move
    # it back (mv into a recreated dir would nest); drop it. Its owner checks
    # that its mutex is still its own before touching the lock, so it backs
    # off and retries.
    rm -rf "$moved"
    return 1
  fi
  rm -rf "$moved"
  if [ -n "${owner_job:-}" ]; then
    echo "[qdrant-lock] cleared a takeover mutex left by ended job $owner_job (user $owner_user)"
  else
    echo "[qdrant-lock] cleared a takeover mutex left by a job that died before recording itself"
  fi
  mkdir "$mutex" 2>/dev/null || return 1
  printf '%s\n' "$QDRANT_LOCK_ID" > "$mutex/owner"
}

_qdrant_mutex_release() {
  if [ "$(head -1 "$1/owner" 2>/dev/null || true)" = "$QDRANT_LOCK_ID" ]; then
    rm -f "$1/owner"
    rmdir "$1" 2>/dev/null || true
  fi
}

qdrant_lock() {
  local store="$1" mutex holder holder_user holder_job holder_host holder_time
  QDRANT_LOCK_FILE="${store%/}/.castlerag-qdrant.lock"
  QDRANT_LOCK_ID="${USER:-unknown} ${SLURM_JOB_ID:-nojob} $(hostname) $(date -Iseconds)"
  mkdir -p "$store" || return 1

  if ( set -o noclobber; printf '%s\n' "$QDRANT_LOCK_ID" > "$QDRANT_LOCK_FILE" ) 2>/dev/null; then
    echo "[qdrant-lock] acquired $QDRANT_LOCK_FILE"
    return 0
  fi

  if ! _qdrant_read_line "$QDRANT_LOCK_FILE"; then
    echo "[qdrant-lock] ABORT: $QDRANT_LOCK_FILE exists but is empty or partial; another job may be taking it right now. Retry in a minute." >&2
    return 4
  fi
  holder="$QDRANT_LINE"
  read -r holder_user holder_job holder_host holder_time <<< "$holder"

  if [ "$holder_job" = "nojob" ]; then
    echo "[qdrant-lock] ABORT: $QDRANT_LOCK_FILE is held outside Slurm by $holder_user on $holder_host (since $holder_time); remove it by hand if that server is gone." >&2
    return 4
  fi
  if ! _qdrant_job_ended "$holder_job" "$holder_user"; then
    echo "[qdrant-lock] ABORT: Qdrant storage $store is in use by $holder_user's job $holder_job on $holder_host (since $holder_time)." >&2
    echo "[qdrant-lock] Two Qdrant servers on one storage folder can corrupt the index. Wait for that job, or ask $holder_user to stop it; if Slurm no longer knows that job, remove $QDRANT_LOCK_FILE by hand." >&2
    return 4
  fi

  mutex="${QDRANT_LOCK_FILE}.takeover"
  if ! _qdrant_mutex_take "$mutex"; then
    echo "[qdrant-lock] ABORT: another job is taking over the stale lock right now ($mutex). Retry in a minute." >&2
    return 4
  fi
  # Still ours, and the lock still holds the stale line judged above?
  if [ "$(head -1 "$mutex/owner" 2>/dev/null || true)" != "$QDRANT_LOCK_ID" ] \
     || [ "$(head -1 "$QDRANT_LOCK_FILE" 2>/dev/null || true)" != "$holder" ]; then
    _qdrant_mutex_release "$mutex"
    echo "[qdrant-lock] ABORT: the lock changed hands while checking it. Retry in a minute." >&2
    return 4
  fi
  rm -f "$QDRANT_LOCK_FILE"
  if ( set -o noclobber; printf '%s\n' "$QDRANT_LOCK_ID" > "$QDRANT_LOCK_FILE" ) 2>/dev/null; then
    _qdrant_mutex_release "$mutex"
    echo "[qdrant-lock] took over a stale lock from $holder_user's job $holder_job (ended); acquired $QDRANT_LOCK_FILE"
    return 0
  fi
  _qdrant_mutex_release "$mutex"
  echo "[qdrant-lock] ABORT: could not acquire $QDRANT_LOCK_FILE" >&2
  return 4
}

qdrant_unlock() {
  # Only remove the lock if it is still ours.
  [ -n "${QDRANT_LOCK_FILE:-}" ] || return 0
  if [ -f "$QDRANT_LOCK_FILE" ] && [ "$(head -1 "$QDRANT_LOCK_FILE" 2>/dev/null)" = "${QDRANT_LOCK_ID:-}" ]; then
    rm -f "$QDRANT_LOCK_FILE"
  fi
}
