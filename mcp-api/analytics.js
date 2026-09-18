// Usage analytics for the remote MCP server.
//
// One row per JSON-RPC request (initialize, tools/list, tools/call,
// resources/read, prompts/get, ...) goes to the Supabase `mcp_events`
// table (sql/mcp_events.sql). Notifications and pings are skipped.
//
// What is recorded: endpoint (generic/kitchen/lab/events/gym), JSON-RPC
// method, tool/resource/prompt name, the client's self-reported name and
// version from `initialize`, success or error code, latency, the
// country Vercel derives from the IP, and a few non-content argument
// fields (`source`, `action`, `environmentType`, `enrich`, which
// argument keys were present).
//
// What is NOT recorded: IP addresses, tool argument values such as
// queries, program JSON, pasted text or tokens. Distinct clients are
// counted by `client_hash`, a salted SHA-256 of IP + User-Agent. When a
// login token is passed, `user_id` is the token's `sub` claim — decoded
// without verification, so treat it as a label for filtering, not as
// proof of identity.
//
// The server is stateless (no Mcp-Session-Id), so a tools/call carries
// no clientInfo; `client_hash` is what links it back to the initialize
// that preceded it.
//
// Recording never throws and never delays the MCP response: rows are
// written after `res.end()`, handed to Vercel's `waitUntil` so the
// function is not suspended mid-insert, which is the likely cause of the
// earlier sporadic "aborted due to timeout" warnings. 5 s timeout, one
// retry on timeout or network error.
// Rows are only written when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// set and MCP_ANALYTICS_DISABLED is not.
//
// Failures are also reported, whether or not rows are written:
//   * every failed request is one `[mcp-error]` / `[mcp-warn]` JSON line in
//     the function log (Vercel > Logs, filter on "mcp-error"). The line
//     carries the server's own error message; that message stays in the
//     log and is never written to the table.
//   * failures that mean something is broken (a tool erroring, a 5xx, an
//     internal RPC error, a tools/call whose arguments the schema rejected)
//     are posted to MCP_ALERT_WEBHOOK_URL (falling back to
//     SLACK_FEEDBACK_WEBHOOK_URL), throttled per endpoint+tool+code so a
//     retry storm is one message. Expected refusals (login required,
//     expired token), unknown methods from crawlers, 4xx probes, and the
//     CLI's own `mcp-test` traffic are logged but never alerted.
//
// Standalone module with no imports from index.js; mirrored byte-for-byte
// into rhylthyme-mcp by tools/check_mirrors.sh.

"use strict";

const crypto = require("crypto");

const SKIP_METHODS = new Set(["ping"]);
const SAFE_ARG_FIELDS = ["source", "action", "environmentType", "enrich", "vertical"];
const MAX_RESPONSE_SCAN = 4 * 1024 * 1024; // bytes of response kept for outcome parsing
const INSERT_TIMEOUT_MS = 5000;
const INSERT_ATTEMPTS = 2;
const ALERT_TIMEOUT_MS = 4000;
const ALERT_REPEAT_MS = 15 * 60 * 1000; // same endpoint+tool+code at most this often
const ALERT_MIN_GAP_MS = 20 * 1000;     // and never faster than this overall
const EXPECTED_REFUSAL = /requires the user's Rhylthyme access token|not authorized \(40[13]\)|Token verification failed/i;

function _str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Parse the raw POST body into the JSON-RPC messages worth logging.
// Returns [] for anything that is not JSON-RPC.
function parseRequests(bodyBuf) {
  if (!bodyBuf || !bodyBuf.length) return [];
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(bodyBuf) ? bodyBuf.toString("utf8") : String(bodyBuf));
  } catch (_) {
    return [];
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  return msgs.filter((m) =>
    m && typeof m === "object" && typeof m.method === "string" &&
    m.id !== undefined && m.id !== null &&           // notifications have no id
    !m.method.startsWith("notifications/") &&
    !SKIP_METHODS.has(m.method));
}

// Unverified JWT `sub`. Only used as a filter label.
function tokenSubject(token) {
  if (typeof token !== "string") return null;
  const parts = token.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = payload && payload.sub;
    return typeof sub === "string" && /^[0-9a-f-]{36}$/i.test(sub) ? sub.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function clientHash(ip, userAgent, salt) {
  if (!ip && !userAgent) return null;
  return crypto.createHash("sha256")
    .update(`${salt || ""}|${ip || ""}|${userAgent || ""}`)
    .digest("hex")
    .slice(0, 32);
}

// Build the event rows for one HTTP request. `ctx` carries request-level
// facts: { vertical, headers, salt }.
function buildEvents(messages, ctx) {
  const headers = ctx.headers || {};
  const h = (k) => {
    const v = headers[k];
    return Array.isArray(v) ? v.join(", ") : v;
  };
  const ip = (h("x-forwarded-for") || h("x-real-ip") || "").split(",")[0].trim() || null;
  const ua = _str(h("user-agent"), 300);
  const hash = clientHash(ip, ua, ctx.salt);
  const country = _str(h("x-vercel-ip-country"), 8);
  const authUser = tokenSubject(h("authorization"));

  return messages.map((m) => {
    const params = (m.params && typeof m.params === "object") ? m.params : {};
    const ev = {
      rpc_id: m.id,
      endpoint: ctx.vertical || "generic",
      method: _str(m.method, 64),
      tool: null,
      client_name: null,
      client_version: null,
      protocol_version: null,
      client_hash: hash,
      user_id: authUser,
      user_agent: ua,
      country: country,
      detail: null,
    };
    if (m.method === "initialize") {
      const ci = params.clientInfo || {};
      ev.client_name = _str(ci.name, 100);
      ev.client_version = _str(ci.version, 50);
      ev.protocol_version = _str(params.protocolVersion, 20);
    } else if (m.method === "tools/call") {
      ev.tool = _str(params.name, 100);
      const args = (params.arguments && typeof params.arguments === "object") ? params.arguments : {};
      const detail = { argKeys: Object.keys(args).sort().slice(0, 30) };
      for (const f of SAFE_ARG_FIELDS) {
        if (args[f] !== undefined && (typeof args[f] === "string" || typeof args[f] === "boolean")) {
          detail[f] = typeof args[f] === "string" ? _str(args[f], 40) : args[f];
        }
      }
      ev.detail = detail;
      ev.user_id = tokenSubject(args.token) || ev.user_id;
    } else if (m.method === "resources/read") {
      ev.tool = _str(params.uri, 200);
    } else if (m.method === "prompts/get") {
      ev.tool = _str(params.name, 100);
    }
    return ev;
  });
}

// Pull JSON-RPC responses out of a JSON or SSE body and index them by id.
function parseResponses(text) {
  const out = new Map();
  if (!text) return out;
  const add = (obj) => {
    for (const r of Array.isArray(obj) ? obj : [obj]) {
      if (r && typeof r === "object" && r.id !== undefined) out.set(JSON.stringify(r.id), r);
    }
  };
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { add(JSON.parse(t)); } catch (_) { /* truncated */ }
    return out;
  }
  for (const line of t.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { add(JSON.parse(line.slice(5).trim())); } catch (_) { /* partial */ }
  }
  return out;
}

// Fill ok / error_code / duration / status on each event.
function applyOutcome(events, responseText, httpStatus, durationMs) {
  const byId = parseResponses(responseText);
  for (const ev of events) {
    const r = byId.get(JSON.stringify(ev.rpc_id));
    ev.http_status = httpStatus;
    ev.duration_ms = Math.max(0, Math.round(durationMs));
    if (httpStatus >= 400) {
      ev.ok = false;
      ev.error_code = `http_${httpStatus}`;
    } else if (!r) {
      ev.ok = null;               // response unparsed (truncated or streamed elsewhere)
      ev.error_code = null;
    } else if (r.error) {
      ev.ok = false;
      ev.error_code = _str(`rpc_${r.error.code}`, 40);
      ev.error_message = _oneLine(r.error.message);
    } else if (r.result && r.result.isError) {
      ev.ok = false;
      ev.error_code = "tool_error";
      const first = (r.result.content || []).find((c) => c && c.type === "text");
      ev.error_message = _oneLine(first && first.text);
    } else {
      ev.ok = true;
      ev.error_code = null;
    }
  }
  return events;
}

function _oneLine(text) {
  return text ? _str(String(text).replace(/\s+/g, " ").trim(), 400) : null;
}

function toRow(ev) {
  // rpc_id only pairs requests with responses; error_message is for the
  // function log and alerts, never the table.
  const { rpc_id, error_message, ...row } = ev;
  return row;
}

// "alert": something is broken. "warn": a client mistake or an expected
// refusal, worth a log line only. null: not a failure.
function severity(ev) {
  if (ev.ok !== false) return null;
  const code = ev.error_code || "";
  if (code === "tool_error") return EXPECTED_REFUSAL.test(ev.error_message || "") ? "warn" : "alert";
  if (/^http_5/.test(code) || code === "rpc_-32603") return "alert";
  if (code === "rpc_-32602" && ev.method === "tools/call") return "alert";
  return "warn";
}

function logFailures(events) {
  const failed = [];
  for (const ev of events) {
    const level = severity(ev);
    if (!level) continue;
    failed.push({ ev, level });
    const line = JSON.stringify({
      endpoint: ev.endpoint, method: ev.method, tool: ev.tool, code: ev.error_code,
      status: ev.http_status, ms: ev.duration_ms, message: ev.error_message || null,
      client: ev.client_hash ? ev.client_hash.slice(0, 6) : null, ua: ev.user_agent, country: ev.country,
    });
    if (level === "alert") console.error(`[mcp-error] ${line}`);
    else console.warn(`[mcp-warn] ${line}`);
  }
  return failed;
}

const _lastAlert = new Map(); // signature -> { at, suppressed }
let _lastAlertAt = 0;

function _resetAlertThrottle() { _lastAlert.clear(); _lastAlertAt = 0; }

async function sendAlerts(failed, env, now) {
  env = env || process.env;
  now = now || Date.now();
  const webhook = env.MCP_ALERT_WEBHOOK_URL || env.SLACK_FEEDBACK_WEBHOOK_URL;
  if (!webhook || env.MCP_ALERTS_DISABLED) return 0;
  let sent = 0;
  for (const { ev, level } of failed) {
    if (level !== "alert") continue;
    if (/mcp-test/i.test(ev.user_agent || "")) continue; // `rhylthyme mcp-test` provokes errors on purpose
    const signature = `${ev.endpoint}|${ev.tool || ev.method}|${ev.error_code}`;
    const last = _lastAlert.get(signature);
    if ((last && now - last.at < ALERT_REPEAT_MS) || now - _lastAlertAt < ALERT_MIN_GAP_MS) {
      if (last) last.suppressed += 1;
      continue;
    }
    const suppressed = last ? last.suppressed : 0;
    _lastAlert.set(signature, { at: now, suppressed: 0 });
    _lastAlertAt = now;
    const path = ev.endpoint === "generic" ? "/mcp" : `/${ev.endpoint}/mcp`;
    const text = [
      `:rotating_light: *MCP error* on \`${path}\`: \`${ev.method}${ev.tool ? " " + ev.tool : ""}\` failed with \`${ev.error_code}\` (${ev.duration_ms} ms)`,
      ev.error_message ? `> ${ev.error_message}` : null,
      `client \`${ev.user_agent || "unknown"}\`${ev.client_hash ? " #" + ev.client_hash.slice(0, 6) : ""}${ev.country ? " · " + ev.country : ""}` +
        (suppressed ? ` · ${suppressed} more like this since the last alert` : ""),
      "Vercel logs: filter on `mcp-error`. Reproduce with `rhylthyme mcp-test`.",
    ].filter(Boolean).join("\n");
    try {
      const resp = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      if (resp.ok) sent += 1;
      else console.warn(`mcp alert webhook returned ${resp.status}`);
    } catch (e) {
      console.warn("mcp alert webhook failed:", e && e.message ? e.message : e);
    }
  }
  return sent;
}

let _sink = null; // tests replace the Supabase writer

function setSink(fn) { _sink = fn; }

function enabled(env) {
  env = env || process.env;
  if (_sink) return true;
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && !env.MCP_ANALYTICS_DISABLED);
}

async function insertRows(rows, env) {
  env = env || process.env;
  if (_sink) return _sink(rows);
  for (let attempt = 1; ; attempt++) {
    try {
      return await _insertOnce(rows, env);
    } catch (e) {
      const transient = e && (e.name === "TimeoutError" || e.name === "AbortError" || e.name === "TypeError");
      if (!transient || attempt >= INSERT_ATTEMPTS) throw e;
    }
  }
}

async function _insertOnce(rows, env) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/mcp_events`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(INSERT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    console.warn(`mcp analytics insert failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
}

// Vercel's per-request waitUntil (what @vercel/functions reads), or null
// outside Vercel. Keeps the instance alive for work after the response.
function waitUntil(promise) {
  try {
    const ctx = globalThis[Symbol.for("@vercel/request-context")];
    const fn = ctx && typeof ctx.get === "function" ? (ctx.get() || {}).waitUntil : null;
    if (typeof fn === "function") { fn(promise); return true; }
  } catch (_) { /* fall through */ }
  return false;
}

// Start tracking one HTTP request. Returns null when there is nothing to
// log, otherwise an object whose `capture(chunk)` tees response bytes and
// whose `finish(status)` writes the rows. Neither ever throws.
function begin(bodyBuf, ctx, env) {
  env = env || process.env;
  try {
    const messages = parseRequests(bodyBuf);
    if (!messages.length) return null;
    const salt = env.MCP_ANALYTICS_SALT || env.SUPABASE_SERVICE_ROLE_KEY || "";
    const events = buildEvents(messages, Object.assign({ salt }, ctx));
    const started = Date.now();
    const chunks = [];
    let size = 0;
    return {
      capture(chunk) {
        if (size >= MAX_RESPONSE_SCAN || !chunk) return;
        const b = Buffer.from(chunk);
        chunks.push(b);
        size += b.length;
      },
      async finish(status) {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          applyOutcome(events, text, status, Date.now() - started);
          const failed = logFailures(events);
          await Promise.all([
            failed.length ? sendAlerts(failed, env) : null,
            enabled(env) ? insertRows(events.map(toRow), env) : null,
          ]);
        } catch (e) {
          console.warn(`mcp analytics error (${events.length} rows, ${events.map((x) => x.method).join(",")}):`,
            e && e.message ? e.message : e);
        }
      },
    };
  } catch (e) {
    console.warn("mcp analytics error:", e && e.message ? e.message : e);
    return null;
  }
}

module.exports = {
  begin,
  waitUntil,
  severity,
  logFailures,
  sendAlerts,
  _resetAlertThrottle,
  setSink,
  enabled,
  parseRequests,
  buildEvents,
  parseResponses,
  applyOutcome,
  tokenSubject,
  clientHash,
  toRow,
};
