// OAuth 2.1 for the remote MCP server (MCP authorization spec, 2025-06-18).
//
// Roles: this server is an OAuth *resource server*. The *authorization
// server* is Supabase Auth's OAuth 2.1 server for the project (the same
// project that already signs users in with Google, Apple and email), so an
// access token here is an ordinary Supabase user JWT and www.rhylthyme.com's
// API validates it exactly as it validates the web app's. Nothing in this
// file verifies signatures or mints tokens.
//
// What it does:
//   * serves RFC 9728 protected-resource metadata at
//     /.well-known/oauth-protected-resource[/<path>] naming Supabase as the
//     authorization server, and mirrors Supabase's RFC 8414 metadata at
//     /.well-known/oauth-authorization-server for clients written against
//     the 2025-03-26 spec, which looked for it on the MCP host;
//   * reads `Authorization: Bearer <token>` and makes it available to tool
//     handlers for the duration of the request (AsyncLocalStorage), so
//     tools no longer need a pasted `token` argument;
//   * step-up: the public tools stay anonymous. Only a tools/call that
//     needs an account and arrives with no credential at all (no header, no
//     `token` argument) is answered with 401 + WWW-Authenticate, which is
//     what makes an OAuth-capable host open its Connect flow. An expired
//     bearer token gets the same, with error="invalid_token", so the host
//     refreshes instead of showing the model a failure. No challenge goes
//     out while the authorization server is switched off (see
//     authorizationServerReady).
//
// The pasted-token path (the `login` tool, the `token` argument, the CLI)
// keeps working for hosts that cannot do OAuth.
//
// Standalone module with no imports from index.js; mirrored byte-for-byte
// into rhylthyme-mcp by tools/check_mirrors.sh.

"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const store = new AsyncLocalStorage();
const WELL_KNOWN_RESOURCE = "/.well-known/oauth-protected-resource";
const WELL_KNOWN_AS = "/.well-known/oauth-authorization-server";

// Tools that act on the signed-in user's account. import_from_source needs
// an account only for some actions; see needsAccount().
const ACCOUNT_TOOLS = new Set([
  "list_my_programs", "load_program", "save_program", "list_runs", "load_run",
  "calibrate_program", "import_text",
]);

function issuer(env) {
  env = env || process.env;
  if (env.MCP_OAUTH_ISSUER) return env.MCP_OAUTH_ISSUER.replace(/\/+$/, "");
  return env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1" : null;
}

function enabled(env) {
  env = env || process.env;
  return Boolean(issuer(env)) && !env.MCP_OAUTH_DISABLED;
}

// RFC 8414 with an issuer that has a path: the well-known segment goes
// between host and path. https://x.supabase.co/auth/v1 ->
// https://x.supabase.co/.well-known/oauth-authorization-server/auth/v1
function authorizationServerMetadataUrl(env) {
  const iss = issuer(env);
  if (!iss) return null;
  const u = new URL(iss);
  return `${u.origin}${WELL_KNOWN_AS}${u.pathname.replace(/\/+$/, "")}`;
}

function originOf(req) {
  const h = req.headers || {};
  const host = String(h["x-forwarded-host"] || h.host || "mcp.rhylthyme.com").split(",")[0].trim();
  const proto = String(h["x-forwarded-proto"] || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}

// The MCP endpoint a metadata request is about: the path after the
// well-known prefix, defaulting to /mcp.
function resourcePathFor(reqUrl) {
  const path = String(reqUrl || "").split("?")[0];
  const rest = path.startsWith(WELL_KNOWN_RESOURCE) ? path.slice(WELL_KNOWN_RESOURCE.length) : "";
  return /^\/([a-z]+\/)?mcp$/.test(rest) ? rest : "/mcp";
}

function protectedResourceMetadata(req, env) {
  return {
    resource: originOf(req) + resourcePathFor(req.url),
    authorization_servers: [issuer(env)],
    bearer_methods_supported: ["header"],
    resource_name: "Rhylthyme",
    resource_documentation: "https://github.com/rhylthyme/rhylthyme-mcp#readme",
  };
}

function resourceMetadataUrl(req) {
  const path = String(req.url || "/mcp").split("?")[0];
  return originOf(req) + WELL_KNOWN_RESOURCE + (/^\/([a-z]+\/)?mcp$/.test(path) ? path : "/mcp");
}

function challenge(req, error, description) {
  let value = `Bearer resource_metadata="${resourceMetadataUrl(req)}"`;
  if (error) value += `, error="${error}"`;
  if (description) value += `, error_description="${description.replace(/"/g, "'")}"`;
  return value;
}

function bearerFrom(headers) {
  const raw = headers && (headers.authorization || headers.Authorization);
  const m = /^Bearer\s+(\S+)\s*$/i.exec(Array.isArray(raw) ? raw[0] : String(raw || ""));
  return m ? m[1] : null;
}

// Expiry only. The signature is checked by www.rhylthyme.com's API (which
// asks Supabase) when the tool uses the token; this is just enough to turn
// "expired" into a refresh instead of a tool error.
function isExpired(token, nowSeconds) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    if (typeof payload.exp !== "number") return false;
    return payload.exp <= (nowSeconds || Date.now() / 1000);
  } catch (_) {
    return false; // not a JWT we can read; let the API decide
  }
}

function needsAccount(toolName, args) {
  if (ACCOUNT_TOOLS.has(toolName)) return true;
  if (toolName === "import_from_source") {
    const a = args || {};
    return a.action === "import" || a.action === "random" || a.source === "benchling";
  }
  return false;
}

function callsIn(bodyBuf) {
  if (!bodyBuf || !bodyBuf.length) return [];
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(bodyBuf) ? bodyBuf.toString("utf8") : String(bodyBuf)); } catch (_) { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((m) => m && m.method === "tools/call" && m.params && typeof m.params.name === "string")
    .map((m) => ({ id: m.id === undefined ? null : m.id, name: m.params.name, args: m.params.arguments || {} }));
}

// Decide whether to answer this POST with a 401 instead of running it.
// Returns null to proceed, or { status, headers, body }.
function gate(req, bodyBuf, env) {
  if (!enabled(env)) return null;
  const bearer = bearerFrom(req.headers);
  const account = callsIn(bodyBuf).filter((c) => needsAccount(c.name, c.args));
  if (!account.length) return null;
  const withoutCredential = account.filter((c) => !c.args.token);
  let error = null, description = null;
  if (bearer && isExpired(bearer)) {
    error = "invalid_token"; description = "The access token expired";
  } else if (!bearer && withoutCredential.length) {
    description = `${withoutCredential[0].name} needs the user's Rhylthyme account`;
  } else {
    return null;
  }
  return {
    status: 401,
    headers: { "WWW-Authenticate": challenge(req, error, description), "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: account[0].id,
      error: { code: -32001, message: `Authorization required: ${description}. Connect your Rhylthyme account, or call the login tool for a token to paste.` },
    }),
  };
}

// Is the authorization server actually answering? Supabase's OAuth 2.1
// server is a per-project switch; while it is off, a 401 would send an
// OAuth-capable host into a Connect flow that cannot finish, so the caller
// skips the challenge and the tool answers with its pasted-token text
// instead. Probed only when a challenge is about to go out, and cached: an
// hour once it works, a minute while it does not, so flipping the switch
// takes effect without a deploy.
let readiness = { value: null, until: 0, key: null };
async function authorizationServerReady(env) {
  const url = authorizationServerMetadataUrl(env);
  if (!url) return false;
  const now = Date.now();
  if (readiness.key === url && readiness.value !== null && now < readiness.until) return readiness.value;
  let ok = false;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = resp.ok ? await resp.json() : null;
    ok = Boolean(data && data.authorization_endpoint && data.token_endpoint);
  } catch (_) { ok = false; }
  readiness = { value: ok, until: now + (ok ? 3600e3 : 60e3), key: url };
  return ok;
}
// Tests: pin the answer (true/false) or clear the cache (null).
function _setReady(value, env) {
  readiness = value === null ? { value: null, until: 0, key: null }
    : { value: Boolean(value), until: Date.now() + 3600e3, key: authorizationServerMetadataUrl(env) };
}

// Serve the discovery documents. Returns true when it handled the request.
async function handleWellKnown(req, res, env) {
  const path = String(req.url || "").split("?")[0];
  const isResource = path.startsWith(WELL_KNOWN_RESOURCE);
  const isAs = path.startsWith(WELL_KNOWN_AS);
  if (!isResource && !isAs) return false;
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
  const send = (status, obj, extra) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(Object.assign({}, cors, extra || {}))) res.setHeader(k, v);
    if (obj === null) return res.end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") { send(204, null); return true; }
  if (!enabled(env)) { send(404, { error: "OAuth is not configured for this server" }); return true; }
  if (isResource) {
    send(200, protectedResourceMetadata(req, env), { "Cache-Control": "public, max-age=3600" });
    return true;
  }
  try {
    const resp = await fetch(authorizationServerMetadataUrl(env), { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    send(resp.ok ? 200 : 502, data, resp.ok ? { "Cache-Control": "public, max-age=600" } : null);
  } catch (e) {
    send(502, { error: `authorization server metadata unavailable: ${e.message || e}` });
  }
  return true;
}

// Run `fn` with the request's bearer token available to tool handlers.
function withRequest(req, fn) {
  return store.run({ bearer: bearerFrom(req.headers) }, fn);
}

// What a tool should use: an explicit `token` argument wins (the CLI, and
// hosts without OAuth), otherwise the request's bearer token.
function resolveToken(argToken) {
  if (argToken) return argToken;
  const ctx = store.getStore();
  return (ctx && ctx.bearer) || null;
}

module.exports = {
  ACCOUNT_TOOLS, WELL_KNOWN_RESOURCE, WELL_KNOWN_AS,
  enabled, issuer, authorizationServerMetadataUrl, protectedResourceMetadata, resourceMetadataUrl,
  challenge, bearerFrom, isExpired, needsAccount, gate, authorizationServerReady, _setReady,
  handleWellKnown, withRequest, resolveToken,
};
