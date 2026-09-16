# NemoClaw Server Setup

Step-by-step guide for deploying an NVIDIA NemoClaw gateway on a VPS (or DGX / GPU host) and connecting it to ibl.ai as a chat runner.

Reference: [NemoClaw Quickstart (NVIDIA Docs)](https://docs.nvidia.com/nemoclaw/latest/get-started/quickstart.html).

---

## How NemoClaw differs from OpenClaw

NemoClaw is NVIDIA's turnkey distribution of OpenClaw. A vanilla OpenClaw install puts the gateway directly on the host; NemoClaw wraps it in a hardened **OpenShell sandbox** (container) with an NVIDIA inference plugin pre-installed.

Practical consequences for the setup:

- The gateway runs **inside** the sandbox, not directly on the host. An `openshell` port-forward exposes it to the host's network namespace.
- You operate three CLIs: `nemoclaw` (orchestrator), `openshell` (sandbox + forwards), `openclaw` (inside the sandbox, reached via `nemoclaw <sandbox> connect` interactively, or `nemoclaw <sandbox> exec --no-tty -- <cmd>` for a single scripted command).
- By default the onboarding wizard binds the host-side forward to `127.0.0.1:18789`, which is fine for Caddy on the same host. But the Control UI origin allowlist is baked at onboard time, so the hostname you plan to serve from must be known before `nemoclaw onboard` runs.
- Hardware requirements are higher than OpenClaw: **8 GB RAM minimum, 16 GB recommended; 20 GB disk minimum, 40 GB recommended; 4+ vCPU.**

If you already know OpenClaw, read this guide in conjunction with [OpenClaw Server Setup](server-setup.md). Firewall, Caddy reverse-proxy, device-identity, and ibl.ai platform integration work identically.

> [!NOTE]
> **No root, outbound only through a forward proxy, or inbound only through an existing TLS endpoint?** This guide assumes a public VPS with root. Use [NemoClaw on a Restricted Host](nemoclaw-restricted-host.md) instead.

---

## Architecture

```
Student (browser) → ibl.ai Platform (Django Channels / ASGI)
                         │
                         ▼
                    ClawLLMRunner
                         │
                         ▼
                    OpenClawClient (WSS + Ed25519 device identity signing)
                         │
                         ▼
                    Caddy (on host, TLS via Let's Encrypt)
                         │ reverse proxy to 127.0.0.1:18789
                         ▼
                    openshell forward (host ↔ sandbox)
                         │
                         ▼
                    OpenClaw Gateway (inside OpenShell sandbox)
                         │
                         ▼
                    NVIDIA NemoClaw plugin
                         │
                         ▼
                    LLM Provider (NVIDIA NIM, Anthropic, OpenAI, etc.)
```

**Why Caddy on the host (not Docker):** same reason as OpenClaw. Caddy must connect from `127.0.0.1` so loopback auto-approval for device identity works. The openshell forward already crosses the sandbox boundary; adding another container around Caddy breaks the loopback guarantee.

**Why device identity signing:** identical to OpenClaw. Without Ed25519 signing on the WebSocket handshake the gateway grants zero scopes and config push fails with `missing scope: operator.read`. See [OpenClaw Part 5.2](server-setup.md#52-generate-and-store-device-keypair).

---

## Prerequisites

1. **A VPS or GPU host**: at least 4 vCPU / 8 GB RAM / 20 GB disk; 16 GB RAM + 40 GB disk recommended. A GPU is not required for NemoClaw itself (only for local inference via NVIDIA NIM); any Linux host with Docker will do.
2. **A domain or subdomain** pointing to the server's actual IP. In the examples below we use `domain.example.com`.
3. **Anthropic API key** (or another LLM provider key: NVIDIA NIM API key, OpenAI, etc.).
4. **Ports 80 and 443 open** on the cloud firewall **before** installing Caddy. See [OpenClaw Part 3](server-setup.md#part-3-firewall) for the rate-limit / ACME pitfalls.
5. **Docker** (or a compatible runtime: Colima / Docker Desktop on macOS, WSL2 on Windows). On Ubuntu:

   ```bash
   apt-get update && apt-get install -y docker.io
   systemctl enable --now docker
   ```

6. **Node.js 22.16+** and **npm 10+**. The NemoClaw installer will install Node.js automatically if missing, but you can pre-install:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt-get install -y nodejs
   node --version  # must be v22.16 or later
   ```

### Critical: set `CHAT_UI_URL` before onboarding

NemoClaw bakes its Control UI **origin allowlist** into the sandbox image when `nemoclaw onboard` runs. The default allowlist is `http://127.0.0.1:18789` only. A browser that opens the dashboard as `https://domain.example.com` will be rejected unless that origin is in the allowlist.

Fixing this after the fact requires either recreating the sandbox or running `openclaw config set gateway.controlUi.allowedOrigins ...` inside it (see [Part 4](#part-4-hostname-access-configuration)). Save yourself the recreate. Export `CHAT_UI_URL` before running the installer:

```bash
export CHAT_UI_URL="https://domain.example.com"
```

---

## Part 1: Install NemoClaw

### 1.1 SSH in and set `CHAT_UI_URL`

```bash
ssh root@<server-ip>

# Set BEFORE onboarding so the allowlist is baked correctly
export CHAT_UI_URL="https://domain.example.com"
echo "export CHAT_UI_URL=$CHAT_UI_URL" >> ~/.bashrc
```

### 1.2 Run the NemoClaw installer

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

This installs Node.js (if missing), the `nemoclaw` CLI, the `openshell` CLI, and the sandbox image, then launches the guided onboarding wizard. After it completes, reload the shell:

```bash
source ~/.bashrc
nemoclaw --version
openshell --version
```

### 1.3 Complete onboarding

If the installer already ran the wizard, skip this. Otherwise:

```bash
nemoclaw onboard
```

The wizard prompts for:

- **Sandbox name**: used as `<sandbox-name>` in later commands. Pick something stable, e.g. `simon`.
- **Inference provider**: select Anthropic, NVIDIA NIM, or another provider.
- **API key** for that provider.
- **Security policy**: accept the default `standard` unless you have a specific reason otherwise.

On completion it prints the sandbox name, primary model, and gateway port (default `18789`). Record these. You need the sandbox name for every `openshell` command below.

### 1.4 Generate a gateway token

The token that the ibl.ai platform will use to authenticate comes from the sandbox's OpenClaw config. Read it directly on the host with the purpose-built command:

```bash
nemoclaw <sandbox-name> gateway-token --quiet
```

The `--quiet` flag prints only the token. Omit it to see the surrounding context. This host command is faster and more reliable than dropping into the sandbox, where the in-sandbox exec can be slow.

If the wizard didn't generate one, re-run onboarding. `nemoclaw <sandbox-name> rebuild --yes` picks fresh auth settings.

**Save this token.** You need it when connecting to the ibl.ai platform and when opening the Control UI in a browser.

### 1.5 Verify the sandbox is running

```bash
nemoclaw <sandbox-name> status
openshell forward list
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Expected: 200
```

If the forward list does not show `18789 → sandbox:18789`, start it manually:

```bash
openshell forward start --background 127.0.0.1:18789 <sandbox-name>
```

### 1.6 Persistence across reboots

The NemoClaw installer wires up a systemd service for the sandbox, but the openshell port forward is **not** automatically restored if the sandbox is recreated. Add a systemd unit that re-creates the forward on boot:

```bash
cat > /etc/systemd/system/nemoclaw-forward.service << 'EOF'
[Unit]
Description=NemoClaw openshell port forward
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=root
ExecStart=/usr/local/bin/openshell forward start --background 127.0.0.1:18789 <sandbox-name>
ExecStop=/usr/local/bin/openshell forward stop 18789 <sandbox-name>

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nemoclaw-forward.service
```

Replace `<sandbox-name>` with your actual sandbox name. Verify with `systemctl status nemoclaw-forward`.

---

## Part 2: Install Caddy (Reverse Proxy + TLS)

Caddy runs directly on the host (not in a container) and proxies to the openshell forward at `127.0.0.1:18789`.

### 2.1 Install Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

### 2.2 Configure Caddyfile

```bash
cat > /etc/caddy/Caddyfile << 'EOF'
domain.example.com {
    handle /api/status {
        rewrite * /
        reverse_proxy localhost:18789
    }
    reverse_proxy localhost:18789
}
EOF

systemctl restart caddy
systemctl status caddy
```

Replace `domain.example.com` with your actual hostname.

The `/api/status` rewrite shim maps the ibl.ai platform's health-check path to `/` (the OpenClaw Control UI page), which returns 200 when the gateway is up. NemoClaw does not expose a `/api/status` endpoint. This shim maintains compatibility with the platform's connectivity checks.

After restart, Caddy will automatically obtain a Let's Encrypt TLS certificate. If it fails:

```bash
journalctl -u caddy --no-pager -n 50
```

See [OpenClaw Part 2](server-setup.md#part-2-install-caddy-reverse-proxy--tls) for the common ACME pitfalls (DNS mismatch, rate limits, firewall).

---

## Part 3: Firewall

Identical to OpenClaw. See [OpenClaw Part 3](server-setup.md#part-3-firewall). Summary:

| Direction | Protocol | Port | Source                   | Purpose        |
| --------- | -------- | ---- | ------------------------ | -------------- |
| Inbound   | TCP      | 22   | Management IPs           | SSH            |
| Inbound   | TCP      | 80   | `0.0.0.0/0`              | ACME challenge |
| Inbound   | TCP      | 443  | `0.0.0.0/0` or allowlist | HTTPS          |
| Local     | TCP      | 8080 | `172.18.0.0/16` → `172.18.0.1` | openshell gateway (sandbox bridge → host) |

Port `18789` should **not** be exposed on the cloud firewall. All external traffic goes through Caddy on 443.

**NemoClaw-only host rule (UFW):** the openshell gateway needs the sandbox's Docker
bridge subnet to reach the host bridge gateway on port 8080, or the sandbox can't
talk to the gateway:

```bash
ufw allow from 172.18.0.0/16 to 172.18.0.1 port 8080 proto tcp
```

`172.18.0.0/16` is the default openshell Docker bridge; adjust if your host's bridge
subnet differs (check with `docker network inspect`). `install.sh` adds this rule
automatically for the NemoClaw path.

---

## Part 4: Hostname Access Configuration

By default the NemoClaw gateway only accepts browser origins of `http://127.0.0.1:18789`. Opening the Control UI at `https://domain.example.com` produces:

> `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)`

The fix is to set `CHAT_UI_URL` **before** running `nemoclaw onboard`. The installer bakes that origin into the sandbox's `gateway.controlUi.allowedOrigins` at image-build time. Setting `CHAT_UI_URL` after onboarding has no effect on the live sandbox.

### Setting `CHAT_UI_URL` before onboarding

Export the variable, then run the installer or onboard command. On a fresh install this should already be done. See [Step 1.1](#11-ssh-in-and-set-chat_ui_url).

```bash
export CHAT_UI_URL="https://domain.example.com"
echo "export CHAT_UI_URL=$CHAT_UI_URL" >> ~/.bashrc   # survive new SSH sessions

# Fresh install:
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

# Or, if nemoclaw is already installed but no sandbox has been onboarded yet:
nemoclaw onboard
```

Verify after onboarding:

```bash
nemoclaw <sandbox-name> connect
openclaw config get gateway.controlUi.allowedOrigins
# Should include https://domain.example.com
exit
```

### If you've already onboarded without `CHAT_UI_URL`

Rebuild the sandbox with the variable set. `nemoclaw <sandbox-name> rebuild` preserves state but re-runs the parts of onboarding that bake into the image:

```bash
export CHAT_UI_URL="https://domain.example.com"
echo "export CHAT_UI_URL=$CHAT_UI_URL" >> ~/.bashrc
nemoclaw <sandbox-name> rebuild --yes
```

After the rebuild completes, verify the allowlist as above.

### Entering the sandbox for diagnostics

There are two ways to run `openclaw` commands against the running sandbox:

```bash
# Interactive shell (openclaw, openclaw config get, etc. are on PATH):
nemoclaw <sandbox-name> connect

# Single scripted command (non-interactive -- use this for automation):
nemoclaw <sandbox-name> exec --no-tty -- openclaw devices list
nemoclaw <sandbox-name> exec --no-tty -- openclaw config get gateway.controlUi.allowedOrigins
```

There is no `openshell exec <sandbox> -- <cmd>` form; use the `nemoclaw <sandbox> exec` form above.
`/sandbox/.openclaw/openclaw.json` is root-owned and read-only by design, so do not try to edit it directly; always flow config through `CHAT_UI_URL` and `nemoclaw onboard` / `rebuild`.

---

## Part 5: Validate

### 5.1 Health check

```bash
# From the host (hits the openshell forward → sandbox gateway)
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Expected: 200

# Through Caddy + TLS
curl -s -o /dev/null -w "%{http_code}" https://domain.example.com/api/status
# Expected: 200
```

> [!TIP]
> **Getting a 502 through Caddy, or the host check isn't 200?** The gateway forward port is not always
> `18789`. Onboarding picks the next free port (often `18790`) if `18789` is taken, so the Caddyfile's
> `reverse_proxy` target can point at a port nothing is listening on. Confirm the live port with
> `nemoclaw <sandbox-name> dashboard-url` and make the `reverse_proxy` target in your Caddyfile match it,
> then `systemctl reload caddy`.

### 5.2 Control UI and first-admin pairing

Open `https://domain.example.com/?token=<gateway-token>` in a browser. Through Caddy this first access shows **"pairing required"**. Reverse-proxied connections are not auto-approved.

> [!IMPORTANT]
> A connection arriving through Caddy (the public domain) is reverse-proxied, not loopback, so the gateway
> does not auto-approve it, hence **"pairing required"**. Approve the pending request either way:
>
> - **CLI (simplest):** `nemoclaw <sandbox-name> exec --no-tty -- openclaw devices approve <requestId>`.
>   Run `nemoclaw <sandbox-name> exec --no-tty -- openclaw devices list` first to read the request id.
> - **Loopback dashboard (GUI):** open the dashboard from a `127.0.0.1` origin (below) and approve with a
>   click. Loopback browser connections are auto-approved.

If you prefer the dashboard, the browser origin must be `127.0.0.1`, not the public domain, so tunnel the
sandbox's internal dashboard port:

```bash
# Get the exact loopback dashboard URL (it embeds the token and the real port):
nemoclaw <sandbox-name> dashboard-url
# e.g. http://127.0.0.1:18789/?token=...   The port matches your gateway forward:
# 18789 by default, or whatever onboarding chose if 18789 was already taken.

# From your machine, tunnel that same port to localhost (substitute <dashboard-port>):
ssh -L <dashboard-port>:127.0.0.1:<dashboard-port> root@<server-ip>
# then open in your browser (note 127.0.0.1, NOT the public domain):
#   http://127.0.0.1:<dashboard-port>/?token=<gateway-token>
```

In the dashboard, find the pending device request and approve it with a click. Confirm it actually took:
reload the dashboard (the device moves to **Paired**), or watch the gateway log for a successful connect
rather than another `pairing required` / `token_mismatch`. The approval is not done until a real
connection authenticates. Once one admin device is approved, later pairings can be approved normally. This
same loopback-dashboard step is how you approve the **ibl.ai platform's** device in
[Part 6](#part-6-connect-to-iblai).

### 5.3 Chat test

In the Control UI, send a test message. You should get a streaming response from the configured model.

**Full stack confirmed:** Browser → Caddy (TLS) → openshell forward → OpenClaw gateway (inside sandbox) → NemoClaw plugin → inference provider.

---

## Part 6: Connect to ibl.ai

The platform-side integration is identical for NemoClaw and OpenClaw. The gateway protocol is the same. Follow:

- [OpenClaw Part 5.1: Register claw instance](server-setup.md#51-register-claw-instance)
- [OpenClaw Part 5.2: Generate and store device keypair](server-setup.md#52-generate-and-store-device-keypair)
- [OpenClaw Part 5.3: Push config](server-setup.md#53-push-config)
- [OpenClaw Part 5.4: Test chat through the platform](server-setup.md#54-test-chat-through-the-platform)

One gotcha: when the ibl.ai backend pushes config via the gateway, the changes are applied to the OpenClaw instance **inside the sandbox**. To inspect the effective config, drop in with `nemoclaw <sandbox-name> connect` and run `openclaw config get`. The `~/.openclaw/openclaw.json` on the host is not the live config.

Two NemoClaw-specific differences from the OpenClaw flow:

- **The platform device is approved once, by hand.** The platform connects as a `gateway-client`/`backend`
  device, which NemoClaw's auto-pair watcher does not auto-approve (it covers only browser, CLI, and Control
  UI clients). After the platform's first config push mints a pending request, approve it via the CLI:
  `nemoclaw <sandbox> exec --no-tty -- openclaw devices approve <requestId>` (run the `devices list` form
  first to read the id). The loopback dashboard ([Step 5.2](#52-control-ui-and-first-admin-pairing)) is an
  optional GUI alternative. One approval covers all mentors on the instance, since pairing is keyed on the device.
- **The gateway token regenerates on every rebuild.** `nemoclaw <sandbox> rebuild` / recreate mints a fresh
  `gateway.auth.token`. The token stored in the ibl.ai instance's `gateway_token` no longer matches, so
  every connect fails with a token-mismatch handshake error until you re-read the new token
  (`nemoclaw <sandbox> gateway-token --quiet`) and update the instance via
  the platform API. This is separate from, and in addition to, re-pairing the device.

---

## Multi-Agent Setup (Optional)

To run multiple agents on one NemoClaw sandbox (e.g. tutor, course-creator, admissions), add them with
`openclaw agents add` inside the sandbox. Use the scriptable `exec` form, or do it interactively via
`connect`:

```bash
nemoclaw <sandbox-name> exec --no-tty -- openclaw agents add tutor-agent
nemoclaw <sandbox-name> exec --no-tty -- openclaw agents add course-creator-agent
# or interactively:
#   nemoclaw <sandbox-name> connect
#   openclaw agents add tutor-agent
```

> [!NOTE]
> **You don't need this for mentors.** When the platform pushes a mentor's config it creates the target
> worker agent automatically (ensure-on-push), so binding a mentor to a non-default agent name needs no
> host-side step. Use `openclaw agents add` only to pre-create standalone agents you manage by hand.

Each agent gets its own workspace and agent directory inside the sandbox, and appears in `agents.list`.
More agents means more concurrent LLM calls; consider model fallbacks if you run several.

---

## Optional: ibl.ai extensions plugin (per-agent skills)

The `iblai-openclaw-extensions` plugin adds per-agent skill upload and removal RPCs that the platform uses when it pushes skills. It is optional. Without it, skills still push, but they install worker-wide through the gateway's native upload, and a skill that is later unassigned can only be disabled, not removed. With the plugin, each agent gets its own isolated skill set and unassigned skills are removed cleanly.

On NemoClaw the gateway runs inside an isolated sandbox, so installing the plugin means getting the built plugin into the sandbox and registering it with the in-sandbox OpenClaw. Two methods follow. **Option A (runtime install)** is verified end to end on a live worker: it produces a tracked install and never re-provisions the gateway (no token regeneration), so it is the recommended path. **Option B (bake into a custom image)** is NVIDIA's documented path, but on the version tested here it did not reliably bring the gateway up (see the caveat under Option B).

First build the plugin bundle (both methods need it). It ships TypeScript source:

```bash
git clone https://github.com/iblai/iblai-openclaw-extensions-plugin.git iblai-openclaw-extensions
cd iblai-openclaw-extensions && npm install -g pnpm && pnpm install && pnpm build && cd ..
```

You now have `./iblai-openclaw-extensions/` (built, with `dist/index.mjs`).

### Option A: install at runtime (verified end to end)

Copy the **whole** plugin into the running sandbox and install it from inside. Copy the full plugin (`dist/`, `package.json`, `openclaw.plugin.json`), not just `dist`, or OpenClaw cannot classify it and the install fails with `HOOK.md missing`. First remove `node_modules` from the clone: it is not needed at runtime (the plugin runs from the bundled `dist/index.mjs`) and can carry a self-referential symlink that the sandbox state-backup audit rejects. The removal path is anchored to the clone directory, so it cannot affect anything else even if you run it from the wrong place:

```bash
SB=<sandbox-name>
CT=$(docker ps --format '{{.Names}}' | grep "openshell-$SB" | head -1)

# Anchored to the clone path on purpose: this can only ever delete
# iblai-openclaw-extensions/node_modules, never a node_modules elsewhere.
rm -rf ./iblai-openclaw-extensions/node_modules

docker exec "$CT" rm -rf /tmp/iblai-openclaw-extensions          # idempotent re-runs
docker cp ./iblai-openclaw-extensions "$CT":/tmp/iblai-openclaw-extensions
docker exec "$CT" chmod -R a+rX /tmp/iblai-openclaw-extensions
nemoclaw "$SB" exec --no-tty -- openclaw plugins install /tmp/iblai-openclaw-extensions
nemoclaw "$SB" exec --no-tty -- openclaw plugins enable iblai-openclaw-extensions
nemoclaw "$SB" restart
```

Verify it loaded:

```bash
nemoclaw "$SB" exec --no-tty -- openclaw plugins inspect iblai-openclaw-extensions
# Status: loaded   (with a recorded install path, so it is tracked)
```

This installs the plugin as a tracked extension. The `restart` reloads the gateway to pick up the plugin, but the gateway token and config are untouched (no re-provision), so there is no "Missing config" risk and no token to re-sync.

### Option B: bake into a custom image (NVIDIA's documented path)

NVIDIA documents baking the plugin into a custom sandbox image and onboarding from it. Put a Dockerfile next to the built plugin directory:

```dockerfile
# ./Dockerfile  (build context = this directory, which holds iblai-openclaw-extensions/)
FROM ghcr.io/nvidia/nemoclaw/sandbox-base:latest
COPY iblai-openclaw-extensions/ /sandbox/.openclaw/extensions/iblai-openclaw-extensions/
RUN openclaw doctor --fix
```

```bash
nemoclaw onboard --from ./Dockerfile --name <sandbox-name>
```

The Dockerfile above copies the already-built plugin into `/sandbox/.openclaw/extensions/` and runs `openclaw doctor --fix`. NVIDIA also documents a build-in-image variant (COPY the source, build it in the image, then copy the output into the same path); both are the same idea.

**Validate this carefully on your host before relying on it.** On the NemoClaw version tested here, `onboard --from` did **not** reliably bring the gateway up. The plugin loaded, but the gateway sometimes started without a config and logged `Missing config. Run openclaw setup or set gateway.mode=local`, with the onboard reporting `could not read the gateway token (download failed)`. A plain onboard on the same host is healthy, so the failure is specific to the custom-image path, and it was not consistent across attempts (a plain onboard always worked; the bake sometimes did, sometimes did not). The exact trigger was not isolated. Before trusting a `--from` sandbox, confirm **both** that `openclaw plugins inspect` shows the plugin **and** that the gateway responds (`curl` the forward port, expect `200`). If the gateway does not come up, recover with `nemoclaw <sandbox-name> destroy --yes` plus a plain onboard, then use Option A.

`nemoclaw <sandbox-name> rebuild` needs the provider credential in the environment (e.g. `export ANTHROPIC_API_KEY=...`) for its non-interactive recreate.

> [!NOTE]
> **Persistence.** Either way the plugin lives in the sandbox workspace (`~/.openclaw/extensions/`), so it survives `nemoclaw restart` and `nemoclaw rebuild`. After a `rebuild` it loads "untracked" (the rebuild resets the install record even though the files persist); re-run Option A, or pin with `plugins.allow`. A plain fresh `nemoclaw onboard` (without `--from`) does not preserve it. A `rebuild` also regenerates the gateway token (re-sync it into the ibl.ai instance, [Part 6](#part-6-connect-to-iblai)).

---

## Monitoring and Diagnostics

### Live log tailing

```bash
# Sandbox / gateway logs (WebSocket connects, chat requests, provider errors)
nemoclaw <sandbox-name> logs --follow

# Caddy logs (incoming HTTPS requests, TLS issues)
journalctl -u caddy -f

# openshell forward status
openshell forward list
```

### Quick health checks

```bash
# Gateway alive (via forward)?
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Expected: 200

# Gateway status / connected devices (run inside the sandbox)
nemoclaw <sandbox-name> connect
# then inside: `openclaw health --json` and `openclaw devices list`

# Caddy + TLS working?
curl -s -o /dev/null -w "%{http_code}" https://domain.example.com/api/status
# Expected: 200

# Disk/memory
df -h / && free -h
```

### Enter the sandbox TUI

```bash
openshell term <sandbox-name>
# or
openclaw tui          # from within the sandbox
```

---

## Keeping NemoClaw Updated

```bash
nemoclaw --version
nemoclaw update
nemoclaw <sandbox-name> restart
```

Avoid `npm update -g openclaw` directly. NemoClaw manages the OpenClaw version inside the sandbox and a mismatched manual upgrade can desync the plugin.

**Caution:** sandbox recreation **wipes paired devices**, **regenerates the gateway token**, and **resets the openshell forward**. After a major NemoClaw upgrade: re-run the systemd forward service; re-read the new gateway token and re-sync it into the ibl.ai instance's `gateway_token`; and re-approve the platform device (CLI `openclaw devices approve`, or the loopback dashboard, [Step 5.2](#52-control-ui-and-first-admin-pairing)). See [OpenClaw Device Re-Pairing](server-setup.md#device-re-pairing-after-gateway-restarts--updates) for the device-identity background.

> [!NOTE]
> The OpenClaw version inside the sandbox is **pinned by the NemoClaw release** (NemoClaw ships matched
> compatibility patches for a specific OpenClaw version). You cannot bump OpenClaw independently with
> `npm update -g openclaw`; track the OpenClaw version NemoClaw provides via `nemoclaw update`.

---

## Snags Reference

| #   | Issue                                                                                                            | Root cause                                                                                                                                      | Fix                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)` | `CHAT_UI_URL` was not exported before `nemoclaw onboard`, so the sandbox was baked with the default allowlist `["http://127.0.0.1:18789"]` only | Export `CHAT_UI_URL` and rebuild: `nemoclaw <sandbox> rebuild --yes`. See [Part 4](#part-4-hostname-access-configuration)                                          |
| 2   | `curl http://127.0.0.1:18789/` returns connection refused                                                        | openshell forward not running (common after sandbox recreate)                                                                                   | `openshell forward start --background 127.0.0.1:18789 <sandbox-name>`                                                                                              |
| 3   | Forward is lost after reboot                                                                                     | systemd unit not installed for the forward                                                                                                      | Install `nemoclaw-forward.service`. See [Step 1.6](#16-persistence-across-reboots)                                                                              |
| 4   | Host-side `~/.openclaw/openclaw.json` edits have no effect                                                       | That file is on the host; the live config lives inside the sandbox. The sandbox config is also read-only                                        | Use `nemoclaw <sandbox> connect` and `openclaw config get` to inspect. Change origins by re-exporting `CHAT_UI_URL` and running `nemoclaw <sandbox> rebuild --yes` |
| 5   | `missing scope: operator.read` on platform config push                                                           | Same as OpenClaw: device identity signing not wired up                                                                                        | Provision the Ed25519 keypair. See [OpenClaw Part 5.2](server-setup.md#52-generate-and-store-device-keypair)                                                    |
| 6   | `NOT_PAIRED` after `nemoclaw update`                                                                             | Sandbox recreated, paired devices wiped                                                                                                         | Re-approve the platform device: `nemoclaw <sandbox> exec --no-tty -- openclaw devices approve <requestId>` (or the loopback dashboard, [Step 5.2](#52-control-ui-and-first-admin-pairing)) |
| 7   | `openclaw devices approve` returns `unknown requestId`                                                           | A device id was passed instead of the pending request id                                                                                        | Read the request id from `openclaw devices list` and pass that; the approve completes via the local-loopback fallback                                              |
| 8   | Token-mismatch / handshake failure on platform connect after a rebuild                                          | Rebuild regenerated `gateway.auth.token`; the instance's stored `gateway_token` is now stale                                                    | Re-read with `nemoclaw <sandbox> gateway-token --quiet` and update the instance's `gateway_token` via the platform API                                                    |
| 9   | Let's Encrypt ACME fails on Caddy startup                                                                        | DNS / firewall not ready                                                                                                                        | See [OpenClaw Part 3](server-setup.md#part-3-firewall)                                                                                                             |

---

Next: **[Connect to the ibl.ai Platform →](platform-integration.md)**
