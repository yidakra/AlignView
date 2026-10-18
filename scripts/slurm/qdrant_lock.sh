# shellcheck shell=bash
# One Qdrant server per storage folder.
#
# Every serving/eval/ingest job starts its own Qdrant on the shared project
# index. Two servers on the same storage can corrupt it, so a job takes this
# lock before starting Qdrant and releases it on exit.
#
#   source scripts/slurm/qdrant_lock.sh
#   qdrant_lock "$QSTORE" || exit 4     # before starting qdrant
#   trap '...; qdrant_unlock' EXIT
#
# The lock file records user, Slurm job id, host and time. A lock whose job is
# no longer running (crash, scancel, timeout) is taken over automatically;
# a lock held by a running job stops this one with a message naming it.

qdrant_lock() {
  local store="$1"
  QDRANT_LOCK_FILE="${store%/}/.castlerag-qdrant.lock"
  QDRANT_LOCK_ID="${USER:-unknown} ${SLURM_JOB_ID:-nojob} $(hostname) $(date -Iseconds)"
  mkdir -p "$store" || return 1
  local attempt holder_user holder_job holder_host holder_time state
  for attempt in 1 2; do
    if ( set -o noclobber; printf '%s\n' "$QDRANT_LOCK_ID" > "$QDRANT_LOCK_FILE" ) 2>/dev/null; then
      echo "[qdrant-lock] acquired $QDRANT_LOCK_FILE"
      return 0
    fi
    read -r holder_user holder_job holder_host holder_time < "$QDRANT_LOCK_FILE" 2>/dev/null || true
    state=""
    if [ -n "${holder_job:-}" ] && [ "$holder_job" != "nojob" ]; then
      state="$(squeue -h -j "$holder_job" -o %T 2>/dev/null | head -1)"
    fi
    case "$state" in
      RUNNING|COMPLETING|CONFIGURING|SUSPENDED|STOPPED)
        echo "[qdrant-lock] ABORT: Qdrant storage $store is in use by ${holder_user:-?}'s job ${holder_job} on ${holder_host:-?} (since ${holder_time:-?})." >&2
        echo "[qdrant-lock] Two Qdrant servers on one storage folder can corrupt the index. Wait for that job, or ask ${holder_user:-its owner} to stop it." >&2
        return 4
        ;;
    esac
    if [ "${holder_job:-}" = "nojob" ] && [ "$attempt" = 1 ]; then
      echo "[qdrant-lock] ABORT: $QDRANT_LOCK_FILE is held outside Slurm by ${holder_user:-?} on ${holder_host:-?} (since ${holder_time:-?}); remove it by hand if that server is gone." >&2
      return 4
    fi
    echo "[qdrant-lock] taking over a stale lock from ${holder_user:-?}'s job ${holder_job:-?} (not running)"
    rm -f "$QDRANT_LOCK_FILE"
  done
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
