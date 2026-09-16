# NemoClaw on a Restricted Host

Step-by-step guide for deploying NemoClaw on a host you don't fully control and connecting it to ibl.ai. Use it instead of [NemoClaw Server Setup](nemoclaw-setup.md) when the host looks like this:

- **No root.** You work as an account that is in the `docker` group.
- **All outbound traffic goes through a forward proxy.** Direct internet access is blocked.
- **No public inbound of your own.** An existing TLS endpoint that you don't operate (a reverse proxy or load balancer) forwards one port to the host.
- **You can't use our `install.sh`.** It needs root and a Debian-family host.

On a host like this, NemoClaw's built-in inference paths could not reach the model provider through the proxy. The working path is a small relay on the host, described in [Part 5](#part-5-inference-through-the-host-relay). The relay works with any upstream that speaks the Anthropic Messages format and takes a bearer token; you set its URL and key as configuration. The examples use Amazon Bedrock's Anthropic-compatible (Mantle) endpoint.

> [!NOTE]
> **Versions this guide follows:** NemoClaw v0.0.109, OpenShell 0.0.101 and OpenClaw 2026.7.1, on a non-Debian Linux host with no root access and outbound traffic only through a forward proxy. The steps come from a working deployment on those versions. NemoClaw moves quickly, so record your versions ([Step 3.4](#34-record-versions)) and expect some differences on newer releases.

> [!NOTE]
> **The commands are examples, not a turnkey script.** They assume a Linux host with Docker, `curl` and GNU userland, and they name paths, ports and addresses that differ between environments. Read each step before running it, substitute your own values, and try the sequence first on a host you can rebuild. `scripts/inference-relay.cjs` is a reference implementation in the same spirit: short enough to review in full, and meant to be adapted.

---

## Contents

- [Architecture](#architecture)
- [Part 0: What to arrange before starting](#part-0-what-to-arrange-before-starting)
- [Part 1: Survey the host](#part-1-survey-the-host)
- [Part 2: Prepare the shell](#part-2-prepare-the-shell)
- [Part 3: Install NemoClaw](#part-3-install-nemoclaw)
- [Part 4: Check the data directory (optional)](#part-4-check-the-data-directory-optional)
- [Part 5: Inference through the host relay](#part-5-inference-through-the-host-relay)
- [Part 6: Install the ibl.ai extensions plugin](#part-6-install-the-iblai-extensions-plugin)
- [Part 7: Connect to ibl.ai](#part-7-connect-to-iblai)
- [Part 8: Configure the mentor](#part-8-configure-the-mentor)
- [Part 9: Turn off outbound calls you don't need](#part-9-turn-off-outbound-calls-you-dont-need)
- [Rebuild checklist](#rebuild-checklist)
- [Reboots and persistence](#reboots-and-persistence)
- [Decommissioning](#decommissioning)
- [Known constraints](#known-constraints)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
ibl.ai platform
    │  wss://<public-host>   (from the platform's egress address only)
    ▼
Existing TLS endpoint (reverse proxy / load balancer)
    │  forwards 443 → <host>:<DASHBOARD_PORT>
    ▼
OpenShell port forward (host, 0.0.0.0:<DASHBOARD_PORT>)
    │
    ▼
OpenClaw gateway (inside the OpenShell sandbox)
    │  baseUrl = http://host.openshell.internal:8000
    │  (through the sandbox's own proxy, allowed by the local-inference policy)
    ▼
inference-relay.cjs (host, listening on the sandbox bridge address :8000)
    │  HTTPS_PROXY = forward proxy
    ▼
Forward proxy  →  <upstream-url>
                  (example: https://bedrock-mantle.<aws-region>.api.aws/anthropic)
```

The platform connects **inbound** through the TLS endpoint, so the platform connection needs no outbound proxy rule. Serving chat needs one outbound host, the model provider's endpoint. The worker also refreshes a model price list and can run a scheduled agent turn of its own; [Part 9](#part-9-turn-off-outbound-calls-you-dont-need) covers both and how to switch them off.

**What leaves the host at runtime:** prompts and responses go to the model provider through the forward proxy. The relay stores nothing; its log records method, path, caller address, status and timing only. What the platform side stores is set per mentor in [Part 8](#81-create-the-mentor-and-set-its-flags).

---

## Part 0: What to arrange before starting

Settle these with whoever runs the host and its network before anyone logs in. Each missing item stops the install partway.

### 0.1 Access

- A login that can run commands as an account in the `docker` group, for example with `sudo -u <svc-account> -i`.

### 0.2 Inbound

- The TLS endpoint serves `<public-host>` and forwards 443 to one port on the host, which this guide calls `<DASHBOARD_PORT>`. Pick a port that is free on the host and isn't 8080, which the OpenShell gateway uses.
- Restrict that rule to the ibl.ai platform's egress address. Ask ibl.ai for the current address.
- The platform connects over a WebSocket (`wss://<public-host>`), so confirm the endpoint forwards the `Upgrade` header and allows a long-lived idle connection. A proxy that strips the upgrade or closes idle connections early leaves the install looking healthy while pairing and chat fail.
- Agree who restarts the host-side pieces after a reboot, or arrange the access needed to supervise them. [Reboots and persistence](#reboots-and-persistence) covers what does not come back on its own.

### 0.3 Outbound proxy allowlist

Ask for **exact hostnames**, and check how the proxy matches them. Some proxies treat a bare domain (`nvidia.com`) as that name only, so `www.nvidia.com` stays blocked until it is listed or a wildcard form is used.

**Needed during install and upgrades only.** These can be closed afterwards and reopened for the next upgrade:

| Host | Used for |
|---|---|
| `www.nvidia.com` | the NemoClaw installer script |
| `github.com` | NemoClaw source checkout, plugin clone |
| `raw.githubusercontent.com` | nvm installer, the relay script |
| `release-assets.githubusercontent.com` | OpenShell release binaries. Without it the install stops at "Installing OpenShell CLI" with a `403` |
| `nodejs.org` | Node.js runtime (via nvm) |
| `registry.npmjs.org` | npm packages in the image build and the plugin build |
| `ghcr.io`, `pkg-containers.githubusercontent.com` | sandbox base image and its layers |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudfront.docker.com` | Docker Hub images (build stages, ollama) |
| `deb.debian.org` | system packages inside the image build |
| `ollama.com`, `registry.ollama.ai` | only on the local-model route in [Part 3](#part-3-install-nemoclaw); not needed if you onboard straight at the relay |

`codeload.github.com` and `objects.githubusercontent.com` are GitHub's download hosts. Some fetches redirect there, so they are worth including in the same request.

**Needed for normal operation:**

| Host | Used for |
|---|---|
| The model provider's endpoint. Example, Bedrock's Anthropic-compatible endpoint: `bedrock-mantle.<aws-region>.api.aws` | every model request. For a regional endpoint, use the region the key and model are enabled in |

### 0.4 Credentials

- An API key for the model provider that authenticates as a **bearer token**, with access to the model you plan to use. On Bedrock that is a Bedrock API key rather than an IAM access key: the relay sends the key as a bearer token and does no request signing.

---

## Part 1: Survey the host

Log in, then switch to the service account. Every later command runs as this account.

```bash
sudo -u <svc-account> -i
id                             # must list the docker group
```

> [!TIP]
> **Paste one command per line.** Some terminals join pasted lines, which produces errors like `Unknown action: statusnemoclaw` or `Invalid --host-mount 'nemoclaw'`. Commands with `$(...)` inside `sudo -u <svc-account> -i bash -c '...'` also expand too early and print blanks. Run them after `sudo -u <svc-account> -i` instead.

### 1.1 OS, Docker and tools

```bash
cat /etc/os-release
docker info --format 'server={{.ServerVersion}} driver={{.Driver}} root={{.DockerRootDir}}'
df -h <docker-root-mount>
type -p git docker strings systemctl     # git, docker and strings are NemoClaw prerequisites; node and npm are not needed
```

NemoClaw needs 4+ vCPU and 8 GB RAM minimum. Images go under Docker's data root, so check free space there, not on `/`.

### 1.2 Find the proxy

Get the proxy address from whoever runs the network. Without proxy settings, requests from a shell time out with no explanation. If Docker on the host already pulls images through the proxy, the address is also in `/etc/docker/daemon.json`:

```bash
cat /etc/docker/daemon.json     # look for a "proxies" block
```

### 1.3 Confirm no root is needed

NemoClaw normally runs its gateway as a systemd user service. A `sudo -u ... -i` shell has no systemd user manager, and NemoClaw then falls back to running the gateway as a plain process. That fallback is only used when no OpenShell unit already exists:

```bash
systemctl --user is-system-running
# Without a user manager: Failed to connect to bus: No medium found

find /etc/systemd/user /usr/lib/systemd/user /usr/local/lib/systemd/user -name '*openshell*'
echo "SYSTEMD_UNIT_PATH=${SYSTEMD_UNIT_PATH:-unset}"
# Expected: no files, and SYSTEMD_UNIT_PATH=unset
```

### 1.4 Check the allowlist

Test every host through the proxy and read the **CONNECT** status. `%{http_code}` prints `000` for both "refused" and "unreachable", so it cannot tell you anything here.

```bash
PROXY=http://<proxy-host>:<proxy-port>
PROVIDER_HOST=<model-provider-host>     # for Bedrock: bedrock-mantle.<aws-region>.api.aws

for h in www.nvidia.com github.com raw.githubusercontent.com release-assets.githubusercontent.com \
         codeload.github.com objects.githubusercontent.com \
         nodejs.org registry.npmjs.org ghcr.io pkg-containers.githubusercontent.com \
         registry-1.docker.io auth.docker.io production.cloudfront.docker.com deb.debian.org \
         ollama.com registry.ollama.ai "$PROVIDER_HOST"; do
  printf '%-40s ' "$h"
  curl -s -o /dev/null -w '%{http_connect}\n' --max-time 10 -x "$PROXY" "https://$h"
done
```

Every host must print `200`. A non-`200` status (typically `403`) means the proxy refused that hostname. If every host prints `000`, check that the proxy itself answers with `curl -v --max-time 10 -x "$PROXY" https://github.com 2>&1 | head -8`.

Don't continue until every line is `200`.

---

## Part 2: Prepare the shell

### 2.1 Proxy variables

```bash
export HTTPS_PROXY=http://<proxy-host>:<proxy-port>
export HTTP_PROXY=$HTTPS_PROXY
export NO_PROXY=localhost,127.0.0.1,::1,172.18.0.1,inference.local,host.openshell.internal,.internal,.<internal-domain>
export no_proxy=$NO_PROXY

curl -s -o /dev/null -w 'connect=%{http_connect}\n' --max-time 10 https://www.nvidia.com
# Expected: connect=200, meaning the proxy accepted the tunnel
```

`172.18.0.1` is the usual address of the OpenShell sandbox bridge. You confirm it in [Step 5.1](#51-confirm-the-bridge-address-and-a-free-port). `inference.local` and `host.openshell.internal` are sandbox-local names that must never go to the forward proxy.

### 2.2 Proxy for image builds

Image builds do **not** see the shell's proxy variables, and a `proxies` block in the daemon config doesn't reach them either: that covers the daemon's own image pulls. The build steps that run npm and apt need a proxy block in the **client** config of the account that runs the build.

> [!IMPORTANT]
> `~/.docker/config.json` also holds registry credentials (`auths`, `credsStore`). Back it up and merge into it. Do not overwrite it.

```bash
mkdir -p ~/.docker
PROXY_URL=http://<proxy-host>:<proxy-port>

if [ -s ~/.docker/config.json ]; then
  cp -p ~/.docker/config.json ~/.docker/config.json.bak.$(date +%Y%m%d%H%M%S)
  tmp=$(mktemp)
  jq --arg p "$PROXY_URL" \
     '.proxies.default.httpProxy=$p
      | .proxies.default.httpsProxy=$p
      | .proxies.default.noProxy="localhost,127.0.0.1,.<internal-domain>"' \
     ~/.docker/config.json > "$tmp" && mv "$tmp" ~/.docker/config.json
else
  cat > ~/.docker/config.json <<EOF
{"proxies":{"default":{"httpProxy":"$PROXY_URL","httpsProxy":"$PROXY_URL","noProxy":"localhost,127.0.0.1,.<internal-domain>"}}}
EOF
fi
```

Without `jq`, edit the file by hand after taking the backup: add the `proxies` key alongside whatever is already there.

### 2.3 Telemetry off, before anything starts

OpenShell sends usage telemetry by default, and OpenClaw checks for updates. Whether those are acceptable is the host owner's call, and on a restricted host the answer is usually no. The gateway reads these variables when it starts, so set them before anything runs.

Keep them in a file of your own rather than editing a shared account's login profile:

```bash
mkdir -p ~/iblai
cat > ~/iblai/env.sh <<'EOF'
export OPENSHELL_TELEMETRY_ENABLED=false
export OPENCLAW_NO_AUTO_UPDATE=1
EOF
. ~/iblai/env.sh
```

Source it in every shell that runs `nemoclaw`, including after a reconnect. If you would rather have it automatic, add `. ~/iblai/env.sh` to whichever file the account's login shell reads (`~/.bash_profile`, `~/.profile`, `~/.zprofile`).

You verify both in [Part 9](#part-9-turn-off-outbound-calls-you-dont-need).

---

## Part 3: Install NemoClaw

Onboarding validates the inference endpoint you give it and stops if it cannot reach one, and on this kind of host it cannot validate the provider's public endpoint: that request does not go through the forward proxy. The endpoint it *can* validate is the relay from [Part 5](#part-5-inference-through-the-host-relay), running on the sandbox bridge address.

That leaves two routes:

- **Relay first, one onboard.** If you have the provider key and know the bridge address (`docker network inspect <openshell-network>`, usually `172.18.0.1`), start the relay from [Step 5.3](#53-start-the-relay) now and onboard once, straight at it, using [Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint) in place of Step 3.3.
- **Local model first, then switch.** If the key is not available yet, or the bridge does not exist because nothing has been created on this host, bring the sandbox up against a small local model and move to the relay in Part 5. This is the route the rest of Part 3 follows, and the one these steps were built on.

### 3.1 Run ollama as a container

Skip this step on the relay-first route.

NemoClaw's own `install-ollama` provider needs the `zstd` command to unpack ollama, and cannot install it without root (`ollama-linux-amd64 ships as .tar.zst but zstd is not installed and nemoclaw cannot bootstrap it without sudo`). Running ollama as a container on loopback avoids that, and NemoClaw can't tell the difference.

```bash
docker run -d --name ollama --restart unless-stopped \
  -p 127.0.0.1:11434:11434 \
  -e OLLAMA_NO_CLOUD=1 \
  -e HTTPS_PROXY=$HTTPS_PROXY -e HTTP_PROXY=$HTTP_PROXY -e NO_PROXY=localhost,127.0.0.1 \
  -v ollama:/root/.ollama ollama/ollama

docker exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull qwen2.5:0.5b
docker exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama list
curl -s http://127.0.0.1:11434/api/version
```

Always pass `-e OLLAMA_HOST=http://127.0.0.1:11434` to `ollama` CLI commands. The image sets `OLLAMA_HOST=http://0.0.0.0:11434`, an address a `NO_PROXY` list won't normally match, so the CLI sends its requests to the proxy instead of the local server. The only symptom is `Error: something went wrong, please see the ollama server logs for details`, with nothing in the server log.

`OLLAMA_NO_CLOUD=1` stops ollama's periodic calls to `ollama.com`; see [Part 9](#part-9-turn-off-outbound-calls-you-dont-need).

### 3.2 Onboarding variables

Export these in the same shell that runs the installer and onboarding:

```bash
export CHAT_UI_URL=https://<public-host>
export NEMOCLAW_SANDBOX_NAME=main
export NEMOCLAW_DASHBOARD_PORT=<DASHBOARD_PORT>
export NEMOCLAW_DASHBOARD_BIND=0.0.0.0
export NEMOCLAW_PROVIDER=ollama
export NEMOCLAW_MODEL=qwen2.5:0.5b

echo "$CHAT_UI_URL | $NEMOCLAW_SANDBOX_NAME | $NEMOCLAW_DASHBOARD_PORT | $NEMOCLAW_MODEL"
```

- **`NEMOCLAW_DASHBOARD_PORT`** is the port the TLS endpoint forwards to. The installer has no port flag, so this variable is the only way to set it. Without it, onboarding uses 18789 without prompting.
- **`NEMOCLAW_DASHBOARD_BIND=0.0.0.0`** makes onboarding listen on all interfaces, which is what lets the TLS endpoint reach it. Bound to `127.0.0.1` it is unreachable from off the host. Restrict the port at the host firewall to the TLS endpoint's address, as in [Step 0.2](#02-inbound): it carries an administrative interface, and nothing else needs to reach it.
- **`CHAT_UI_URL`** is the hostname the Control UI's browser allowlist should carry. Set it for correctness and for custom images; on a stock image the allowlist stays `http://127.0.0.1:<DASHBOARD_PORT>` either way, which makes no difference to the platform connection. See [Known constraints](#known-constraints).

If you lose the shell, re-export everything above and in [Part 2](#part-2-prepare-the-shell), and re-source `~/iblai/env.sh`.

### 3.3 Install and onboard

Fetch the vendor installer, record what you fetched, and run it from disk. Change control usually wants the hash, and piping a remote script into a shell is prohibited outright in some environments:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh -o ~/iblai/nemoclaw.sh
sha256sum ~/iblai/nemoclaw.sh        # record this with the change ticket
less ~/iblai/nemoclaw.sh             # review, or hand to whoever approves changes

NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash ~/iblai/nemoclaw.sh
```

The installer installs Node through nvm, the `nemoclaw` CLI, the OpenShell binaries, and the gateway, then starts onboarding. It installs NVIDIA's last-known-good release (`Resolved install ref: lkg`), not necessarily the newest one.

Without a systemd user manager, expect this message. It is normal:

```
OpenShell gateway managed service failed to start (systemctl --user daemon-reload failed: Failed to connect to bus: No medium found); using standalone fallback.
...
✓ Docker-driver gateway is healthy
```

If the installer's own onboarding doesn't finish, run onboarding directly:

```bash
nemoclaw onboard --non-interactive --yes --yes-i-accept-third-party-software --name main --fresh
```

Onboarding bakes the proxy's CA certificate from `/etc/ssl/certs` into the sandbox image, and raises the ollama context window to 16384 tokens. Both happen automatically.

### 3.4 Record versions

```bash
nemoclaw --version
openshell --version
nemoclaw main status
```

Save the output with your deployment notes. Most "does this version support X" questions later can only be answered from it.

### 3.5 Check the listener and the TLS endpoint

```bash
ss -ltnH "sport = :<DASHBOARD_PORT>"
# Expected: a listener on 0.0.0.0:<DASHBOARD_PORT>, not 127.0.0.1

curl -sI --noproxy '*' --max-time 8 http://<host-ip>:<DASHBOARD_PORT>/ | head -1
# Expected: HTTP/1.1 200 OK   (--noproxy is required, or the proxy intercepts it)
```

If the listener is on `127.0.0.1`, `NEMOCLAW_DASHBOARD_BIND` wasn't exported during onboarding. Replace the forward by hand. `forward service` runs in the foreground, so background it:

```bash
openshell forward stop <DASHBOARD_PORT>
nohup openshell forward service main --target-port <DASHBOARD_PORT> --local 0.0.0.0:<DASHBOARD_PORT> > ~/forward-<DASHBOARD_PORT>.log 2>&1 &
```

Then confirm that `https://<public-host>/` returns `200` from the platform's egress address. The response should carry OpenClaw's `Content-Security-Policy` header, not the TLS endpoint's own error page.

---

## Part 4: Check the data directory (optional)

Skip this part if the agent doesn't need files from the host.

A host directory can only be mounted into the sandbox **when the sandbox is created**, so decide before [Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint). If the data isn't ready yet, mount the agreed directory anyway, even empty. The mount shows the live host directory, so files appear inside the sandbox as they land.

The sandbox runs as an unprivileged uid, `998` on the versions in the note above. Confirm the uid against your sandbox, then check it can read the directory, using an image already on the host so the test pulls nothing:

```bash
nemoclaw main exec --no-tty -- id -u     # read the uid from the output, below the gateway banner
SBX_UID=998                              # set it to what that printed

ls -ln <data-dir> | head
docker run --rm --pull=never -u "$SBX_UID:$SBX_UID" --entrypoint sh -v <data-dir>:/sandbox/data:ro ollama/ollama \
  -c 'ls -l /sandbox/data | head -3 && echo READ-OK'
```

`READ-OK` means the mount will work. The check runs a real container against the real directory as the sandbox user, so it also surfaces host security policy that would block the read, whatever form that takes. Use any image already on the host, which `docker images` will list. The example names the ollama image, which is present if you took the local-model route. Files need to be readable by "other" (for example mode `644`): a file readable only by its owner and group is denied.

---

## Part 5: Inference through the host relay

### 5.1 Confirm the bridge address and a free port

```bash
# from the host, before any sandbox exists:
docker network inspect <openshell-network> --format '{{(index .IPAM.Config 0).Gateway}}'

# or, once a sandbox is running:
nemoclaw main exec --no-tty -- getent hosts host.openshell.internal
# Expected: 172.18.0.1  host.openshell.internal

ss -ltnH "sport = :8000" || echo "8000 free"
```

Use port `8000`. Onboarding's `local-inference` policy allows `host.openshell.internal:8000` for all methods and paths, which is why the relay goes there rather than on a port of your choosing. [Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint) confirms the policy is present.

If the bridge address isn't `172.18.0.1`, use the real address everywhere this guide says `172.18.0.1`. That includes `NO_PROXY` from [Step 2.1](#21-proxy-variables); [Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint) restarts the gateway so it picks up the new value.

### 5.2 Check the key through the proxy

```bash
read -rsp 'Model provider API key: ' COMPATIBLE_ANTHROPIC_API_KEY; echo
export COMPATIBLE_ANTHROPIC_API_KEY
export UPSTREAM_URL=<upstream-url>     # example: https://bedrock-mantle.<aws-region>.api.aws/anthropic
export MODEL_ID=<model-id>             # as the provider names it

curl -sS -o /dev/null -w 'http=%{http_code} connect=%{http_connect}\n' \
  -X POST "$UPSTREAM_URL/v1/messages" \
  -H "Authorization: Bearer $COMPATIBLE_ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL_ID\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
# Expected: http=200 connect=200
```

`read -rs` keeps the key out of shell history. Don't grep the environment for `compatible` or `key` later: that prints the key to the screen.

### 5.3 Start the relay

```bash
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22   # skip if node is already on PATH

mkdir -p ~/iblai
curl -fsSL https://raw.githubusercontent.com/iblai/claw-setup/main/scripts/inference-relay.cjs \
  -o ~/iblai/inference-relay.cjs
sha256sum ~/iblai/inference-relay.cjs      # record with the change ticket
less ~/iblai/inference-relay.cjs           # short enough to read before it runs with your key
node --check ~/iblai/inference-relay.cjs   # syntax only, not an integrity check
```

`main` moves as the repository changes. If your change process wants a fixed artifact, replace `main` in that URL with the commit SHA of the version you reviewed, which you can copy from the file's history on GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/iblai/claw-setup/<commit-sha>/scripts/inference-relay.cjs \
  -o ~/iblai/inference-relay.cjs
```

Then start it:

```bash
export UPSTREAM_API_KEY="$COMPATIBLE_ANTHROPIC_API_KEY"
export NODE_USE_ENV_PROXY=1
RELAY_BIND=172.18.0.1 RELAY_PORT=8000 \
  nohup node ~/iblai/inference-relay.cjs >> ~/iblai/inference-relay.log 2>&1 &
sleep 1; tail -1 ~/iblai/inference-relay.log
```

The relay reads `UPSTREAM_URL` from [Step 5.2](#52-check-the-key-through-the-proxy) and refuses to start without it. The ready line must show `"listening":"http://172.18.0.1:8000"`, your provider URL under `"upstream"`, your proxy under `"proxy"`, and `"envProxy":"1"`.

- **Why the bridge address:** the sandbox cannot reach a relay that listens on `127.0.0.1`.
- **Why `x-api-key` is stripped:** onboarding's endpoint check sends that header, and a bearer-token upstream rejects the request with `HTTP 401` when it arrives alongside the bearer token.
- **Treat the relay as a credential.** It holds the provider key and applies it to every request it accepts, and it has no authentication of its own. It listens on the Docker bridge address, which any container on that network can reach, not only the sandbox, so restrict the port at the host firewall if other containers run here. Never bind it to `0.0.0.0`.
- **What it accepts:** `POST /v1/messages` and `GET /v1/models`, the endpoints this integration uses. Anything else gets a `404` and a `blocked` line in the log naming the method and path. Another NemoClaw version or provider may call something further, so widen `ALLOWED` in the script to match what the log shows and restart the relay.
- **Rotating the key:** stop the process, confirm it is gone (`pgrep -a -u "$(id -u)" -f inference-relay`), and start it again with the new `UPSTREAM_API_KEY`. The key sits in the process environment, readable by this account and by root, so rotate it rather than editing it in place.
- **Other providers:** the relay works with any upstream that takes the Anthropic Messages format with bearer authentication. Anything else needs the relay adapted.

**Keeping it running.** The same request works as a health check: run it on a schedule and watch for `upstream_failed` in the log. The log grows unbounded, so rotate or truncate it (`: > ~/iblai/inference-relay.log`) alongside your other host logs.

Then check the sandbox can reach the relay:

```bash
nemoclaw main exec --no-tty -- curl -sS -m 30 -o /dev/null -w 'http=%{http_code}\n' \
  -X POST http://host.openshell.internal:8000/v1/messages \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL_ID\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
# Expected: http=200
```

### 5.4 Recreate the sandbox with the relay endpoint

The endpoint can only be changed by onboarding; `nemoclaw inference set` refuses to change it. A host mount also requires a new sandbox, since a container's mounts are fixed when it is created. Restart the gateway process as well: it keeps the `NO_PROXY` it started with.

Run these in order. **Destroy first, while the gateway is still running**; with the gateway stopped, destroy fails with `The OpenShell gateway is unreachable`.

```bash
nemoclaw sandbox snapshot create main     # if a sandbox already exists
nemoclaw main destroy
```

Answer `y` to delete the sandbox and **`N`** to the second prompt, which offers to delete the shared gateway too. Run it interactively and read both prompts rather than piping answers in: the prompt order is version-specific, and the second one offers to destroy the shared gateway.

Then restart the gateway from a shell with the forward proxy variables removed and the onboarding variables set:

```bash
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy

export NO_PROXY=localhost,127.0.0.1,::1,172.18.0.1,inference.local,host.openshell.internal,.internal,.<internal-domain>
export no_proxy=$NO_PROXY
export CHAT_UI_URL=https://<public-host>
export NEMOCLAW_SANDBOX_NAME=main
export NEMOCLAW_DASHBOARD_PORT=<DASHBOARD_PORT>
export NEMOCLAW_DASHBOARD_BIND=0.0.0.0
export NEMOCLAW_PROVIDER=anthropicCompatible
export NEMOCLAW_ENDPOINT_URL=http://172.18.0.1:8000
export NEMOCLAW_MODEL=$MODEL_ID
export NEMOCLAW_TRUSTED_PRIVATE_HOSTS=172.18.0.1
export NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS=172.18.0.1
# COMPATIBLE_ANTHROPIC_API_KEY and MODEL_ID carry over from Step 5.2; only the
# proxy variables are cleared, and the relay keeps the environment it started with.

pgrep -a -u "$(id -u)" -f openshell-gateway          # confirm what is about to stop
pkill -u "$(id -u)" -x openshell-gateway || pkill -u "$(id -u)" -f '/openshell-gateway'
sleep 2

NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 nemoclaw onboard --non-interactive --fresh \
  --host-mount <data-dir>:/sandbox/data
```

Drop `--host-mount` if you skipped Part 4.

Use this combination as written. The image build doesn't need the shell proxy, because it uses `~/.docker/config.json`. If you vary it, by keeping the proxy variables set here or dropping a trusted-host variable, confirm inference end to end afterwards.

Expect in the output:

```
⚠ Using an operator-trusted private inference endpoint ...
Validated Endpoints:
  - http://172.18.0.1:8000/v1/messages (anthropic_messages)
...
Creating sandbox 'main'
```

If you see `[resume] Skipping sandbox (main)`, the old sandbox was reused and still carries its old settings. Destroy it and onboard again. If you see `[reuse] Skipping gateway (running)`, the gateway was not restarted and still has its old `NO_PROXY`.

Confirm the gateway has the new values:

```bash
GW=$(pgrep -u "$(id -u)" -f openshell-gateway | head -1)
[ -n "$GW" ] && tr '\0' '\n' < "/proc/$GW/environ" | grep -i -e no_proxy -e telemetry -e auto_update
# NO_PROXY must include 172.18.0.1; OPENSHELL_TELEMETRY_ENABLED=false; OPENCLAW_NO_AUTO_UPDATE=1
```

Confirm `local-inference` is among the sandbox policies:

```bash
nemoclaw main status
# Policies: ... local-inference
```

If it is missing, add it with `nemoclaw main policy add local-inference` and answer `y`. That preset permits the sandbox to reach host-local inference addresses, including `host.openshell.internal` on the relay's port. It does not open any route to the internet.

### 5.5 Point OpenClaw at the relay

Onboarding reports "Deployment verified" at this point, but agent turns still fail: requests go to the managed inference route (`https://inference.local`) rather than to the relay. Behind the forward proxy, that route's onward request ended up at the proxy and was refused with a `403` error page from the proxy.

Point the OpenClaw provider directly at the relay. This edits a file NemoClaw manages, which is worth stating plainly: the supported way to set an inference endpoint is `nemoclaw inference set`, and it refuses a private address and refuses to change an existing provider's endpoint, so there is no supported path to this destination on this kind of host. The edit is small, backed up alongside the original, and re-applied by the [Rebuild checklist](#rebuild-checklist) after anything that recreates the sandbox. Expect to re-apply it after a NemoClaw upgrade as well.

```bash
nemoclaw main exec --no-tty -- sh -lc 'cp /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/openclaw.json.bak && sed -i "s#\"baseUrl\": \"https://inference.local\"#\"baseUrl\": \"http://host.openshell.internal:8000\"#" /sandbox/.openclaw/openclaw.json && grep -n baseUrl /sandbox/.openclaw/openclaw.json'
# Expected: "baseUrl": "http://host.openshell.internal:8000",
```

If the `grep` still shows `inference.local`, the config format differs on your version. Restore the backup (`cp /sandbox/.openclaw/openclaw.json.bak /sandbox/.openclaw/openclaw.json` inside the sandbox) and find the provider block by hand rather than editing blind.

The config reloads on its own; no restart is needed. Test a real agent turn:

```bash
nemoclaw main exec --no-tty -- openclaw agent --agent main -m "Reply with exactly: OK"
# Expected: OK
```

What to know about this change:

- **The NemoClaw banner doesn't change.** It still prints `Endpoint: Managed Inference Route (inference.local)`; that is registration metadata, not the path in use.
- **`nemoclaw main status` shows an inference error.** It reports `Inference: unauthorized ... HTTP 403` against `inference.local`, the route the `baseUrl` edit bypasses, while chat works normally. Treat a real agent turn as the check that counts.
- **It survives an in-sandbox gateway restart and a platform config push.** A push updates agents and skills and leaves the provider block alone.
- **Re-apply it after a sandbox recreate or re-onboard** (see the [Rebuild checklist](#rebuild-checklist)).
- **Agents created afterwards inherit it**, including the ones the platform creates for mentors.

---

## Part 6: Install the ibl.ai extensions plugin

The plugin adds the per-agent skill RPCs the platform uses. Build it on the host: Node is already installed and the required hosts are on the allowlist.

### 6.1 Build

Node is installed through nvm and isn't on `PATH` in a new shell (`corepack: command not found`), so load it first. Build in a temporary directory and keep only the built file:

```bash
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22
export HTTPS_PROXY=http://<proxy-host>:<proxy-port> HTTP_PROXY=http://<proxy-host>:<proxy-port>

mkdir -p ~/iblai/plugin
BUILD=$(mktemp -d /var/tmp/iblai-plugin-XXXXXX) && cd "$BUILD"
git clone --depth 1 https://github.com/iblai/iblai-openclaw-extensions-plugin
cd iblai-openclaw-extensions-plugin
git checkout <commit-sha>          # optional: pin to a reviewed commit
corepack enable pnpm && corepack prepare pnpm@10.17.1 --activate
pnpm install && pnpm build
sha256sum dist/index.mjs           # record with the change ticket
cp dist/index.mjs ~/iblai/plugin/index.mjs
cd ~ && rm -rf "$BUILD"
```

### 6.2 Assemble the plugin directory

A stock NemoClaw image has no plugin source inside the sandbox. Copy in a complete plugin (`openclaw.plugin.json`, `package.json` and `dist/index.mjs`), not just the built file. A fresh clone plus the built file has no `node_modules`. Leave it out: those symlinks make sandbox backups fail.

```bash
mkdir -p ~/iblai/plugin-src && cd ~/iblai/plugin-src
git clone --depth 1 https://github.com/iblai/iblai-openclaw-extensions-plugin .
mkdir -p dist && cp ~/iblai/plugin/index.mjs dist/index.mjs
ls -l openclaw.plugin.json package.json dist/index.mjs
```

Keep `~/iblai/plugin-src`. A sandbox recreate removes the plugin, and reinstalling from this directory needs no rebuild.

### 6.3 Install, enable, restart

```bash
CIDS=$(docker ps --filter name=openshell- -q)
[ "$(printf '%s\n' "$CIDS" | grep -c .)" -eq 1 ] || { echo "expected one sandbox container:"; docker ps --filter name=openshell-; }
CID=$(printf '%s\n' "$CIDS" | head -1); echo "CID=$CID"

nemoclaw main exec --no-tty -- id -u     # read the uid from the output, below the gateway banner
SBX_UID=998                              # set it to what that printed

docker cp ~/iblai/plugin-src "$CID":/tmp/iblai-openclaw-extensions
docker exec -u 0 "$CID" chown -R "$SBX_UID:$SBX_UID" /tmp/iblai-openclaw-extensions
nemoclaw main exec --no-tty -- openclaw plugins install /tmp/iblai-openclaw-extensions
nemoclaw main exec --no-tty -- openclaw plugins enable iblai-openclaw-extensions
```

- **Container name:** the sandbox container is named `openshell-default--main-<id>`, so filter on `openshell-` rather than `openshell-main`. The check above stops if more than one matches, because the next two commands run as root inside whichever container is picked.
- **Harmless warning:** `Plugin manifest id ... differs from npm package name` can be ignored.

Restart the OpenClaw gateway inside the sandbox so it loads the plugin. Without a systemd user manager, `openclaw gateway restart` reports `Gateway service disabled` and `nemoclaw main recover` cannot run. Stopping the process is the route that works, because NemoClaw's supervisor starts it again:

```bash
docker exec -u "$SBX_UID" "$CID" pkill -x openclaw
sleep 8
nemoclaw main exec --no-tty -- openclaw plugins inspect iblai-openclaw-extensions --json
# Expected: "status": "loaded" and "activated": true
```

This restart keeps the gateway token and the paired devices, and the relay `baseUrl` from [Step 5.5](#55-point-openclaw-at-the-relay) is kept too. [NemoClaw Server Setup](nemoclaw-setup.md#option-a-install-at-runtime-verified-end-to-end) uses `nemoclaw main restart` for this on a host with a systemd user manager.

Verify the plugin from the platform after [Part 7](#part-7-connect-to-iblai), not from the host CLI. Calling a gateway RPC from inside the sandbox needs more scopes than the CLI device holds, and creates a scope-upgrade request as a side effect.

---

## Part 7: Connect to ibl.ai

The API calls are the ones in [Platform Integration](platform-integration.md). What matters here is the order, plus a few details that are easy to miss.

### 7.1 Read the gateway token

```bash
nemoclaw main gateway-token
```

The token is **re-minted when the sandbox is created or recreated**, so re-read it after any onboard or rebuild. A plain gateway restart leaves it unchanged.

### 7.2 Register the instance, with a device key

Register with `claw_type: "nemoclaw"` and include the device identity key in the same request. Key generation is in [OpenClaw Server Setup, Step 5.2](server-setup.md#52-generate-and-store-device-keypair).

```http
POST /api/ai-mentor/orgs/<your-org>/claw/instances/
Content-Type: application/json

{
  "name": "<name>",
  "claw_type": "nemoclaw",
  "server_url": "https://<public-host>",
  "gateway_token": "<token from 7.1>",
  "connection_params": {
    "device_identity": {"private_key_pem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}
  }
}
```

- **Why `nemoclaw`, not `openclaw`:** the type decides how the platform treats updates. As `openclaw`, the platform believes the worker can upgrade itself in place. On NemoClaw, updates are rebuilds run by an operator on the host. The connection itself works either way.
- **Why the device key is required:** an instance without one still connects, but the gateway grants it no scopes. The symptoms point away from the cause: pairing reports `already_paired`, no platform device ever appears on the host, and every call returns `missing scope: operator.read`.

If the instance already exists without a key, add one with a `PATCH` to the same `connection_params` field.

### 7.3 Pair the platform device

Trigger a connection from the platform:

```http
POST /api/ai-mentor/orgs/<your-org>/claw/instances/<id>/health-check/
```

The first result is `pairing required: device is not approved yet`, and a pending request appears on the host. If none appears after the health check, push a mentor config ([Step 8.2](#82-bind-the-mentor-and-tell-the-agent-where-the-data-is)), which also connects.

Show the pending request by running `approve` with **no argument**:

```bash
nemoclaw main exec --no-tty -- openclaw devices approve
```

It prints the request id, the device, the requested scopes (`operator.admin, operator.read, operator.write`) and the source address, then the exact approve command. Check that the source address is the platform's egress address, then run that command:

```bash
nemoclaw main exec --no-tty -- openclaw devices approve <requestId>
```

A successful approval prints a scope-upgrade notice first:

```
gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: ...)
Direct scope access failed; using local fallback.
Approved <deviceId> (<requestId>)
```

The `scope upgrade pending approval` line is the CLI's own device asking for more scopes. **Leave that request alone**, and never remove the CLI device (see [Troubleshooting](#troubleshooting)).

Run the health check again. Wait a few seconds between runs; the platform processes these in the background, so an immediate re-read can still show the old result. The expected result is `status: active`, `healthy`.

The platform device's identity lives on the instance record, so it stays the same when the sandbox is recreated. Only the approval has to be repeated.

---

## Part 8: Configure the mentor

### 8.1 Create the mentor and set its flags

Create the mentor in the ibl.ai app, then set its flags **before anyone chats with it**. A mentor created from a template inherits the template's flags, so set these explicitly:

```http
PUT /api/ai-mentor/orgs/<your-org>/users/<admin-username>/mentors/<mentor>/settings/
Content-Type: application/json

{
  "enable_claw": true,
  "show_reasoning": false
}
```

| Flag | Why |
|---|---|
| `enable_claw` | **Required.** Chat reaches the worker only when this flag *and* the claw binding's `enabled` are both true. Without it, the mentor looks correctly configured but answers from the normal model path and never touches the worker. |
| `show_reasoning` | **Required with the relay provider.** With it on, the platform requests a thinking level, and the worker refuses every turn with `Thinking level "high" is not supported for <model>. Use one of: off.` The worker's model entry does not declare reasoning support. To offer reasoning, declare it on that model entry in `openclaw.json` and re-enable the flag. |

If the deployment must not store conversation content, also set these in the same request:

| Flag | Effect |
|---|---|
| `"disable_chathistory": true` | Conversations are not saved to history. Set it before the first chat. |
| `"save_flagged_prompts": false` | Moderation still blocks, but no longer stores the text of a flagged prompt. |
| `"enable_prompt_caching": true` | Only for a mentor with no trained documents. Every claw turn otherwise embeds the user's prompt for document retrieval before calling the worker, using the platform's default embedding provider when the tenant has no LLM key of its own. On the claw path this flag skips that step. The flag name doesn't describe this effect, and the settings page will show prompt caching as on. |

The endpoint takes a partial update, so send only the fields you want to change.

Leave the mentor's LLM provider and model label as the template set them. They are cosmetic on the claw path, where the worker decides which model answers, and changing them has broken chat in the browser.

### 8.2 Bind the mentor and tell the agent where the data is

```http
POST /api/ai-mentor/orgs/<your-org>/mentors/<mentor>/claw-config/
Content-Type: application/json

{"server": <instance id>, "enabled": true}
```

If you mounted a data directory, say so in the agent's identity. Without it the agent only searches its own workspace and tells users it has no data.

```http
PATCH /api/ai-mentor/orgs/<your-org>/mentors/<mentor>/agent-config/
Content-Type: application/json

{"identity": "... Data for this agent is in /sandbox/data, mounted read-only. Check that directory before telling a user no data is available. ..."}
```

Push the config:

```http
POST /api/ai-mentor/orgs/<your-org>/mentors/<mentor>/claw-config/push-config/
```

A successful push lists `IDENTITY.md` in `files_pushed`.

The push also returns a baseline check, which on a default worker reports `Elevated tools are enabled` and `Session isolation not configured`. The first concerns what the agent's tools are permitted to do inside the sandbox, the second whether each chat session gets its own isolated agent state. Neither blocks the deployment. Review both against your requirements before go-live, and record the decision.

The agent's own outbound access is limited twice: by the sandbox network policy, and by the forward proxy. Tools that fetch from the internet or install packages fail unless both allow the destination.

### 8.3 Verify

1. On the host, send a turn to the mentor's agent (the agent id is shown on the claw binding):
   ```bash
   nemoclaw main exec --no-tty -- openclaw agent --agent <agent-id> -m "Reply with exactly: OK"
   ```
2. Chat with the mentor in the ibl.ai app. If you mounted data, ask it what files it can see.
3. Check the plugin from the platform by pushing a skill to the mentor. Without the plugin, skill upload fails with `unknown method: iblai.skills.upload.begin`.

---

## Part 9: Turn off outbound calls you don't need

The allowlist is usually built from what fails during install. Calls on a timer don't fail during install, so they show up later in the proxy logs.

| Source | What it calls | How it's handled |
|---|---|---|
| OpenShell | usage telemetry to `events.telemetry.data.nvidia.com` (counters and category labels, no prompts) | `OPENSHELL_TELEMETRY_ENABLED=false` ([Step 2.3](#23-telemetry-off-before-anything-starts)) |
| OpenClaw | update check | `OPENCLAW_NO_AUTO_UPDATE=1`; the sandbox config shows `"update": {"checkOnStart": false}` |
| ollama | model-recommendation refresh to `ollama.com` roughly every 3 to 4.5 hours: a GET carrying the ollama installation's identity key and client version, with no request body | `OLLAMA_NO_CLOUD=1` ([Step 3.1](#31-run-ollama-as-a-container)), or remove ollama entirely once the relay is live |
| OpenClaw | model price list (`raw.githubusercontent.com`, `openrouter.ai`) | a periodic refresh, allowed by the `openclaw-pricing` policy |
| OpenClaw | the default `main` agent's heartbeat, every 30 minutes | **a real model call on the provider key.** Mentor agents created by the platform have it off; the default agent's setting lives in the worker config |

Verify telemetry is off by inspection, without sending traffic:

```bash
GW=$(pgrep -u "$(id -u)" -f openshell-gateway | head -1)
[ -n "$GW" ] && tr '\0' '\n' < "/proc/$GW/environ" | grep -i -e telemetry -e auto_update
# Expected: OPENSHELL_TELEMETRY_ENABLED=false and OPENCLAW_NO_AUTO_UPDATE=1

nemoclaw main exec --no-tty -- sh -lc 'grep -n -A2 "\"update\"" /sandbox/.openclaw/openclaw.json'
# Expected: "checkOnStart": false
```

Verify ollama:

```bash
docker logs ollama 2>&1 | grep -oE "Ollama cloud disabled: (true|false)"
# Expected: Ollama cloud disabled: true
```

With the flag on, ollama still logs `model recommendations cache sleep scheduled`. That is the timer being scheduled, not a request being sent.

If an ollama container from an earlier install lacks the flag, recreate it. The named volume keeps the downloaded model, and chat is not affected because inference doesn't use ollama:

```bash
docker rm -f ollama
docker run -d --name ollama --restart unless-stopped -p 127.0.0.1:11434:11434 \
  -e OLLAMA_NO_CLOUD=1 -e HTTPS_PROXY=$HTTPS_PROXY -e HTTP_PROXY=$HTTP_PROXY -e NO_PROXY=localhost,127.0.0.1 \
  -v ollama:/root/.ollama ollama/ollama
```

Once Part 5 is done, nothing uses ollama for inference. On a host chosen for minimal egress, remove it rather than silencing it:

```bash
docker rm -f ollama && docker volume rm ollama
```

Its allowlist entries (`ollama.com`, `registry.ollama.ai`) can then be closed. Keep it only if you want a local fallback model on the host, in which case leave `OLLAMA_NO_CLOUD=1` set.

---

## Rebuild checklist

A sandbox recreate (destroy and onboard, or an upgrade that recreates it) resets several things at once. Go through all of them, in this order:

1. **Before destroying,** snapshot the sandbox: `nemoclaw sandbox snapshot create main` (not `nemoclaw main snapshot`). A restore does not bring back platform pairing; plan to pair again either way.
2. Destroy while the gateway is running, and answer **N** to the gateway prompt ([Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint)).
3. Onboard with the full variable set from [Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint). If you changed any shell environment the gateway reads, stop the gateway first.
4. Check the listener is still `0.0.0.0:<DASHBOARD_PORT>` ([Step 3.5](#35-check-the-listener-and-the-tls-endpoint)).
5. Re-apply the `baseUrl` edit and test an agent turn ([Step 5.5](#55-point-openclaw-at-the-relay)).
6. Read the new gateway token and `PATCH` it onto the instance: `PATCH claw/instances/<id>/` with `{"gateway_token": "..."}`. **Do this before pairing.** With a stale token, every connection is refused with `AUTH_TOKEN_MISMATCH` before any request is created, which looks like pairing silently doing nothing.
7. Pair again ([Step 7.3](#73-pair-the-platform-device)).
8. Reinstall the plugin from `~/iblai/plugin-src` and restart ([Step 6.3](#63-install-enable-restart)).
9. Push each mentor's config again.
10. If the rebuild went through the local-model route again, drop the leftover provider once the relay is live: `nemoclaw credentials list`, then `nemoclaw credentials reset ollama-local --yes`.

The relay runs on the host and is not affected by a recreate.

Running the installer again does **not** upgrade NemoClaw: it re-resolves the same last-known-good release.

---

## Reboots and persistence

Settle this before the deployment is relied on. Without root, some pieces run as plain background processes with nothing to restart them:

| Piece | Comes back after a reboot? |
|---|---|
| ollama container (`--restart unless-stopped`) | yes |
| sandbox container | yes, under Docker's restart policy |
| `openshell-gateway` host process (standalone fallback) | **no** |
| `inference-relay.cjs` (started with `nohup`) | **no** |
| a manual `openshell forward service` from [Step 3.5](#35-check-the-listener-and-the-tls-endpoint), if you used one | **no** |

Logging out does not stop them when `KillUserProcesses` is at its default of `no`. Check the main file and any drop-ins: `grep -ri killuserprocesses /etc/systemd/logind.conf /etc/systemd/logind.conf.d/ 2>/dev/null`.

After a reboot, chat stays down until someone restarts at least the relay ([Step 5.3](#53-start-the-relay)) and the gateway. The durable answer is to supervise both, for example with user systemd units, which need root to enable lingering for the service account. Settle that with the host's owner, along with who restarts these pieces in the meantime.

---

## Decommissioning

To remove the deployment cleanly:

1. On the platform, delete the mentor's claw binding and the instance record.
2. Stop the relay and confirm it is gone: `pkill -u "$(id -u)" -f inference-relay.cjs` then `pgrep -a -u "$(id -u)" -f inference-relay`.
3. `nemoclaw main destroy`. Answer the second prompt `y` as well if nothing else on the host uses the shared gateway.
4. Remove the local model if you used it: `docker rm -f ollama && docker volume rm ollama`.
5. `rm -rf ~/iblai`, which holds the relay, its log, the plugin build, the environment file and the downloaded installer.
6. Restore the Docker client config backup from [Step 2.2](#22-proxy-for-image-builds), or remove the `proxies` block you added.
7. Remove NemoClaw itself if required: `~/.nemoclaw`, `~/.local/state/nemoclaw`, the shims in `~/.local/bin`, and `~/.config/systemd/user/nemoclaw-openshell-gateway.service`.
8. Ask the host's owner to close the allowlist entries and the inbound rule.

---

## Known constraints

Approaches that look workable but do not succeed on this kind of host, with the message each one returns.

- **NemoClaw's Bedrock Runtime adapter**, if your provider is Bedrock (`NEMOCLAW_ENDPOINT_URL=https://bedrock-runtime.<aws-region>.amazonaws.com`). The adapter doesn't pick up a Bedrock API key: requests hang for minutes and return a `502`. It also ignores the proxy even with `NODE_USE_ENV_PROXY=1`, because the AWS SDK brings its own HTTPS agent.
- **Onboarding directly against the provider's public endpoint.** Onboarding's validation request doesn't go out through the proxy, so it times out with `curl exit 28`.
- **`nemoclaw inference set` to a provider or relay endpoint.** It can't register a provider, can't point at a private address (`URL points to private/internal address`), and can't change an existing provider's endpoint (`requested binding differs in: endpoint URL`). Only onboarding changes the endpoint.
- **A relay on `127.0.0.1`.** The sandbox can't reach it (`a 127.0.0.1/localhost-only bind is not reachable from the sandbox`).
- **`NEMOCLAW_ENDPOINT_URL=http://host.openshell.internal:8000` in onboarding.** That name doesn't resolve on the host (`curl exit 6`). Use the bridge address for onboarding, and the hostname for `baseUrl`.
- **Adding a network policy entry for the relay's address.** The sandbox policy governs what the sandbox may reach, not where the managed inference route sends its own onward request, so this does not redirect that route. The `baseUrl` change in [Step 5.5](#55-point-openclaw-at-the-relay) is what moves traffic to the relay.
- **`nemoclaw main recover`.** It fails without a systemd user manager: `Repair the current user's secure OS runtime authority and NemoClaw state permissions`.
- **`openclaw gateway restart` inside the sandbox.** It fails with `Gateway service disabled`.
- **The Control UI from a workstation browser.**
  - On a stock image the allowed origin stays `http://127.0.0.1:<DASHBOARD_PORT>`, whether or not `CHAT_UI_URL` is exported before onboarding. Read yours with `nemoclaw main exec --no-tty -- openclaw config get gateway`.
  - An SSH tunnel to loopback only works if the host's SSH server allows port forwarding; otherwise it fails with `channel 2: open failed: administratively prohibited`.
  - Use the CLI on the host. The platform doesn't use the dashboard.
- **Approving devices from off the host.** A control-path connection cannot approve (`missing scope: operator.pairing`); approve on the host.
- **`nemoclaw main doctor --fix` for pairing problems.** It doesn't approve the platform's device or repair the CLI device's scopes.
- **`onboard --fresh` to reset devices.** It doesn't clear the device table; only destroy and onboard does.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `curl: (22) ... 403` at "Installing OpenShell CLI" | `release-assets.githubusercontent.com` not allowed | Add it to the allowlist; re-run the installer |
| Allowlist loop prints `000` for every host | Using `%{http_code}` | Use `%{http_connect}` ([Step 1.4](#14-check-the-allowlist)) |
| Hosts reported as allowed still refused | Proxy rule doesn't match the exact hostname | List the exact hostname, or the proxy's wildcard form |
| `ERROR: ollama-linux-amd64 ships as .tar.zst but zstd is not installed` | `install-ollama` needs `zstd`, which it can't install without root | ollama container ([Step 3.1](#31-run-ollama-as-a-container)) |
| `Error: something went wrong, please see the ollama server logs` | ollama CLI going through the proxy | `docker exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama ...` |
| `⚠ HTTP_PROXY/http_proxy is set without NO_PROXY=...inference.local` | `NO_PROXY` incomplete | Use the `NO_PROXY` from [Step 2.1](#21-proxy-variables) |
| Image build can't reach npm or apt | Build doesn't see the shell proxy | `~/.docker/config.json` proxies ([Step 2.2](#22-proxy-for-image-builds)) |
| Dashboard listening on `127.0.0.1:<port>` | `NEMOCLAW_DASHBOARD_BIND` not exported at onboarding | [Step 3.5](#35-check-the-listener-and-the-tls-endpoint) |
| `failed to bind local forward ... Address in use` | Onboarding already bound the port | Nothing to fix; skip the manual forward |
| Onboard: `upstream rejected credentials with HTTP 403`, with the proxy's HTML error page as the body | Gateway still has an old `NO_PROXY` | Stop the gateway, then onboard ([Step 5.4](#54-recreate-the-sandbox-with-the-relay-endpoint)) |
| Onboard: `Anthropic Messages API: HTTP 401` against the relay | Relay passing `x-api-key` | Use the relay from this repo, which strips it |
| Onboarding or a turn fails, and the relay log shows `"event":"blocked"` | The relay's `ALLOWED` list doesn't cover an endpoint this version calls | Add the method and path from that log line to `ALLOWED` in the script, then restart the relay |
| `[resume] Skipping sandbox (main)` | Onboarding reused the old sandbox | Destroy first |
| `Failed to destroy sandbox 'main'. The OpenShell gateway is unreachable.` | Gateway stopped before destroy | Onboard to restart it, then destroy |
| Stale `compatible-anthropic-endpoint` from a failed attempt | Provider left registered | `nemoclaw credentials reset compatible-anthropic-endpoint --yes` |
| "Deployment verified" but `LLM request failed.` | Managed route refused by the forward proxy | `baseUrl` edit ([Step 5.5](#55-point-openclaw-at-the-relay)) |
| `status` shows `Inference: unauthorized ... 403` while chat works | Status probes `inference.local`, which is bypassed | Expected; test with an agent turn |
| Pairing reports `already_paired`, then `missing scope: operator.read` | Instance has no device key | Add `connection_params.device_identity` ([Step 7.2](#72-register-the-instance-with-a-device-key)) |
| No pending request on the host after a recreate | Stale gateway token (`AUTH_TOKEN_MISMATCH`) | Update `gateway_token`, then pair |
| `devices approve` fails: `device is asking for more scopes than currently approved` | The CLI device was removed and came back with only `operator.pairing` | Never remove the CLI device. Only `nemoclaw main destroy` and onboard repaired it |
| `Direct scope access failed; using local fallback.` | Normal output of a successful approve | None; look for `Approved` |
| Health check still `pairing required` right after approving | Platform result not refreshed yet | Wait a few seconds and run it again |
| `-bash: corepack: command not found` | nvm not loaded | `source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22` |
| `CID=` empty | Filtered on `openshell-main` | `docker ps --filter name=openshell- -q` |
| `unknown method: iblai.skills.upload.begin` | Plugin not installed or lost in a recreate | [Step 6.3](#63-install-enable-restart) |
| `Gateway service disabled` from `openclaw gateway restart` | No service manager in the sandbox | `docker exec -u 998 $CID pkill -x openclaw` |
| Every turn refused: `Thinking level "high" is not supported` | `show_reasoning` on | Set `show_reasoning: false` ([Step 8.1](#81-create-the-mentor-and-set-its-flags)) |
| Chat answers from the normal model, worker never called | `enable_claw` not set | Set `enable_claw: true` |
| Agent says it has no data | Identity doesn't mention the mount | [Step 8.2](#82-bind-the-mentor-and-tell-the-agent-where-the-data-is) |
| `Show snapshot usage` | Wrong snapshot syntax | `nemoclaw sandbox snapshot create main` |
| `unknown field 'mtls_auth'`, gateway won't start | OpenShell binaries older than NemoClaw expects | Install `openshell`, `openshell-gateway` and `openshell-sandbox` from the same OpenShell release |
