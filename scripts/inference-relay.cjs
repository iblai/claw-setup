// Relay: Anthropic Messages API -> a bearer-authenticated upstream, through a forward proxy.
//
// Reference implementation. It is deliberately small so it can be read in full before
// it runs with your key, and adapted to the host it runs on.
//
// Why this exists: on a host whose only egress is a forward proxy, NemoClaw's own
// inference paths cannot reach the model provider. Onboarding's endpoint validation
// and NemoClaw's host-side adapters do not use the proxy, and the managed inference
// route's onward request is refused by it. This process runs on the host, listens on
// the sandbox bridge address, replaces whatever credentials the caller sends with the
// upstream key, and makes the outbound request through HTTPS_PROXY using Node's
// built-in env-proxy support.
//
// It suits any upstream that speaks the Anthropic Messages format and authenticates
// with a bearer token. Developed and run against Amazon Bedrock's Anthropic-compatible
// (Mantle) endpoint: UPSTREAM_URL=https://bedrock-mantle.<aws-region>.api.aws/anthropic
//
// This process holds the provider key and applies it to every request it accepts, so
// treat it as a credential. It listens on a Docker bridge address that every container
// on that network can reach, and it has no authentication of its own. It accepts only
// the two endpoints the integration uses and refuses everything else.
//
// Start with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set.
//
// Env:
//   UPSTREAM_URL         required, https, the upstream base URL (paths are appended)
//   UPSTREAM_API_KEY     required, sent as "Authorization: Bearer <key>"
//   RELAY_BIND           default 127.0.0.1; use the sandbox bridge address (e.g. 172.18.0.1)
//   RELAY_PORT           default 8788
//   UPSTREAM_TIMEOUT_MS  default 600000; a turn that streams for longer is cut off

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = Number(process.env.RELAY_PORT || 8788);
const BIND = process.env.RELAY_BIND || "127.0.0.1";
const UPSTREAM = (process.env.UPSTREAM_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.UPSTREAM_API_KEY || "";
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);

// Only what the integration needs: a completion, and the model list onboarding probes.
// Other versions or providers may call other endpoints. A refused request is logged as
// "blocked" with its method and path, so widen this list to match what you see.
const ALLOWED = [
  { method: "POST", path: "/v1/messages" },
  { method: "GET", path: "/v1/models" },
];

// Connection-specific headers, which belong to one hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function fail(message) {
  process.stderr.write(`[inference-relay] ${message}\n`);
  process.exit(1);
}

if (!TOKEN) fail("UPSTREAM_API_KEY is not set");
if (!UPSTREAM) fail("UPSTREAM_URL is not set");
if (!UPSTREAM.startsWith("https://")) fail("UPSTREAM_URL must be https");

// A proxy that is configured but not honoured would send the key straight out to
// the internet, so stop rather than make that request.
if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
  fail("HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not 1: requests would bypass the proxy");
}

let base;
try {
  base = new URL(UPSTREAM);
} catch {
  fail(`UPSTREAM_URL is not a valid URL: ${UPSTREAM}`);
}

function log(fields) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const peer = req.socket.remoteAddress;
  const requested = new URL(req.url, "http://relay").pathname;

  if (!ALLOWED.some((entry) => entry.method === req.method && entry.path === requested)) {
    log({ event: "blocked", method: req.method, path: requested, peer });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "relay_not_allowed", message: "endpoint not permitted" } }));
    return;
  }

  const path = `${base.pathname}${req.url}`.replace(/\/{2,}/g, "/");

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    // Drop hop-by-hop headers and any caller credentials. Onboarding's validation
    // probe sends x-api-key, which a bearer-token upstream rejects alongside the token.
    if (HOP_BY_HOP.has(name) || ["host", "authorization", "x-api-key"].includes(name)) continue;
    headers[key] = value;
  }
  headers.host = base.host;
  headers.authorization = `Bearer ${TOKEN}`;
  if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";

  const upstream = https.request(
    { hostname: base.hostname, port: base.port || 443, path, method: req.method, headers },
    (upstreamRes) => {
      log({
        event: "proxied",
        method: req.method,
        path,
        peer,
        status: upstreamRes.statusCode,
        ms: Date.now() - started,
      });
      const out = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        out[key] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, out);
      upstreamRes.pipe(res);
    },
  );

  upstream.setTimeout(TIMEOUT_MS, () => {
    upstream.destroy(new Error("upstream timeout"));
  });

  upstream.on("error", (err) => {
    const detail = err && (err.code || err.message) ? String(err.code || err.message) : "error";
    log({ event: "upstream_failed", method: req.method, path, peer, error: detail, ms: Date.now() - started });
    // Once the response is streaming, appending JSON would corrupt it: drop the connection instead.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "relay_upstream_error", message: detail } }));
  });

  // Don't leave an upstream turn running when the caller goes away.
  req.on("aborted", () => upstream.destroy());

  req.pipe(upstream);
});

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", (err) => {
  const detail = err && (err.code || err.message) ? String(err.code || err.message) : "error";
  fail(`cannot listen on ${BIND}:${PORT}: ${detail}`);
});

server.listen(PORT, BIND, () => {
  log({
    event: "ready",
    listening: `http://${BIND}:${PORT}`,
    upstream: UPSTREAM,
    allowed: ALLOWED.map((entry) => `${entry.method} ${entry.path}`),
    proxy: process.env.HTTPS_PROXY || null,
    envProxy: process.env.NODE_USE_ENV_PROXY || null,
  });
});
