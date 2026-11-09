# Demo: exposing the live CastleRAG UI

`scripts/slurm/ui_live.slurm` boots the full backend (OmniEmbed `:8200`,
Qwen3-VL `:8201`, Qdrant) against the **existing** persisted index and serves the
Dash dashboard with the live `RagEngine`. It is non-destructive (never
preprocesses / embeds / indexes / creates collections, and aborts if the
collection looks emptied).

It has four exposure modes, selected by env vars at submit time:

| Mode | Trigger | Who can reach it | Auth |
|------|---------|------------------|------|
| **SSH tunnel** (default) | no var set | anyone with a Snellius account | SSH |
| **Quick tunnel** | `PUBLIC_TUNNEL=1` | anyone with the link | HTTP basic auth (required) |
| **ngrok static domain** | `NGROK_DOMAIN=…` | anyone with the link | HTTP basic auth (required) |
| **Named tunnel** | `NAMED_TUNNEL_TOKEN=…` | your email allowlist | Cloudflare Access |

If more than one is set, the named tunnel wins, then ngrok, then the quick tunnel.

All modes run `castlerag ui --require-live`, so the job fails loudly with the
exact missing dependency rather than silently serving the offline placeholder.

> **Why `--protocol http2`?** Snellius compute nodes firewall QUIC/UDP-7844
> (cloudflared's default), so the tunnel registers but the data path times out
> (HTTP 530). TCP/443 reaches the edge, so we force `--protocol http2`. Verified
> on `gpu_a100`: QUIC → 530, http2 → HTTP 200 end-to-end. This is baked into the
> script; nothing to set.

---

## SSH tunnel (default — for developers)

The commands below use `--account=gisr109364`. The account is per user, so
run `accinfo` on Snellius and use the one it shows for you.

```bash
sbatch --account=gisr109364 scripts/slurm/ui_live.slurm
# NODE is printed in logs/castle-ui-live_<jobid>.out, then from your laptop:
ssh -L 8050:<NODE>:8050 <user>@snellius.surf.nl
# open http://localhost:8050  (top-bar chip should read "live RAG")
```

Only works for people with a Snellius account. Not for external demo attendees.

---

## Named tunnel (recommended for a scheduled demo)

Stable, pre-shareable URL on your domain + Cloudflare Access (email allowlist).
No shared password. Requires a Cloudflare account with a domain (zone).

### One-time setup (Cloudflare Zero Trust dashboard)

1. **Networks → Tunnels → Create a tunnel** → type **Cloudflared** → name it
   (e.g. `castle-demo`) → **copy the connector token** (the long `eyJ…` string).
   No `cloudflared login` / cert needed on the node — the token is enough.
2. On that tunnel, **add a Public Hostname**:
   - Subdomain/domain: e.g. `castle-demo.<yourdomain>`
   - Service: **HTTP** → **`localhost:8050`**
3. **Access → Applications → Add → Self-hosted**, hostname
   `castle-demo.<yourdomain>`, then a policy: **Allow → Emails / Emails ending
   in** → your attendees' addresses.

### Run it (demo day)

```bash
sbatch --account=gisr109364 \
  --export=ALL,NAMED_TUNNEL_TOKEN=eyJ...<your token>... \
  scripts/slurm/ui_live.slurm
```

The connector comes up and your **stable URL** `castle-demo.<yourdomain>` serves
the live UI. Attendees load it → Cloudflare Access prompts for their email →
only allowlisted ones get in. `scancel <jobid>` to stop; the hostname stays
reserved for next time.

- The **token is a secret** — pass it via `--export` at submit time (as above)
  or a file the job reads; never commit it.
- Basic auth is **optional** in named mode (Access already gates at the edge).
  Set `CASTLERAG_UI_BASIC_AUTH=user:pass` too only if you want defense-in-depth.

---

## ngrok static domain (same URL every run, no own domain needed)

ngrok's free plan includes one static domain, something like
`<name>.ngrok-free.app`. The job serves the UI on it, so the link in the
questionnaire never has to change. Free-plan visitors see ngrok's warning page
once per browser and click **Visit Site** to continue.

### One-time setup

1. Sign up at ngrok.com. Under **Universal Gateway → Domains**, claim the free
   static domain.
2. On a Snellius login node, install the agent and store the authtoken (from
   **Getting Started → Your Authtoken**) in its own config file:

   ```bash
   curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar -xz -C ~ ngrok
   ~/ngrok config add-authtoken <your authtoken>
   ```

   The token lives in `~/.config/ngrok/ngrok.yml`; never commit it. Set
   `NGROK=/path/to/ngrok` at submit time if the binary is elsewhere.

### Run it

```bash
sbatch --account=gisr109364 --time=12:00:00 \
  --export=ALL,NGROK_DOMAIN=<name>.ngrok-free.app,CASTLERAG_UI_BASIC_AUTH="$(cat ~/.castlerag_ui_auth)" \
  scripts/slurm/ui_live.slurm
```

`--time` overrides the script's 3-hour default; the job costs about 256 SBU per
hour. Like the quick tunnel, it refuses to start without
`CASTLERAG_UI_BASIC_AUTH`. The agent log goes to `logs/ui_ngrok_<jobid>.log`.

---

## Quick tunnel (fallback — no Cloudflare account needed)

Ephemeral `https://<random>.trycloudflare.com` URL, gated by HTTP basic auth.
The URL **rotates every run** and has no uptime guarantee, so share it at the
start of the demo and tear down after.

```bash
sbatch --account=gisr109364 \
  --export=ALL,PUBLIC_TUNNEL=1,CASTLERAG_UI_BASIC_AUTH=demo:<password> \
  scripts/slurm/ui_live.slurm
# public URL prints in logs/castle-ui-live_<jobid>.out
```

The job **refuses to open the tunnel without `CASTLERAG_UI_BASIC_AUTH`** — the
app gates every request, so the live GPU backend is never exposed unauthenticated.

---

## User-study interaction log (opt-in)

For a user-study session, set `CASTLERAG_STUDY_LOG` to a file path and the
dashboard appends one JSON line per interaction to it. Each browser tab then
shows a quiet **Session code: K7F2QX** badge in the top bar. Participants copy
it into the Google Form, and that code is the only link between a form
response and the log. A reload keeps the code; a new tab or private window
gets a new one. Unset (the default), nothing is written and no code is shown.

```bash
read -rs -p "study password: " PW; echo
CASTLERAG_UI_BASIC_AUTH="study:${PW}" sbatch --account=gisr109364 \
  --export=ALL,PUBLIC_TUNNEL=1,CASTLERAG_STUDY_LOG=/projects/prjs2298/user_study/logs/session_$(date +%F).jsonl \
  scripts/slurm/ui_live.slurm
unset PW
```

The password is read without echo and handed to `sbatch` through its
environment (`--export=ALL` passes it on), so it never appears in shell
history or in the `sbatch` command line that other users on the login node
can see with `ps`.

Each line has `ts` (UTC, milliseconds), `session`, `event` and
event-specific fields (`page_load` carries `new_session`, false on a reload). Events: `page_load`, `ask`, `answer`, `select_moment`,
`verdict`, `submit_reviews`, `refine_send`, `clear` and `export`. Question and
refined-query text are logged; justification text is not (only its length).
IP addresses, user agents and the basic-auth user are never logged, and
plays inside the YouTube embeds can't be seen. The parent directory is created
if needed and the file follows the job's `umask 0007`, so the group can read it.

**The consent text must say that interactions in the interface, including
the questions typed, are logged under the session code.**

`python scripts/study_log_summary.py <log.jsonl>` prints per-session counts
(asks, answers, mean latency, verdicts, refine sends).

---

## Pre-flight checklist

- [ ] Confirm SURF/Snellius acceptable-use policy permits a public tunnel.
- [ ] `~/cloudflared` present (`curl -L .../cloudflared-linux-amd64 -o ~/cloudflared && chmod +x ~/cloudflared`), or set `CLOUDFLARED=<path>`.
- [ ] Existing index intact (`castle_multimodal_v1`, ≥25k points) — the job aborts otherwise.
- [ ] **Dry-run the full chain once before demo day** from an off-network machine.
- [ ] Bump `#SBATCH --time` to cover the demo window + buffer; submit early (GPU queue).
