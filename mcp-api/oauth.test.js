// node --test mcp-api/oauth.test.js
//
// OAuth 2.1 resource-server behaviour: discovery documents, the step-up 401
// challenge, and a bearer token in the header reaching the tool that needs
// it. No network: fetch is replaced.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://proj.supabase.co";
const OAuth = require("./oauth.js");
const handler = require("./index.js");

test.after(() => {
  // mcp-handler keeps timers alive after stateless requests (see index.test.js).
  setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
});

const ENV = { SUPABASE_URL: "https://proj.supabase.co" };
// The HTTP tests run with the authorization server "on"; one test turns it off.
test.beforeEach(() => OAuth._setReady(true));
const jwt = (payload) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256" })}.${b64(payload)}.sig`;
};
const LIVE = jwt({ sub: "11111111-2222-3333-4444-555555555555", exp: Math.floor(Date.now() / 1000) + 3600 });
const EXPIRED = jwt({ sub: "11111111-2222-3333-4444-555555555555", exp: Math.floor(Date.now() / 1000) - 60 });

function fakeReq(method, url, body, headers) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = Object.assign({
    host: "mcp.rhylthyme.com", "content-type": "application/json", accept: "application/json, text/event-stream",
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
  res.text = () => Buffer.concat(res.chunks).toString("utf8");
  res.json = () => {
    const t = res.text().trim();
    if (t.startsWith("{")) return JSON.parse(t);
    return JSON.parse(t.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5));
  };
  return res;
}
const call = (name, args, id) => ({ jsonrpc: "2.0", id: id || 1, method: "tools/call", params: { name, arguments: args || {} } });

test("issuer and metadata URLs follow RFC 8414's path-insertion rule", () => {
  assert.equal(OAuth.issuer(ENV), "https://proj.supabase.co/auth/v1");
  assert.equal(OAuth.authorizationServerMetadataUrl(ENV), "https://proj.supabase.co/.well-known/oauth-authorization-server/auth/v1");
  assert.equal(OAuth.issuer({ MCP_OAUTH_ISSUER: "https://id.example/" }), "https://id.example");
  assert.equal(OAuth.enabled({}), false);
  assert.equal(OAuth.enabled(Object.assign({ MCP_OAUTH_DISABLED: "1" }, ENV)), false);
});

test("protected-resource metadata names the endpoint asked about and Supabase as the authorization server", () => {
  const meta = (url, host) => OAuth.protectedResourceMetadata({ url, headers: { host: host || "mcp.rhylthyme.com" } }, ENV);
  assert.deepEqual(meta("/.well-known/oauth-protected-resource").authorization_servers, ["https://proj.supabase.co/auth/v1"]);
  assert.equal(meta("/.well-known/oauth-protected-resource").resource, "https://mcp.rhylthyme.com/mcp");
  assert.equal(meta("/.well-known/oauth-protected-resource/lab/mcp").resource, "https://mcp.rhylthyme.com/lab/mcp");
  assert.equal(meta("/.well-known/oauth-protected-resource/mcp", "kitchen.rhylthyme.com").resource, "https://kitchen.rhylthyme.com/mcp");
  assert.equal(meta("/.well-known/oauth-protected-resource/../../etc").resource, "https://mcp.rhylthyme.com/mcp", "junk paths fall back");
  assert.deepEqual(meta("/.well-known/oauth-protected-resource").bearer_methods_supported, ["header"]);
});

test("bearer parsing and expiry", () => {
  assert.equal(OAuth.bearerFrom({ authorization: "Bearer abc.def.ghi" }), "abc.def.ghi");
  assert.equal(OAuth.bearerFrom({ authorization: "bearer  x " }), "x");
  assert.equal(OAuth.bearerFrom({ authorization: "Basic Zm9v" }), null);
  assert.equal(OAuth.bearerFrom({}), null);
  assert.equal(OAuth.isExpired(EXPIRED), true);
  assert.equal(OAuth.isExpired(LIVE), false);
  assert.equal(OAuth.isExpired("opaque-token"), false, "unreadable tokens are left to the API");
});

test("which calls need an account", () => {
  for (const t of ["list_my_programs", "load_program", "save_program", "list_runs", "load_run", "calibrate_program", "import_text", "review_program"]) {
    assert.equal(OAuth.needsAccount(t, {}), true, t);
  }
  for (const t of ["validate_program", "analyze_schedule", "visualize_schedule", "search_public_recipes", "login", "cook_recipe"]) {
    assert.equal(OAuth.needsAccount(t, {}), false, t);
  }
  assert.equal(OAuth.needsAccount("import_from_source", { action: "search" }), false);
  assert.equal(OAuth.needsAccount("import_from_source", { action: "import" }), true);
  assert.equal(OAuth.needsAccount("import_from_source", { source: "benchling", action: "search" }), true);
});

test("the gate challenges only account calls that carry no credential", () => {
  const req = (headers) => ({ url: "/lab/mcp", headers: Object.assign({ host: "mcp.rhylthyme.com" }, headers || {}) });
  const body = (m) => Buffer.from(JSON.stringify(m));
  assert.equal(OAuth.gate(req(), body(call("validate_program", { program: {} })), ENV), null, "public tools stay anonymous");
  assert.equal(OAuth.gate(req(), body({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ENV), null);
  assert.equal(OAuth.gate(req(), body(call("list_my_programs", { token: "pasted" })), ENV), null, "a pasted token still works");
  assert.equal(OAuth.gate(req({ authorization: "Bearer " + LIVE }), body(call("list_my_programs")), ENV), null);
  assert.equal(OAuth.gate(req(), body(call("list_my_programs")), {}), null, "gate is off when OAuth is not configured");

  const denied = OAuth.gate(req(), body(call("list_my_programs", {}, 7)), ENV);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers["WWW-Authenticate"],
    'Bearer resource_metadata="https://mcp.rhylthyme.com/.well-known/oauth-protected-resource/lab/mcp", error_description="list_my_programs needs the user\'s Rhylthyme account"');
  assert.equal(JSON.parse(denied.body).id, 7);

  const expired = OAuth.gate(req({ authorization: "Bearer " + EXPIRED }), body(call("save_program", { program: {} })), ENV);
  assert.equal(expired.status, 401);
  assert.match(expired.headers["WWW-Authenticate"], /error="invalid_token"/);
});

test("HTTP entry: discovery documents", async () => {
  const res = fakeRes();
  await handler(fakeReq("GET", "/.well-known/oauth-protected-resource/kitchen/mcp"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  const meta = JSON.parse(res.text());
  assert.equal(meta.resource, "https://mcp.rhylthyme.com/kitchen/mcp");
  assert.deepEqual(meta.authorization_servers, [OAuth.issuer()]);

  const realFetch = global.fetch;
  let fetched = null;
  global.fetch = async (url) => { fetched = String(url); return { ok: true, json: async () => ({ issuer: OAuth.issuer(), token_endpoint: "t" }) }; };
  try {
    const as = fakeRes();
    await handler(fakeReq("GET", "/.well-known/oauth-authorization-server"), as);
    assert.equal(as.statusCode, 200);
    assert.equal(fetched, OAuth.authorizationServerMetadataUrl());
    assert.equal(JSON.parse(as.text()).token_endpoint, "t");
  } finally { global.fetch = realFetch; }

  const pre = fakeRes();
  await handler(fakeReq("OPTIONS", "/.well-known/oauth-protected-resource"), pre);
  assert.equal(pre.statusCode, 204);
});

test("HTTP entry: an account tool with no credential gets 401, a public tool does not", async () => {
  const denied = fakeRes();
  await handler(fakeReq("POST", "/mcp", call("list_my_programs")), denied);
  assert.equal(denied.statusCode, 401);
  assert.match(denied.headers["www-authenticate"], /^Bearer resource_metadata="https:\/\/mcp\.rhylthyme\.com\/\.well-known\/oauth-protected-resource\/mcp"/);

  const open = fakeRes();
  await handler(fakeReq("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }), open);
  assert.equal(open.statusCode, 200);
  const tools = open.json().result.tools;
  for (const name of ["list_my_programs", "load_program", "save_program"]) {
    const schema = tools.find((t) => t.name === name).inputSchema;
    assert.ok(!(schema.required || []).includes("token"), `${name}: token must be optional so a connected account needs none`);
  }
});

test("HTTP entry: the bearer token in the header reaches the API call the tool makes", async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init && init.headers && init.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ programs: [] }), text: async () => "{}" };
  };
  try {
    const res = fakeRes();
    await handler(fakeReq("POST", "/mcp", call("list_my_programs"), { authorization: "Bearer " + LIVE }), res);
    assert.equal(res.statusCode, 200, res.text());
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/api\/mcp\/programs$/);
    assert.equal(seen[0].auth, "Bearer " + LIVE);

    // An explicit `token` argument wins over the header (the CLI's path).
    seen.length = 0;
    await handler(fakeReq("POST", "/mcp", call("list_my_programs", { token: "pasted-token" }), { authorization: "Bearer " + LIVE }), fakeRes());
    assert.equal(seen[0].auth, "Bearer pasted-token");
  } finally { global.fetch = realFetch; }
});

test("tokens do not leak between concurrent requests", async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    seen.push(init.headers.Authorization);
    return { ok: true, status: 200, json: async () => ({ programs: [] }), text: async () => "{}" };
  };
  try {
    const tokens = Array.from({ length: 8 }, (_, i) => jwt({ sub: `user-${i}`, exp: Math.floor(Date.now() / 1000) + 3600 }));
    await Promise.all(tokens.map((t, i) =>
      handler(fakeReq("POST", "/mcp", call("list_my_programs", {}, i + 1), { authorization: "Bearer " + t }), fakeRes())));
    assert.deepEqual(seen.slice().sort(), tokens.map((t) => "Bearer " + t).sort(), "each request used exactly its own token");
  } finally { global.fetch = realFetch; }
});

test("no challenge while the authorization server is switched off", async () => {
  const realFetch = global.fetch;
  let probes = 0;
  OAuth._setReady(null);
  global.fetch = async (url) => {
    if (String(url) === OAuth.authorizationServerMetadataUrl()) {
      probes += 1;
      return { ok: false, status: 404, json: async () => ({ error_code: "feature_disabled" }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  try {
    assert.equal(await OAuth.authorizationServerReady(), false);
    for (let i = 0; i < 3; i++) {
      const res = fakeRes();
      await handler(fakeReq("POST", "/mcp", call("list_my_programs")), res);
      assert.equal(res.statusCode, 200, "falls through to the tool, which explains the pasted-token login");
      assert.match(res.text(), /login/i);
    }
    assert.equal(probes, 1, "the answer is cached, not re-probed per request");

    // Switched on: a fresh probe sees real metadata and challenges resume.
    OAuth._setReady(null);
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ authorization_endpoint: "a", token_endpoint: "t" }) });
    const res = fakeRes();
    await handler(fakeReq("POST", "/mcp", call("list_my_programs")), res);
    assert.equal(res.statusCode, 401);
  } finally { global.fetch = realFetch; }
});
