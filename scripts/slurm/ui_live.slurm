#!/bin/bash
# ui_live.slurm — serve the CastleRAG dashboard wired to the REAL RAG pipeline.
#
# Boots OmniEmbed (embeddings, :8200), Qwen3-VL (rerank+generation, :8201) and
# Qdrant against the EXISTING persisted index, then launches `castlerag ui` with
# the live RagEngine.  Non-destructive: it never preprocesses / embeds / indexes
# / creates collections, and aborts if the collection looks emptied.
#
# Reach it from your laptop with an SSH tunnel to the compute node (the script
# prints the exact command once the node is known):
#
#   sbatch --account=gisr109364 scripts/slurm/ui_live.slurm
#   # then, from your laptop (NODE printed in logs/castle-ui-live_<jobid>.out):
#   ssh -L 8050:<NODE>:8050 scur0225@snellius.surf.nl
#   # open http://localhost:8050  (top-bar chip should read "live RAG")

#SBATCH --job-name=castle-ui-live
#SBATCH --partition=gpu_a100
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=120G
#SBATCH --gres=gpu:2
#SBATCH --time=03:00:00
#SBATCH --output=logs/%x_%j.out
#SBATCH --error=logs/%x_%j.out

set -euo pipefail
umask 0007   # project space is shared with the prjs2298 group: group read/write on new files

CONF="${CONF:-configs/snellius_project.yaml}"   # index + derived data in /projects/prjs2298; scratch configs are stale
SC="/scratch-shared/${USER}"
COLL="castle_multimodal_v1"
UI_PORT="${UI_PORT:-8050}"

# Trim the basic-auth credentials the same way the UI does, so whitespace-only
# credentials count as unset (the UI would install no auth gate for them) and
# the readiness probe sends exactly what the UI checks.
CASTLERAG_UI_BASIC_AUTH="$(printf '%s' "${CASTLERAG_UI_BASIC_AUTH:-}" \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
export CASTLERAG_UI_BASIC_AUTH

# Check the credentials before any GPU service starts. A public tunnel needs
# them, and the UI refuses a value without a non-empty user and password.
_auth="${CASTLERAG_UI_BASIC_AUTH}"
if [ -z "${_auth}" ]; then
    if [ -n "${NGROK_DOMAIN:-}" ] || [ "${PUBLIC_TUNNEL:-0}" = "1" ]; then
        echo "[ui] ABORT: a public tunnel needs CASTLERAG_UI_BASIC_AUTH=user:password."
        exit 2
    fi
elif [[ "${_auth}" != *:* ]] || [ -z "${_auth%%:*}" ] || [ -z "${_auth#*:}" ]; then
    echo "[ui] ABORT: CASTLERAG_UI_BASIC_AUTH must be user:password with both parts non-empty."
    exit 2
fi
unset _auth

# If something already answers on UI_PORT, the readiness probe below could
# succeed against it and a tunnel would publish the wrong service.
if curl -s -o /dev/null --connect-timeout 2 --max-time 5 "http://localhost:${UI_PORT}/"; then
    echo "[ui] ABORT: port ${UI_PORT} is already in use on $(hostname); set UI_PORT=..."
    exit 2
fi
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
export VLLM_LOGGING_LEVEL=WARNING

module purge; module load 2024; module load Python/3.12.3-GCCcore-13.3.0 CUDA/12.6.0 FFmpeg/7.0.2-GCCcore-13.3.0
source "${HOME}/castlerag_venv/bin/activate"
cd "${SLURM_SUBMIT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Values exported at submission (sbatch --export) win over the config.
_SUBMIT_QDRANT_BIN="${QDRANT_BIN:-}"
_SUBMIT_QDRANT_STORAGE="${QDRANT_STORAGE:-}"
PATHS="$(castlerag paths --config "${CONF}")" || { echo "ABORT: castlerag paths failed for ${CONF}"; exit 1; }
eval "${PATHS}"
QSTORE="${_SUBMIT_QDRANT_STORAGE:-${QDRANT_STORAGE:-${SC}/qdrant_storage}}"
QDRANT_BIN="${_SUBMIT_QDRANT_BIN:-${QDRANT_BIN:-${HOME}/qdrant/qdrant}}"   # submit > config qdrant.binary > own copy
[ -x "${QDRANT_BIN}" ] || { echo "ABORT: Qdrant binary not executable: ${QDRANT_BIN} (set qdrant.binary in ${CONF})"; exit 1; }
# Model cache: CASTLERAG_HF_HOME > config slurm.hf_home > scratch. HF_HOME itself is
# not honoured from the environment, since login shells often set it elsewhere.
export HF_HOME="${CASTLERAG_HF_HOME:-${HF_HOME_DIR:-${SC}/hf_cache}}"
[ -d "${HF_HOME}/hub" ] || { echo "ABORT: no model cache at ${HF_HOME}/hub (jobs run offline; set slurm.hf_home in ${CONF})"; exit 1; }
# One Qdrant per storage folder: take the lock before any server starts, so a
# refusal leaves nothing running (see scripts/slurm/qdrant_lock.sh).
source scripts/slurm/qdrant_lock.sh
qdrant_lock "${QSTORE}" || exit 4
trap 'qdrant_unlock' EXIT
mkdir -p logs
echo "[ui] config=${CONF} qdrant_storage=${QSTORE}"

echo "[ui] host=$(hostname) gpu=$(nvidia-smi -L 2>/dev/null | head -1) start=$(date -Iseconds)"

wait_ready() { # url label logfile pid
  local pid="${4:-}"
  for i in $(seq 1 120); do
    curl -sf "$1" >/dev/null 2>&1 && { echo "[ui] $2 ready ($((i*10))s)"; return 0; }
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "[ui] ERROR: $2 server died"; tail -30 "$3" 2>/dev/null; return 1
    fi
    sleep 10
  done
  echo "[ui] ERROR: $2 not ready after 1200s"; tail -30 "$3" 2>/dev/null; return 1
}

# --- OmniEmbed embeddings server (GPU0, :8200) — embeds the live UI queries ---
EMB_LOG="logs/ui_omniembed_${SLURM_JOB_ID}.log"
CUDA_VISIBLE_DEVICES=0 python scripts/omniembed_server.py --port 8200 > "${EMB_LOG}" 2>&1 &
EMB_PID=$!
# --- Qwen3-VL rerank + generation server (GPU1, :8201) ---
GEN_LOG="logs/ui_vllm_${SLURM_JOB_ID}.log"
CUDA_VISIBLE_DEVICES=1 vllm serve Qwen/Qwen3-VL-8B-Instruct \
    --port 8201 --served-model-name Qwen/Qwen3-VL-8B-Instruct qwen3vl \
    --gpu-memory-utilization 0.85 --max-model-len 16384 --trust-remote-code \
    > "${GEN_LOG}" 2>&1 &
GEN_PID=$!
# --- Qdrant against the EXISTING persisted storage (NO create-collection) ---
export QDRANT__STORAGE__STORAGE_PATH="${QSTORE}/storage"
QLOG="logs/ui_qdrant_${SLURM_JOB_ID}.log"
"${QDRANT_BIN}" > "${QLOG}" 2>&1 &
QPID=$!
trap 'kill $EMB_PID $GEN_PID $QPID 2>/dev/null; qdrant_unlock' EXIT

wait_ready "http://localhost:6333/readyz"        qdrant "${QLOG}"   $QPID
wait_ready "http://localhost:8200/v1/models"      embed  "${EMB_LOG}" $EMB_PID
wait_ready "http://localhost:8201/v1/models"      gen    "${GEN_LOG}" $GEN_PID

# --- SAFETY: confirm the existing index is intact before serving ---
PTS=$(curl -s "http://localhost:6333/collections/${COLL}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["points_count"])' 2>/dev/null)
echo "[ui] collection ${COLL} points_count=${PTS:-<none>}"
if ! [[ "${PTS}" =~ ^[0-9]+$ ]]; then
  echo "[ui] ABORT: could not read points_count for ${COLL} (got '${PTS}'); is Qdrant up and the collection present? Not serving."
  exit 2
fi
if [ "${PTS}" -lt 25000 ]; then
  echo "[ui] ABORT: collection has ${PTS} points (<25000); index looks altered. Not serving."
  exit 2
fi

# --- live engine wiring: embeddings -> :8200, rerank/generation -> :8201 ---
export CASTLERAG_CONFIG="${CONF}"                      # host paths (cache_dir, frames, collection)
export OMNIEMBED_BASE_URL="http://localhost:8200/v1"   # OmniEmbed query embeddings
export VLLM_BASE_URL="http://localhost:8201/v1"        # Qwen3-VL rerank + generation
# NOTE: OMNIEMBED_QUERY_CACHE intentionally UNSET so arbitrary UI queries embed live.
# CASTLERAG_STUDY_LOG (opt-in, pass via --export) turns on the user-study
# interaction log; left unset, nothing is logged. See docs/demo.md.
if [ -n "${CASTLERAG_STUDY_LOG:-}" ]; then
    echo "[ui] study interaction log -> ${CASTLERAG_STUDY_LOG}"
fi

# wait_ui_ready: poll the dashboard until it answers (with the basic-auth
# credentials when set). Each request is bounded, and so is the whole wait.
# Returns 1 if the UI dies or is not ready after 180 s, so no tunnel opens.
wait_ui_ready() {
    local deadline=$((SECONDS + 180))
    local auth=()
    if [ -n "${CASTLERAG_UI_BASIC_AUTH}" ]; then auth=(-u "${CASTLERAG_UI_BASIC_AUTH}"); fi
    while [ "${SECONDS}" -lt "${deadline}" ]; do
        if curl -sf --connect-timeout 2 --max-time 5 ${auth[@]+"${auth[@]}"} \
                "http://localhost:${UI_PORT}/" >/dev/null 2>&1; then
            echo "[ui] dashboard ready"
            return 0
        fi
        kill -0 "$UI_PID" 2>/dev/null || { echo "[ui] ERROR: UI process died"; return 1; }
        sleep 2
    done
    echo "[ui] ERROR: dashboard not ready after 180 s; not opening a tunnel."
    return 1
}

NODE="$(hostname)"
cat <<EOF

[ui] ============================================================
[ui]  CastleRAG live UI is starting on ${NODE}:${UI_PORT}
[ui]  From your LAPTOP, open a tunnel, then browse http://localhost:${UI_PORT}
[ui]
[ui]    ssh -L ${UI_PORT}:${NODE}:${UI_PORT} ${USER}@snellius.surf.nl
[ui]
[ui]  (alt, direct to node):  ssh -J ${USER}@snellius.surf.nl ${USER}@${NODE} -L ${UI_PORT}:localhost:${UI_PORT}
[ui]  The top-bar chip should read "live RAG". scancel ${SLURM_JOB_ID} when done.
[ui] ============================================================

EOF

# Exposure modes (--require-live always: fail loudly on a missing dependency):
#   NAMED_TUNNEL_TOKEN set -> run a pre-created Cloudflare *named* tunnel: stable
#       hostname + Cloudflare Access (email allowlist), both configured once in
#       the Zero Trust dashboard. Best for a scheduled demo. Takes precedence.
#   NGROK_DOMAIN set       -> ngrok agent on that reserved domain (free plan
#       includes one) + HTTP basic auth. Same URL every run, no own domain needed.
#   PUBLIC_TUNNEL=1        -> ephemeral quick tunnel + HTTP basic auth.
#   (neither)              -> SSH-tunnel only (default; UI bound 0.0.0.0).

# --- named tunnel: run the connector; the dashboard maps its hostname here. ---
if [ -n "${NAMED_TUNNEL_TOKEN:-}" ]; then
    CFBIN="${CLOUDFLARED:-${HOME}/cloudflared}"
    if [ ! -x "${CFBIN}" ]; then
        echo "[ui] ABORT: cloudflared not found/executable at ${CFBIN} (set CLOUDFLARED=...)."
        exit 2
    fi
    castlerag ui --host 0.0.0.0 --port "${UI_PORT}" --require-live --config "${CONF}" &
    UI_PID=$!
    trap 'kill $EMB_PID $GEN_PID $QPID $UI_PID ${CF_PID:-} 2>/dev/null; qdrant_unlock' EXIT
    wait_ui_ready || exit 1
    # --protocol http2: compute nodes firewall QUIC/UDP-7844; TCP/443 reaches edge.
    CF_LOG="logs/ui_cloudflared_${SLURM_JOB_ID}.log"
    "${CFBIN}" tunnel --no-autoupdate --protocol http2 run --token "${NAMED_TUNNEL_TOKEN}" \
        > "${CF_LOG}" 2>&1 &
    CF_PID=$!
    sleep 6
    if ! kill -0 "$CF_PID" 2>/dev/null; then
        echo "[ui] ERROR: named tunnel connector exited; log:"; tail -20 "${CF_LOG}"; exit 1
    fi
    cat <<EOF

[ui] ============================================================
[ui]  NAMED TUNNEL connector up (protocol=http2, registered to your account).
[ui]  Public URL = the Public Hostname you mapped to this tunnel in the
[ui]               Cloudflare Zero Trust dashboard (service http://localhost:${UI_PORT}).
[ui]  Access     = your email-allowlist policy on that hostname.
[ui]  Stable across runs. scancel ${SLURM_JOB_ID} to stop the connector.
[ui] ============================================================

EOF
    wait "$UI_PID"
    exit 0
fi

# --- ngrok static domain + basic auth: the same public URL on every run. ---
# The authtoken comes from the agent's own config (`~/ngrok config add-authtoken`)
# or NGROK_AUTHTOKEN; it is never passed on the command line.
if [ -n "${NGROK_DOMAIN:-}" ]; then
    if [ -z "${CASTLERAG_UI_BASIC_AUTH:-}" ]; then
        echo "[ui] ABORT: NGROK_DOMAIN needs CASTLERAG_UI_BASIC_AUTH=user:pass"
        echo "[ui]        (refusing to expose the live backend with no auth)."
        exit 2
    fi
    NGBIN="${NGROK:-${HOME}/ngrok}"
    if [ ! -x "${NGBIN}" ]; then
        echo "[ui] ABORT: ngrok not found/executable at ${NGBIN} (set NGROK=...)."
        exit 2
    fi
    castlerag ui --host 0.0.0.0 --port "${UI_PORT}" --require-live --config "${CONF}" &
    UI_PID=$!
    trap 'kill $EMB_PID $GEN_PID $QPID $UI_PID ${NG_PID:-} 2>/dev/null; qdrant_unlock' EXIT
    wait_ui_ready || exit 1
    NG_LOG="logs/ui_ngrok_${SLURM_JOB_ID}.log"
    "${NGBIN}" http "${UI_PORT}" --url "https://${NGROK_DOMAIN#https://}" \
        --log stdout --log-format logfmt > "${NG_LOG}" 2>&1 &
    NG_PID=$!
    NG_UP=0
    for i in $(seq 1 30); do
        grep -q 'msg="started tunnel"' "${NG_LOG}" 2>/dev/null && { NG_UP=1; break; }
        kill -0 "$NG_PID" 2>/dev/null || break
        sleep 2
    done
    if [ "${NG_UP}" != 1 ]; then
        echo "[ui] ERROR: ngrok tunnel did not start; log:"; tail -20 "${NG_LOG}"; exit 1
    fi
    cat <<EOF

[ui] ============================================================
[ui]  PUBLIC DEMO URL : https://${NGROK_DOMAIN#https://}
[ui]  basic-auth user : ${CASTLERAG_UI_BASIC_AUTH%%:*}  (share the password out-of-band)
[ui]  Same URL every run. scancel ${SLURM_JOB_ID} to tear it down.
[ui]  Free plan: first visit shows ngrok's one-time warning page; click "Visit Site".
[ui] ============================================================

EOF
    # Stop the job if the tunnel or the UI exits, so a dead public link does not
    # keep holding the GPUs.
    while kill -0 "$UI_PID" 2>/dev/null && kill -0 "$NG_PID" 2>/dev/null; do sleep 10; done
    if ! kill -0 "$NG_PID" 2>/dev/null; then
        echo "[ui] ERROR: ngrok tunnel exited; stopping the job. log:"; tail -20 "${NG_LOG}"; exit 1
    fi
    echo "[ui] UI process exited; stopping the job."
    wait "$UI_PID" || exit 1
    exit 0
fi

# --- quick tunnel (ephemeral URL) + basic auth, or default SSH-tunnel serve ---
# PUBLIC_TUNNEL=1 requires CASTLERAG_UI_BASIC_AUTH=user:pass — the app gates
# every request, so the live GPU backend isn't open to anyone with the link.
if [ "${PUBLIC_TUNNEL:-0}" != "1" ]; then
    exec castlerag ui --host 0.0.0.0 --port "${UI_PORT}" \
        --require-live --config "${CONF}"
fi

if [ -z "${CASTLERAG_UI_BASIC_AUTH:-}" ]; then
    echo "[ui] ABORT: PUBLIC_TUNNEL=1 needs CASTLERAG_UI_BASIC_AUTH=user:pass"
    echo "[ui]        (refusing to expose the live backend with no auth)."
    exit 2
fi
CFBIN="${CLOUDFLARED:-${HOME}/cloudflared}"
if [ ! -x "${CFBIN}" ]; then
    echo "[ui] ABORT: cloudflared not found/executable at ${CFBIN} (set CLOUDFLARED=...)."
    exit 2
fi

# UI in the background so cloudflared can run alongside it.
castlerag ui --host 0.0.0.0 --port "${UI_PORT}" --require-live --config "${CONF}" &
UI_PID=$!
trap 'kill $EMB_PID $GEN_PID $QPID $UI_PID ${CF_PID:-} 2>/dev/null; qdrant_unlock' EXIT

# Readiness check sends the basic-auth creds (every route is gated).
wait_ui_ready || exit 1

# --protocol http2: compute nodes firewall QUIC/UDP-7844; TCP/443 reaches the edge.
CF_LOG="logs/ui_cloudflared_${SLURM_JOB_ID}.log"
"${CFBIN}" tunnel --no-autoupdate --protocol http2 \
    --url "http://localhost:${UI_PORT}" > "${CF_LOG}" 2>&1 &
CF_PID=$!
PUBURL=""
for i in $(seq 1 45); do
    PUBURL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${CF_LOG}" 2>/dev/null | head -1 || true)
    [ -n "${PUBURL}" ] && break
    kill -0 "$CF_PID" 2>/dev/null || { echo "[ui] cloudflared exited early; log:"; tail -20 "${CF_LOG}"; break; }
    sleep 2
done

cat <<EOF

[ui] ============================================================
[ui]  PUBLIC DEMO URL : ${PUBURL:-<not ready yet — see ${CF_LOG}>}
[ui]  basic-auth user : ${CASTLERAG_UI_BASIC_AUTH%%:*}  (share the password out-of-band)
[ui]  Public for the life of this job — scancel ${SLURM_JOB_ID} to tear it down.
[ui]  Quick tunnels have no uptime guarantee and the URL changes each run.
[ui] ============================================================

EOF

wait "$UI_PID"
