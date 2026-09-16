# OpenClaw Server Setup

Step-by-step guide for deploying an OpenClaw gateway on a VPS (e.g. Hetzner Cloud) and connecting it to ibl.ai as a chat runner.

---

## Architecture

```
Student (browser) → ibl.ai Platform (Django Channels / ASGI)
                         │
                    ClawLLMRunner
                         │
                    OpenClawClient (WSS + Ed25519 device identity signing)
                         │
                    Caddy (on host, TLS via Let's Encrypt)
                         │ reverse proxy to localhost:18789
                         ▼
                    OpenClaw Gateway (systemd service, loopback only)
                         │
                    LLM Provider (Anthropic, etc.)
```

**Why Caddy on the host (not Docker):** Caddy runs directly on the host so TCP connections to OpenClaw arrive from `127.0.0.1` rather than a Docker bridge address (`172.x.x.x`). This does **not** by itself make the platform backend auto-approve: Caddy adds an `X-Forwarded-For` header with the remote client's IP, which OpenClaw treats as the real client, so the backend device is seen as remote and must be approved once (see [Device Re-Pairing](#device-re-pairing-after-gateway-restarts--updates)).

**Why device identity signing:** On vanilla OpenClaw, the gateway requires Ed25519 device identity in the WebSocket connect handshake. Without it, connections succeed but the gateway grants **zero scopes**, effectively treating the client as unauthenticated. This is the root cause of "missing scope: operator.read" failures. The platform backend signs each connect with its own Ed25519 keypair.

---

## Prerequisites

Before starting, you need:

1. **A VPS or dedicated server**: Hetzner CX22 (2 vCPU, 4 GB RAM, ~$4/mo) is sufficient. OpenClaw is lightweight; the LLM API call is the bottleneck, not local compute. Use the Ashburn location for US East proximity.
2. **A domain or subdomain** pointing to the server's **actual IP** (not an elastic IP, see [Troubleshooting](#troubleshooting)).
3. **Anthropic API key** (or another LLM provider key).
4. **Ports 80 and 443 open** on your cloud firewall **before** installing Caddy.

### Critical: DNS and firewall must be ready first

Let's Encrypt ACME challenges will fail if:
1. DNS points to an elastic IP that isn't routing to the actual server
2. Port 443 is not open on the cloud firewall (only port 80 was initially opened)

After 5 failed attempts, Let's Encrypt rate-limits the domain for 1 hour. **All three** of these must be correct before Caddy's first start:
- DNS A record → server's real IP (verify with `dig your-domain.example.com +short`)
- Port 80 open inbound from `0.0.0.0/0` (for `http-01` ACME challenge)
- Port 443 open inbound (for `tls-alpn-01` fallback and actual HTTPS traffic)

Also: don't toggle firewall rules while Caddy is retrying. Each failed attempt counts against the rate limit.

---

## Part 1: Install OpenClaw

### 1.1 SSH in and install Node.js 22

```bash
ssh root@<server-ip>

# Install Node.js 22 (skip if already installed -- check with node --version)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version  # should show v22.x.x
```

### 1.2 Install OpenClaw

```bash
npm install -g openclaw@latest
openclaw --version
```

### 1.3 Generate a gateway token

```bash
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "$OPENCLAW_GATEWAY_TOKEN"
```

**Save this token.** You need it when connecting to the ibl.ai platform.

Immediately persist it to `~/.bashrc` so CLI commands work in future SSH sessions. Running `openclaw devices list` in a new SSH session will fail with `MissingEnvVarError: Missing env var "OPENCLAW_GATEWAY_TOKEN"` if the token was only exported in the original shell:

```bash
echo "export OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" >> ~/.bashrc
```

### 1.4 Write the full config

Writing the full config upfront skips the interactive onboarding wizard entirely.

```bash
mkdir -p ~/.openclaw

cat > ~/.openclaw/openclaw.json << 'CONF'
{
  "meta": {
    "lastTouchedVersion": "<your-installed-version>"
  },
  "wizard": {
    "lastRunVersion": "<your-installed-version>",
    "lastRunCommand": "onboard",
    "lastRunMode": "local"
  },
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "api_key"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6"
      },
      "workspace": "/root/.openclaw/workspace"
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },
  "session": {
    "dmScope": "per-channel-peer"
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "controlUi": {
      "allowedOrigins": [
        "https://YOUR-DOMAIN-HERE"
      ]
    },
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "tailscale": {
      "mode": "off",
      "resetOnExit": false
    }
  }
}
CONF
```

Replace `<your-installed-version>` with the output of `openclaw --version` (e.g. `2026.3.13`). Replace `YOUR-DOMAIN-HERE` with your actual domain. Change the model in `agents.defaults.model.primary` if needed (OpenClaw normalizes date-stamped IDs to short aliases, e.g. `claude-sonnet-4-20250514` → `claude-sonnet-4-6`).

The `wizard` and `meta` fields tell OpenClaw that onboarding already ran, so `openclaw onboard` won't re-prompt. The `session.dmScope: "per-channel-peer"` is a security best practice for multi-user (each DM conversation gets its own session scope).

**Optional: model fallbacks.** To prevent hard failures when the primary LLM provider has an outage, add fallback models:

```json
"model": {
    "primary": "anthropic/claude-sonnet-4-6",
    "fallbacks": ["anthropic/claude-haiku-4-5", "openai/gpt-5"]
}
```

This is especially recommended for multi-agent setups where the probability of hitting an API error scales with the number of agents.

### 1.5 Set the Anthropic API key

```bash
export ANTHROPIC_API_KEY=<your-key>
echo "export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> ~/.bashrc
```

### 1.6 Create systemd service and start

```bash
# Create workspace directory
mkdir -p /root/.openclaw/workspace

# Enable lingering so the user service survives SSH logout
loginctl enable-linger root

# Install the gateway as a user systemd service. It detects the existing config
# ("Use existing values"), skips most prompts, and installs the unit at
# ~/.config/systemd/user/openclaw-gateway.service
openclaw onboard --install-daemon

# Supply the gateway token to the service. The config resolves the token from
# $OPENCLAW_GATEWAY_TOKEN, but a systemd *user* service does NOT inherit your
# interactive shell's environment. Without this drop-in the service starts with
# an empty token and the gateway crash-loops (SecretRefResolutionError /
# "required secrets are unavailable").
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
cat > ~/.config/systemd/user/openclaw-gateway.service.d/10-env-file.conf << 'CONF'
[Service]
EnvironmentFile=-/root/.openclaw/gateway.systemd.env
CONF
echo "OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" > ~/.openclaw/gateway.systemd.env
chmod 600 ~/.openclaw/gateway.systemd.env

systemctl --user daemon-reload
systemctl --user start openclaw-gateway
```

> **Why the env-file drop-in?** The gateway config stores the token by reference (`${OPENCLAW_GATEWAY_TOKEN}`), not as a literal. A user systemd service has its own minimal environment, so the token must be provided to the unit explicitly via `EnvironmentFile`. If you skip this, `journalctl --user -u openclaw-gateway` shows `SecretRefResolutionError: Environment variable "OPENCLAW_GATEWAY_TOKEN" is missing or empty` and the unit fails after a few restart attempts. (Verify the token reached the service: `systemctl --user show openclaw-gateway -p MainPID` is non-zero and `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/` returns `200`.)

The rest of this guide manages the gateway through that service (e.g. `systemctl --user restart openclaw-gateway`). For a one-off foreground test you can run `openclaw gateway --port 18789` directly, but that process is **not** the systemd service and dies on SSH logout.

Verify the gateway is running:

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Expected: 200
```

> **Why `loginctl enable-linger root`?** OpenClaw installs a **user-level** systemd service. Without lingering, the service dies when the last SSH session closes. The `openclaw onboard --install-daemon` wizard handles this automatically, but if you skip the wizard you must run it yourself. Verify with `loginctl show-user root 2>/dev/null | grep Linger`. It should show `Linger=yes`. See [Troubleshooting](#troubleshooting) for what happens when this is missed.

---

## Part 2: Install Caddy (Reverse Proxy + TLS)

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
your-domain.example.com {
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

The `/api/status` rewrite shim maps the platform's health check path to `/` (the OpenClaw Control UI page), which returns 200 when the gateway is up. Vanilla OpenClaw has no `/api/status` endpoint. This shim maintains compatibility with the ibl.ai platform's connectivity checks.

After restart, Caddy will automatically obtain a Let's Encrypt TLS certificate. Check the logs if it doesn't work:

```bash
journalctl -u caddy --no-pager -n 50
```

### 2.3 Control UI origin allowlist

OpenClaw's Control UI only allows connections from the gateway's own host (localhost) by default. If the Control UI shows *"origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)"*, the config needs updating.

The full config in step 1.4 already includes `controlUi.allowedOrigins` with your domain. If you wrote a minimal config instead, or need to add origins after the fact:

```bash
openclaw config set gateway.controlUi.allowedOrigins '["https://your-domain.example.com"]'
systemctl --user restart openclaw-gateway
```

---

## Part 3: Firewall

### Cloud firewall (Hetzner, AWS, etc.)

Set these rules in your cloud provider's firewall console:

| Direction | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| Inbound | TCP | 22 | Management IPs | SSH |
| Inbound | TCP | 80 | `0.0.0.0/0` | ACME challenge (Let's Encrypt) |
| Inbound | TCP | 443 | `0.0.0.0/0` or allowlist | HTTPS (Caddy → OpenClaw) |

**If restricting port 443 to specific IPs**, you must include:
- The **ibl.ai platform server's outbound IP**: find it with `curl -s ifconfig.me` from the platform server
- **Your own IP**: for Control UI browser access
- Any **VPN egress IPs** used by your team

If the cloud firewall restricts port 443 to specific IPs and a user's IP isn't in the allowlist, the browser will show `ERR_CONNECTION_TIMED_OUT`. Dev containers also won't reach the server unless connected to a VPN with an allowlisted IP.

### Host firewall (UFW)

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Both the cloud firewall (network level, outside the server) and UFW (host level) must allow traffic for it to reach Caddy.

---

## Part 4: Validate

### 4.1 Health check

```bash
curl -s -o /dev/null -w "%{http_code}" https://your-domain.example.com/api/status
# Expected: 200
```

### 4.2 Control UI

Open in browser: `https://your-domain.example.com/?token=<gateway-token>`

The first browser access through Caddy will show "pairing required". Browser devices connecting through the reverse proxy are not auto-approved. Only loopback connections are. Approve the browser device:

```bash
# On the server:
openclaw devices list
openclaw devices approve <requestId> --token "$OPENCLAW_GATEWAY_TOKEN"
```

Each browser profile generates a unique device ID. This is a one-time step per browser. Do **not** use `dangerouslyDisableDeviceAuth`. The docs call it a "severe security downgrade" and it only affects the Control UI, not programmatic WebSocket connections.

### 4.3 Chat test

In the Control UI, send a test message. You should get a response from the configured LLM.

**Full stack confirmed:** Browser → Caddy (TLS/Let's Encrypt) → OpenClaw Gateway → Anthropic API.

---

## Part 5: Connect to ibl.ai

### 5.1 Register claw instance

Register through the ibl.ai platform API. See [Platform Integration](platform-integration.md#register-your-instance) for the full API reference.

### 5.2 Generate and store device keypair

The ibl.ai platform backend needs an Ed25519 keypair for device identity signing. Without it, config push will fail with "missing scope: operator.read/write/admin".

Generate one:

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

key = Ed25519PrivateKey.generate()
pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
print(pem)
```

Store the private key in the claw instance's `connection_params`:

```json
{
  "device_identity": {
    "private_key_pem": "-----BEGIN PRIVATE KEY-----\n<base64>\n-----END PRIVATE KEY-----\n"
  }
}
```

Set this via the ibl.ai platform API (PATCH the instance's `connection_params` field) or through your admin interface.

**How it works:** `OpenClawClient.connect()` receives a `connect.challenge` from the gateway, signs it with the Ed25519 key using the `v2` payload format (`v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`), and includes the `device` object in the connect params. Only same-host loopback connections are auto-approved; the platform backend connects remotely through Caddy, so the first push mints a pending pairing request you approve once with `openclaw devices approve <requestId> --token "$OPENCLAW_GATEWAY_TOKEN"` (see [Step 5.3](#53-push-config) and [Device Re-Pairing](#device-re-pairing-after-gateway-restarts--updates)). Each connect signs fresh (no session token caching).

### 5.3 Push config

Push configuration through the ibl.ai platform API. See [Platform Integration](platform-integration.md#push-configuration-to-the-instance).

Verify in logs that the push completed without "missing scope" errors. A successful push sets `agents.files.set` (IDENTITY.md, SOUL.md), `config.get`, and `config.patch`. The gateway restarts itself after config.patch.

### 5.4 Test chat through the platform

1. Open the mentor in any ibl.ai application (Mentor AI, Skills AI, etc.)
2. Select the claw-backed mentor
3. Send a test message (e.g. "Hello, say hi in 5 words")
4. Verify:
   - "Connected." acknowledgment appears
   - Response streams in token-by-token
   - Response completes (EOS received)
   - Message persists on page refresh (chat history saved)

---

## Multi-Agent Setup (Optional)

The default config creates a single agent (`main`). To run multiple agents on the same gateway (e.g. tutor, course-creator, admissions), add them via the CLI:

```bash
openclaw agents add tutor-agent
openclaw agents add course-creator-agent
```

Each agent gets its own workspace (`~/.openclaw/workspace-<name>`) and agent directory (`~/.openclaw/agents/<name>/agent`). The agents appear in `agents.list` in `openclaw.json`. You can also add them by editing the config directly.

**Note:** More agents means more concurrent LLM API calls, which increases the chance of hitting provider rate limits or outages. Consider adding model fallbacks (see [Step 1.4](#14-write-the-full-config)) if running multiple agents.

---

## Optional: ibl.ai extensions plugin (per-agent skills)

The `iblai-openclaw-extensions` plugin adds per-agent skill upload and removal RPCs that the platform uses when it pushes skills. It is optional. Without it, skills still push, but they install worker-wide through the gateway's native upload, and a skill that is later unassigned can only be disabled, not removed. With the plugin, each agent gets its own isolated skill set and unassigned skills are removed cleanly.

Install it from the public repository:

```bash
# Clone the plugin repository. It ships TypeScript source, so you build the
# bundle (dist/index.mjs) before installing.
git clone https://github.com/iblai/iblai-openclaw-extensions-plugin.git
cd iblai-openclaw-extensions-plugin

# Build with pnpm (the repo's package manager). Install pnpm first if needed.
npm install -g pnpm
pnpm install && pnpm build

# Install and enable the plugin, then restart the gateway to load it
openclaw plugins install "$PWD"
openclaw plugins enable iblai-openclaw-extensions
systemctl --user restart openclaw-gateway
```

Verify it loaded:

```bash
openclaw plugins list
# Look for: iblai-openclaw-extensions ... enabled
```

---

## Keeping OpenClaw Updated

Check for updates periodically:

```bash
openclaw --version          # current version
openclaw update             # update to latest
```

The gateway logs a notice on startup when an update is available. After updating, restart the service:

```bash
systemctl --user restart openclaw-gateway
```

**Caution:** Some OpenClaw updates can drop the paired devices list because the update rewrites the config (a behavior reported upstream), which forces a re-pair. See [Device Re-Pairing](#device-re-pairing-after-gateway-restarts--updates). Back up `~/.openclaw/` before major version upgrades.

---

## Monitoring and Diagnostics

### Live log tailing

Run in separate SSH sessions to watch both during operation:

```bash
# Gateway logs (WebSocket connects, chat requests, Anthropic API errors)
journalctl --user -u openclaw-gateway -f

# Caddy logs (incoming HTTPS requests, TLS issues)
journalctl -u caddy -f
```

### What to look for in gateway logs

| Log pattern | Meaning |
|---|---|
| `protocol 4` (the negotiated version; older builds logged `protocol 3`) | WebSocket handshake succeeded |
| `chat.send` | Chat request sent to LLM provider |
| `error` / `ECONNREFUSED` | Anthropic API call failed (key issue, rate limit, outage) |
| `close 4008` | WebSocket proxy issue |
| `missing scope` | Device identity signing not working; check keypair config |

### Quick health checks (no restart needed)

```bash
# Gateway alive?
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Expected: 200

# Structured health status
openclaw health --json

# Connected devices
openclaw devices list

# Caddy + TLS working?
curl -s -o /dev/null -w "%{http_code}" https://your-domain.example.com/api/status
# Expected: 200

# Anthropic key still valid?
curl -s -o /dev/null -w "%{http_code}" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  https://api.anthropic.com/v1/models
# Expected: 200

# Disk/memory
df -h / && free -h
```

### Verbose logging (not recommended during live use)

```bash
openclaw config set OPENCLAW_LOG_LEVEL debug
systemctl --user restart openclaw-gateway
# Remember to set back to info after debugging:
# openclaw config set OPENCLAW_LOG_LEVEL info
```

---

## Device Re-Pairing After Gateway Restarts / Updates

### The problem

A gateway restart preserves paired devices; a restart does not wipe pairing. What can drop the paired list is an update (`npm install -g openclaw@latest`) that rewrites the config (reported upstream). When the paired list is dropped, the platform backend's device identity is no longer recognized by the gateway, and **all mentors** on that server fail with `PAIRING_REQUIRED` / `NOT_PAIRED` errors.

Users see: _"The mentor is starting up, please wait..."_ → _"The mentor is currently unavailable. Please try again later."_

This affects **all mentors** linked to the server. The device identity is per claw instance, not per mentor. One re-pairing fixes all mentors on that server.

### How to re-pair manually

1. **Trigger a connection attempt.** Send any message to any mentor linked to the affected server. This creates a pending pairing request on the gateway.

2. **SSH into the OpenClaw server** and approve:

```bash
# List devices -- look for the "Pending" section
openclaw devices list

# Approve the pending request (use the requestId, NOT the device ID)
openclaw devices approve <requestId> --token "$OPENCLAW_GATEWAY_TOKEN"
```

The `--token` flag is required. After a gateway restart the host CLI's own device can be left with only the `operator.pairing` scope, so a bare `approve` waits on a scope upgrade that never clears; passing `--token` authenticates with operator authority and approves through the local fallback.

3. **Retry the chat.** The next message should connect successfully. All mentors on this server are now fixed.

### Why loopback auto-approval doesn't work

The design intent was that Caddy (on the same host) proxies to OpenClaw at `localhost:18789`, so connections arrive from `127.0.0.1` and are auto-approved. However, Caddy adds `X-Forwarded-For` headers with the remote client's IP, and OpenClaw uses those to determine the "real" client IP. Since the platform backend connects from a remote server, OpenClaw sees a non-loopback IP and requires manual approval.

### Reducing manual re-pairing

Making pairing survive restarts and updates is a known gap. The durable fixes are upstream: persisting paired devices across restarts, or config-based trusted-device registration. On the platform side, a health check that detects `NOT_PAIRED` and alerts keeps a wiped pairing from becoming a silent outage. One reverse-proxy workaround is to have Caddy strip `X-Forwarded-For` so OpenClaw sees loopback and auto-approves, at the cost of losing the real client IP in the gateway logs.

### Device identity scope

- Device identity is per **claw instance** (stored in `connection_params.device_identity.private_key_pem`)
- All mentors linked to the same server share the same device
- One re-pairing approval covers all mentors on that server
- Each server with a different keypair needs its own pairing

---

## Troubleshooting

Issues encountered during initial deployments, collected here for quick reference.

| # | Issue | Root cause | Fix |
|---|---|---|---|
| 1 | Let's Encrypt ACME challenges fail | DNS pointed to elastic IP not routing to server; port 443 not open | Point DNS to actual server IP; open ports 80+443 before Caddy starts |
| 2 | Let's Encrypt rate limit (1 hour) | 5 failed ACME attempts from the above | Wait for cooldown; don't toggle firewall while Caddy retries |
| 3 | Control UI "origin not allowed" | OpenClaw only allows localhost origins by default | `openclaw config set gateway.controlUi.allowedOrigins '["https://..."]'` |
| 4 | Control UI "pairing required" | Browser device not auto-approved through reverse proxy | `openclaw devices approve <requestId> --token "$OPENCLAW_GATEWAY_TOKEN"` (one-time per browser) |
| 5 | Browser `ERR_CONNECTION_TIMED_OUT` | Cloud firewall restricting port 443; user IP not in allowlist | Add IP to cloud firewall allowlist |
| 6 | `OPENCLAW_GATEWAY_TOKEN` not found in new SSH sessions | Token only exported in original shell | Add `export OPENCLAW_GATEWAY_TOKEN=...` to `~/.bashrc` |
| 7 | Config push "missing scope: operator.read" | `OpenClawClient` was omitting device identity from connect handshake | Implement Ed25519 device signing (see [Part 5.2](#52-generate-and-store-device-keypair)) |
| 8 | Dev container can't reach server | Cloud firewall restricts port 443; dev IP not allowlisted | Connect via VPN with allowlisted IP, or broaden firewall rule |
| 9 | Model ID mismatch | OpenClaw normalizes `claude-sonnet-4-20250514` → `claude-sonnet-4-6` | Use short alias in agent config |
| 10 | `NOT_PAIRED` after gateway update | Update rewrote the config and dropped paired devices; Caddy forwards `X-Forwarded-For` so auto-approval doesn't work | Manual re-pair (see [Device Re-Pairing](#device-re-pairing-after-gateway-restarts--updates)) |
| 11 | Gateway dies when SSH session ends | `loginctl enable-linger root` was skipped during manual setup | Run `loginctl enable-linger root` (see [Step 1.6](#16-create-systemd-service-and-start)). Verify with `loginctl show-user root 2>/dev/null \| grep Linger` |

---

Next: **[Connect to the ibl.ai Platform →](platform-integration.md)**
