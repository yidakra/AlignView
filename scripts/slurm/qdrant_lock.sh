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
# only when sacct says the holder job has ended; anything else (running,
# pending, requeued, unknown, or sacct failing) keeps the lock, so a Slurm
# hiccup can never put two servers on one index.

_qdrant_job_ended() {
  # 0 only if sacct positively reports a final state for job $1.
  local state
  state="$(sacct -j "$1" -X -n -o State 2>/dev/null | head -1 | awk '{print $1}')" || return 1
  case "$state" in
    COMPLETED|FAILED|CANCELLED*|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE) return 0 ;;
    *) return 1 ;;
  esac
}

_qdrant_read_holder() {
  # Sets QDRANT_HOLDER to the lock's first line, waiting briefly for a writer
  # that has created the file but not yet written it.
  local tries=0 max_tries="${QDRANT_LOCK_READ_TRIES:-5}"
  QDRANT_HOLDER=""
  while [ $tries -lt "$max_tries" ]; do
    QDRANT_HOLDER="$(head -1 "$1" 2>/dev/null || true)"
    [ "$(printf '%s' "$QDRANT_HOLDER" | wc -w)" -ge 4 ] && return 0
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

qdrant_lock() {
  local store="$1" mutex holder_user holder_job holder_host holder_time
  QDRANT_LOCK_FILE="${store%/}/.castlerag-qdrant.lock"
  QDRANT_LOCK_ID="${USER:-unknown} ${SLURM_JOB_ID:-nojob} $(hostname) $(date -Iseconds)"
  mkdir -p "$store" || return 1

  if ( set -o noclobber; printf '%s\n' "$QDRANT_LOCK_ID" > "$QDRANT_LOCK_FILE" ) 2>/dev/null; then
    echo "[qdrant-lock] acquired $QDRANT_LOCK_FILE"
    return 0
  fi

  if ! _qdrant_read_holder "$QDRANT_LOCK_FILE"; then
    echo "[qdrant-lock] ABORT: $QDRANT_LOCK_FILE exists but is empty or partial; another job may be taking it right now. Retry in a minute." >&2
    return 4
  fi
  read -r holder_user holder_job holder_host holder_time <<< "$QDRANT_HOLDER"

  if [ "$holder_job" = "nojob" ]; then
    echo "[qdrant-lock] ABORT: $QDRANT_LOCK_FILE is held outside Slurm by $holder_user on $holder_host (since $holder_time); remove it by hand if that server is gone." >&2
    return 4
  fi
  if ! _qdrant_job_ended "$holder_job"; then
    echo "[qdrant-lock] ABORT: Qdrant storage $store is in use by $holder_user's job $holder_job on $holder_host (since $holder_time)." >&2
    echo "[qdrant-lock] Two Qdrant servers on one storage folder can corrupt the index. Wait for that job, or ask $holder_user to stop it." >&2
    return 4
  fi

  # Take over a stale lock under an atomic mutex, re-checking that the lock
  # still holds the line read above, so two contenders can't both win.
  mutex="${QDRANT_LOCK_FILE}.takeover"
  if ! mkdir "$mutex" 2>/dev/null; then
    echo "[qdrant-lock] ABORT: another job is taking over the stale lock right now ($mutex). Retry in a minute; remove $mutex by hand if it is older than that." >&2
    return 4
  fi
  if [ "$(head -1 "$QDRANT_LOCK_FILE" 2>/dev/null)" != "$QDRANT_HOLDER" ]; then
    rmdir "$mutex"
    echo "[qdrant-lock] ABORT: the lock changed hands while checking it. Retry in a minute." >&2
    return 4
  fi
  rm -f "$QDRANT_LOCK_FILE"
  if ( set -o noclobber; printf '%s\n' "$QDRANT_LOCK_ID" > "$QDRANT_LOCK_FILE" ) 2>/dev/null; then
    rmdir "$mutex"
    echo "[qdrant-lock] took over a stale lock from $holder_user's job $holder_job (ended); acquired $QDRANT_LOCK_FILE"
    return 0
  fi
  rmdir "$mutex"
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
