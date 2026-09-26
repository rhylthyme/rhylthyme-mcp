// node --test mcp-api/analytics.test.js
//
// Usage analytics: request parsing, privacy of the recorded row, outcome
// detection from JSON and SSE bodies, and the Vercel entry point writing
// rows through a test sink (no network).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

const Analytics = require("./analytics.js");
const handler = require("./index.js");

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}
const UID = "11111111-2222-3333-4444-555555555555";

test.after(() => {
  // mcp-handler keeps timers alive after stateless requests (see index.test.js).
  setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
});

test("parseRequests keeps requests, drops notifications, pings and junk", () => {
  const body = Buffer.from(JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "validate_program" } },
  ]));
  assert.deepEqual(Analytics.parseRequests(body).map((m) => m.method), ["initialize", "tools/call"]);
  assert.deepEqual(Analytics.parseRequests(Buffer.from("not json")), []);
  assert.deepEqual(Analytics.parseRequests(undefined), []);
});

test("buildEvents records client info on initialize", () => {
  const [ev] = Analytics.buildEvents(
    [{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai", version: "0.1.0" } } }],
    { vertical: "lab", salt: "s", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "Claude-User", "x-vercel-ip-country": "US" } },
  );
  assert.equal(ev.endpoint, "lab");
  assert.equal(ev.method, "initialize");
  assert.equal(ev.client_name, "claude-ai");
  assert.equal(ev.client_version, "0.1.0");
  assert.equal(ev.protocol_version, "2025-06-18");
  assert.equal(ev.country, "US");
  assert.equal(ev.client_hash, Analytics.clientHash("203.0.113.9", "Claude-User", "s"));
});

test("buildEvents reads client info from the 2026-07-28 per-request _meta", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "Anthropic/ClaudeAI", version: "1.0.0" },
  };
  const [discover, call] = Analytics.buildEvents(
    [{ id: 1, method: "server/discover", params: { _meta: meta } },
     { id: 2, method: "tools/call", params: { name: "validate_program", arguments: { program: {} }, _meta: meta } }],
    { vertical: "generic", salt: "s", headers: {} },
  );
  for (const ev of [discover, call]) {
    assert.equal(ev.client_name, "Anthropic/ClaudeAI");
    assert.equal(ev.client_version, "1.0.0");
    assert.equal(ev.protocol_version, "2026-07-28");
  }
  assert.equal(call.tool, "validate_program");
});

test("tools/call rows keep safe fields only — never argument values, IPs or tokens", () => {
  const token = jwt({ sub: UID });
  const [ev] = Analytics.buildEvents(
    [{ id: 7, method: "tools/call", params: { name: "import_from_source", arguments: {
      source: "protocolsio", action: "import", query: "my secret protocol", token, enrich: true,
      program: { name: "Private" },
    } } }],
    { vertical: "generic", salt: "s", headers: { "x-forwarded-for": "198.51.100.4", "user-agent": "ua" } },
  );
  assert.equal(ev.tool, "import_from_source");
  assert.equal(ev.user_id, UID);
  assert.deepEqual(ev.detail, { argKeys: ["action", "enrich", "program", "query", "source", "token"], source: "protocolsio", action: "import", enrich: true });
  const serialized = JSON.stringify(Analytics.toRow(ev));
  for (const secret of ["my secret protocol", token, "198.51.100.4", "Private"]) {
    assert.ok(!serialized.includes(secret), `row leaked ${secret}`);
  }
  assert.ok(!("rpc_id" in Analytics.toRow(ev)));
  assert.ok(!("error_message" in Analytics.toRow(Object.assign({ error_message: "secret step name" }, ev))));
});

test("tokenSubject tolerates bearer prefixes and rejects malformed tokens", () => {
  assert.equal(Analytics.tokenSubject("Bearer " + jwt({ sub: UID })), UID);
  assert.equal(Analytics.tokenSubject(jwt({ sub: "not-a-uuid" })), null);
  assert.equal(Analytics.tokenSubject("abc"), null);
  assert.equal(Analytics.tokenSubject(undefined), null);
});

test("clientHash is stable per salt and differs across salts", () => {
  const a = Analytics.clientHash("1.2.3.4", "ua", "x");
  assert.equal(a, Analytics.clientHash("1.2.3.4", "ua", "x"));
  assert.notEqual(a, Analytics.clientHash("1.2.3.4", "ua", "y"));
  assert.equal(a.length, 32);
  assert.equal(Analytics.clientHash(null, null, "x"), null);
});

test("applyOutcome reads JSON and SSE responses and classifies errors", () => {
  const mk = (id) => ({ rpc_id: id });
  const sse = [
    "event: message",
    `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })}`,
    "",
    "event: message",
    `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [] } })}`,
    "",
    `data: ${JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "bad" } })}`,
  ].join("\n");
  const evs = Analytics.applyOutcome([mk(1), mk(2), mk(3), mk(4)], sse, 200, 12.4);
  assert.deepEqual(evs.map((e) => [e.ok, e.error_code]), [[true, null], [false, "tool_error"], [false, "rpc_-32602"], [null, null]]);
  assert.equal(evs[0].duration_ms, 12);
  assert.equal(evs[0].http_status, 200);

  const [j] = Analytics.applyOutcome([mk("a")], JSON.stringify({ jsonrpc: "2.0", id: "a", result: {} }), 200, 1);
  assert.equal(j.ok, true);
  const [h] = Analytics.applyOutcome([mk(1)], "", 406, 1);
  assert.deepEqual([h.ok, h.error_code], [false, "http_406"]);
});

test("without Supabase credentials nothing is written, but failures are still logged", async () => {
  Analytics.setSink(null);
  assert.equal(Analytics.enabled({}), false);
  assert.equal(Analytics.enabled({ SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k", MCP_ANALYTICS_DISABLED: "1" }), false);
  assert.equal(Analytics.enabled({ SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" }), true);
  assert.equal(Analytics.begin(Buffer.from("junk"), { vertical: "generic", headers: {} }, {}), null);

  const realFetch = global.fetch, realError = console.error;
  const lines = []; let fetched = 0;
  global.fetch = async () => { fetched++; return { ok: true }; };
  console.error = (l) => lines.push(l);
  try {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_text" } }));
    const t = Analytics.begin(body, { vertical: "lab", headers: { "user-agent": "claude-ai" } }, {});
    t.capture(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Text import failed (502):\n boom" }] } })));
    await t.finish(200);
  } finally { global.fetch = realFetch; console.error = realError; }
  assert.equal(fetched, 0, "no webhook, no Supabase: no network");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[mcp-error\] /);
  const logged = JSON.parse(lines[0].slice("[mcp-error] ".length));
  assert.deepEqual([logged.endpoint, logged.tool, logged.code, logged.message], ["lab", "import_text", "tool_error", "Text import failed (502): boom"]);
});

test("severity separates broken from expected", () => {
  const sev = (o) => Analytics.severity(Object.assign({ ok: false, method: "tools/call" }, o));
  assert.equal(Analytics.severity({ ok: true }), null);
  assert.equal(Analytics.severity({ ok: null }), null);
  assert.equal(sev({ error_code: "tool_error", error_message: "Text import failed (502)" }), "alert");
  assert.equal(sev({ error_code: "tool_error", error_message: "import_text requires the user's Rhylthyme access token. Call **login**" }), "warn");
  assert.equal(sev({ error_code: "tool_error", error_message: "Save failed: not authorized (401). The token may have expired" }), "warn");
  assert.equal(sev({ error_code: "http_500" }), "alert");
  assert.equal(sev({ error_code: "rpc_-32603" }), "alert");
  assert.equal(sev({ error_code: "rpc_-32602" }), "alert");
  assert.equal(sev({ error_code: "rpc_-32602", method: "prompts/get" }), "warn");
  assert.equal(sev({ error_code: "rpc_-32601", method: "server/discover" }), "warn");
  assert.equal(sev({ error_code: "http_406" }), "warn");
  // The account refusal as it reads since OAuth.
  assert.equal(sev({ error_code: "tool_error", error_message: "save_program requires the user's Rhylthyme account. If this app can connect accounts" }), "warn");
});

test("a caller's mistake is a warning: tagged input errors and empty-argument probes", () => {
  const sev = (o) => Analytics.severity(Object.assign({ ok: false, method: "tools/call", error_code: "tool_error" }, o));
  // What paged on 2026-09-21: a scanner called import_from_source with an action and no query.
  assert.equal(sev({ error_kind: "input", error_message: "action='search' needs `query`", detail: { argKeys: ["action", "source"] } }), "warn");
  // No arguments at all (a token does not count): a probe, whatever the tool said.
  assert.equal(sev({ error_message: "Couldn't find a program with that id", detail: { argKeys: [] } }), "warn");
  // ...unless what it said is that something behind us failed.
  assert.equal(sev({ error_message: "Text import failed (502)", detail: { argKeys: [] } }), "alert");
  assert.equal(sev({ error_kind: "input", error_message: "Catalog search timed out", detail: { argKeys: ["query"] } }), "alert");
  assert.equal(sev({ error_message: "anything", detail: { argKeys: ["token"] } }), "warn");
  assert.equal(sev({ error_code: "rpc_-32602", detail: { argKeys: [] } }), "warn");
  // Real arguments and an untagged failure still page.
  assert.equal(sev({ error_message: "Text import failed (502)", detail: { argKeys: ["text", "environmentType"] } }), "alert");
  assert.equal(sev({ error_code: "rpc_-32602", detail: { argKeys: ["program"] } }), "alert");
  assert.equal(sev({ error_code: "http_500", detail: { argKeys: [] } }), "alert", "a 5xx is ours even on a probe");
});

test("the input tag travels from the tool result to the event and never reaches the table", () => {
  const ev = { rpc_id: 1, method: "tools/call", tool: "import_from_source", detail: { argKeys: ["action", "source"] } };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "action='search' needs `query`" }], _meta: { [Analytics.ERROR_KIND_META]: "input" } } });
  Analytics.applyOutcome([ev], body, 200, 15);
  assert.equal(ev.error_code, "tool_error");
  assert.equal(ev.error_kind, "input");
  assert.equal(Analytics.severity(ev), "warn");
  const row = Analytics.toRow(ev);
  assert.ok(!("error_kind" in row) && !("error_message" in row) && !("rpc_id" in row));
});

test("alerts go to the webhook once per signature, skip warnings and mcp-test traffic", async () => {
  Analytics._resetAlertThrottle();
  const realFetch = global.fetch;
  const posts = [];
  global.fetch = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  const env = { SLACK_FEEDBACK_WEBHOOK_URL: "https://hooks.example/x" };
  const ev = (o) => ({ ev: Object.assign({ endpoint: "lab", method: "tools/call", tool: "import_text", error_code: "tool_error",
    error_message: "Text import failed (502)", duration_ms: 12, user_agent: "claude-ai", client_hash: "abcdef123456", country: "US" }, o), level: "alert" });
  try {
    const t0 = 1_000_000;
    assert.equal(await Analytics.sendAlerts([ev({})], env, t0), 1);
    assert.equal(await Analytics.sendAlerts([ev({}), ev({})], env, t0 + 60_000), 0, "same signature inside the window");
    assert.equal(await Analytics.sendAlerts([{ ev: ev({}).ev, level: "warn" }], env, t0 + 61_000), 0, "warnings never alert");
    assert.equal(await Analytics.sendAlerts([ev({ tool: "save_program", user_agent: "rhylthyme-cli/0.2 mcp-test" })], env, t0 + 62_000), 0);
    assert.equal(await Analytics.sendAlerts([ev({ tool: "save_program" })], env, t0 + 5_000), 0, "global minimum gap");
    assert.equal(await Analytics.sendAlerts([ev({})], env, t0 + 16 * 60_000), 1, "window elapsed");
    assert.equal(await Analytics.sendAlerts([ev({ tool: "visualize_schedule" })], {}, t0 + 40 * 60_000), 0, "no webhook configured");
  } finally { global.fetch = realFetch; Analytics._resetAlertThrottle(); }
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, "https://hooks.example/x");
  assert.match(posts[0].body.text, /MCP error\* on `\/lab\/mcp`: `tools\/call import_text` failed with `tool_error`/);
  assert.match(posts[0].body.text, /Text import failed \(502\)/);
  assert.match(posts[1].body.text, /2 more like this since the last alert/);
});

test("a failing sink never breaks the tracker", async () => {
  Analytics.setSink(() => { throw new Error("db down"); });
  try {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const t = Analytics.begin(body, { vertical: "generic", headers: {} }, {});
    t.capture(Buffer.from("{}"));
    await t.finish(200); // must resolve
  } finally {
    Analytics.setSink(null);
  }
});

test("waitUntil uses the Vercel request context when present", async () => {
  const sym = Symbol.for("@vercel/request-context");
  const prev = globalThis[sym];
  const seen = [];
  try {
    assert.equal(Analytics.waitUntil(Promise.resolve()), prev ? Analytics.waitUntil(Promise.resolve()) : false);
    globalThis[sym] = { get: () => ({ waitUntil: (p) => seen.push(p) }) };
    const p = Promise.resolve();
    assert.equal(Analytics.waitUntil(p), true);
    assert.equal(seen[0], p);
  } finally {
    globalThis[sym] = prev;
  }
});

test("insert retries once on timeout, then gives up quietly", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  };
  try {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const t = Analytics.begin(body, { vertical: "generic", headers: {} },
      { SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
    await t.finish(200);
    assert.equal(calls, 2);
  } finally {
    global.fetch = realFetch;
  }
});

// ---- through the Vercel entry point ---------------------------------------

function fakeReq(method, url, body, headers) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = Object.assign({
    host: "mcp.rhylthyme.com",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }, headers || {});
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
  req.push(null);
  return req;
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, chunks: [] };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.write = (c) => { res.chunks.push(Buffer.from(c)); };
  res.end = (c) => { if (c) res.chunks.push(Buffer.from(c)); };
  return res;
}

test("HTTP entry writes one row per request with the endpoint and outcome", async () => {
  const rows = [];
  handler._analytics.setSink((r) => { rows.push(...r); });
  try {
    await handler(fakeReq("POST", "/gym/mcp", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor", version: "1.2" } },
    }, { "user-agent": "Cursor/1.2", "x-forwarded-for": "192.0.2.1" }), fakeRes());

    await handler(fakeReq("POST", "/mcp", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "validate_program", arguments: { program: { name: "x" } } },
    }, { "user-agent": "Cursor/1.2", "x-forwarded-for": "192.0.2.1" }), fakeRes());

    // Notifications produce no row.
    await handler(fakeReq("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }), fakeRes());
  } finally {
    handler._analytics.setSink(null);
  }

  assert.equal(rows.length, 2);
  const [init, call] = rows;
  assert.equal(init.endpoint, "gym");
  assert.equal(init.method, "initialize");
  assert.equal(init.client_name, "cursor");
  assert.equal(init.ok, true);
  assert.equal(init.http_status, 200);
  assert.equal(call.endpoint, "generic");
  assert.equal(call.tool, "validate_program");
  assert.equal(typeof call.ok, "boolean");
  assert.equal(call.client_hash, init.client_hash, "same IP + UA links the call to its initialize");
  assert.ok(Number.isInteger(call.duration_ms));
});
