// node --test mcp-api/listen-timeout.test.js
//
// subscriptions/listen (MCP 2026-07-28) opens an SSE stream the SDK never
// ends by itself. Before this test existed every such POST ran until Vercel
// killed the function at 300 s. The stream must end at MCP_LISTEN_MAX_MS,
// and the handler must return as soon as the client disconnects.
"use strict";

process.env.MCP_LISTEN_MAX_MS = "1500";
process.env.MCP_OAUTH_DISABLED = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const handler = require("./index.js");

test.after(() => {
  // mcp-handler keeps timers alive after stateless requests (see index.test.js).
  setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
});

const LISTEN = JSON.stringify({
  jsonrpc: "2.0",
  id: "listen:0",
  method: "subscriptions/listen",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "listen-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
    notifications: { toolsListChanged: true },
  },
});
const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-method": "subscriptions/listen",
  "mcp-protocol-version": "2026-07-28",
};

function serve() {
  const settled = [];
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    await handler(req, res);
    settled.push(Date.now() - t0);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, settled, port: server.address().port })));
}

function post(port, body, headers, { abortAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], text, ms: Date.now() - t0 }));
      res.on("error", () => resolve({ aborted: true, ms: Date.now() - t0 }));
      if (abortAfterMs && res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      if (abortAfterMs) setTimeout(() => { req.destroy(); resolve({ aborted: true, ms: Date.now() - t0 }); }, abortAfterMs);
    });
    req.on("error", (e) => (abortAfterMs ? null : reject(e)));
    req.end(body);
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return fn();
}

test("a listen stream ends at MCP_LISTEN_MAX_MS and the handler returns", async () => {
  const { server, settled, port } = await serve();
  try {
    const r = await post(port, LISTEN, HEADERS);
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/event-stream/);
    assert.match(r.text, /subscriptions\/acknowledged/);
    assert.ok(r.ms >= 1400 && r.ms < 5000, `stream lasted ${r.ms} ms`);
    assert.ok(await waitFor(() => settled.length === 1, 2000), "handler never returned");
  } finally {
    server.close();
  }
});

test("the handler returns when the client disconnects from a listen stream", async () => {
  const { server, settled, port } = await serve();
  try {
    process.env.MCP_LISTEN_MAX_MS = "60000";
    await post(port, LISTEN, HEADERS, { abortAfterMs: 300 });
    assert.ok(await waitFor(() => settled.length === 1, 2000), "handler still running after the client left");
    assert.ok(settled[0] < 2000, `handler took ${settled[0]} ms`);
  } finally {
    process.env.MCP_LISTEN_MAX_MS = "1500";
    server.close();
  }
});

test("ordinary requests are not cut short", async () => {
  const { server, port } = await serve();
  try {
    const r = await post(port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    });
    assert.equal(r.status, 200);
    assert.match(r.text, /visualize_schedule/);
    assert.ok(r.ms < 1500);
  } finally {
    server.close();
  }
});
