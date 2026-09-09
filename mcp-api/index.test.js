// node --test mcp-api/
//
// Drives the MCP server two ways:
//   1. Through the real MCP SDK over an in-memory transport (tool list,
//      annotations, structured output, resources, prompts).
//   2. Through the Vercel entry point with a fake Node req/res so the
//      mcp-handler + Streamable HTTP plumbing is exercised end to end.
// No network: the tools under test are the pure ones.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

const handler = require("./index.js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const GOOD = {
  schemaVersion: "0.1.0", programId: "pancakes", name: "Pancakes",
  tracks: [
    { trackId: "batter", name: "Batter", steps: [
      { stepId: "mix", name: "Mix batter", task: "prep", duration: { type: "fixed", seconds: 300 }, startTrigger: { type: "programStart" } },
      { stepId: "rest", name: "Rest batter", task: "counter", duration: { type: "fixed", seconds: "10m" }, startTrigger: { type: "afterStep", stepId: "mix" } },
    ] },
    { trackId: "griddle", name: "Griddle", steps: [
      { stepId: "heat", name: "Heat griddle", task: "stove", duration: { type: "fixed", seconds: 300 }, startTrigger: { type: "afterStep", stepId: "rest", offsetSeconds: -300 } },
      { stepId: "cook", name: "Cook pancakes", task: "stove", duration: { type: "variable", minSeconds: 600, maxSeconds: 1200, defaultSeconds: 900 }, startTrigger: { type: "afterStep", stepId: "rest" } },
    ] },
  ],
  resourceConstraints: [{ task: "prep", maxConcurrent: 1 }, { task: "counter", maxConcurrent: 1 }, { task: "stove", maxConcurrent: 1 }],
  metadata: { thumbnail: "https://example.com/p.jpg", ingredients: [{ name: "flour", measure: "2 cups" }], serves: "4", custom: { keep: true } },
};

const _open = [];
async function connect(vertical) {
  const server = new McpServer({ name: "test", version: "0" }, { instructions: handler._serverInstructions(vertical) });
  handler._registerAll(server, vertical);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  _open.push(client, server);
  return { client, server };
}

test.after(async () => {
  for (const c of _open) { try { await c.close(); } catch (_) { /* ignore */ } }
  // mcp-handler keeps a few timers alive after stateless requests; don't
  // let them hold the test process open once every test has reported.
  setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
});

test("generic endpoint lists the core tool surface with annotations", async () => {
  const { client } = await connect("generic");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ["validate_program", "analyze_schedule", "visualize_schedule", "preview_timeline",
                   "search_public_recipes", "load_public_recipe", "import_from_source", "create_environment",
                   "login", "list_my_programs", "load_program", "save_program", "get_renderer_source"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  assert.ok(!names.includes("cook_recipe"));
  const vp = tools.find((t) => t.name === "validate_program");
  assert.equal(vp.annotations.readOnlyHint, true);
  assert.equal(vp.annotations.openWorldHint, false);
  assert.ok(vp.outputSchema && vp.outputSchema.properties.valid);
  const vs = tools.find((t) => t.name === "visualize_schedule");
  assert.equal(vs.annotations.readOnlyHint, false);
  assert.equal(vs.annotations.destructiveHint, false);
  assert.ok(vs.title);
  assert.ok(vs.inputSchema.properties.program);
  const instr = client.getInstructions();
  assert.ok(instr && instr.includes("validate_program"));
});

test("vertical endpoints add their one-shot + random tools", async () => {
  for (const [vertical, oneShot, random] of [
    ["kitchen", "cook_recipe", "whats_for_dinner"],
    ["lab", "run_protocol", "random_protocol"],
    ["events", "plan_event", "random_event_template"],
    ["gym", "start_workout", "surprise_workout"],
  ]) {
    const { client } = await connect(vertical);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes(oneShot), `${vertical} missing ${oneShot}`);
    assert.ok(names.includes(random), `${vertical} missing ${random}`);
  }
});

test("validate_program returns structured findings", async () => {
  const { client } = await connect("generic");
  const ok = await client.callTool({ name: "validate_program", arguments: { program: GOOD } });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.structuredContent.valid, true);
  assert.ok(ok.content[0].text.startsWith("✅"));

  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.tracks[1].steps[1].startTrigger.stepId = "missing";
  delete bad.resourceConstraints;
  const res = await client.callTool({ name: "validate_program", arguments: { program: bad } });
  assert.equal(res.structuredContent.valid, false);
  const codes = res.structuredContent.errors.map((e) => e.code);
  assert.ok(codes.includes("dangling_step_ref"));
  assert.ok(codes.includes("task_not_constrained"));
  assert.ok(res.structuredContent.errors.every((e) => typeof e.fix === "string" || e.fix === null));
});

test("analyze_schedule returns wall-clock itinerary when finishAt is given", async () => {
  const { client } = await connect("kitchen");
  const res = await client.callTool({ name: "analyze_schedule", arguments: { program: GOOD, finishAt: "2026-11-26T18:00:00Z" } });
  assert.equal(res.isError, undefined);
  const a = res.structuredContent;
  // mix 0-300, rest 300-900, heat 600-900 (negative offset honored), cook 900-1800
  assert.equal(a.makespanSeconds, 1800);
  assert.equal(a.wallClock.finishAt, "2026-11-26T18:00:00.000Z");
  assert.equal(a.wallClock.startAt, "2026-11-26T17:30:00.000Z");
  assert.deepEqual(a.criticalPath, ["mix", "rest", "cook"]);
  assert.equal(a.resourceConflicts.length, 0);
  assert.ok(res.content[0].text.includes("Wall-clock itinerary"));
  assert.ok(a.validation.warnings.some((w) => w.code === "negative_offset_on_fixed"));
});

test("visualize_schedule refuses invalid programs before touching the network", async () => {
  const { client } = await connect("generic");
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.tracks[0].steps.push({ stepId: "mix", name: "dup", task: "prep", duration: { type: "fixed", seconds: 1 }, startTrigger: { type: "programStart" } });
  const res = await client.callTool({ name: "visualize_schedule", arguments: { program: bad } });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("duplicate_step_id"));
});

test("Program zod schema keeps unknown keys (thumbnail, choice, replicates, custom metadata)", () => {
  const p = JSON.parse(JSON.stringify(GOOD));
  p.tracks[0].steps[0].choice = { prompt: "?", options: [{ choiceId: "a", label: "A" }, { choiceId: "b", label: "B" }] };
  p.tracks[0].steps[0].replicates = { count: 2, mode: "stagger", delay: "1m" };
  p.tracks[1].steps[0].startTrigger = { type: "afterStepWithBuffer", stepId: "rest", bufferSeconds: "30s", event: "end" };
  const parsed = handler._schemas.Program.parse(p);
  assert.equal(parsed.metadata.thumbnail, "https://example.com/p.jpg");
  assert.deepEqual(parsed.metadata.custom, { keep: true });
  assert.equal(parsed.tracks[0].steps[0].choice.options.length, 2);
  assert.equal(parsed.tracks[0].steps[0].replicates.delay, "1m");
  assert.equal(parsed.tracks[1].steps[0].startTrigger.bufferSeconds, "30s");
  assert.equal(parsed.tracks[0].steps[1].duration.seconds, "10m");
});

test("import_from_source explains login instead of surfacing a 401", async () => {
  const { client } = await connect("kitchen");
  const res = await client.callTool({ name: "import_from_source", arguments: { source: "spoonacular", action: "import", query: "12345" } });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("login"));
  const b = await client.callTool({ name: "import_from_source", arguments: { source: "benchling", action: "search", query: "pcr" } });
  assert.equal(b.isError, true);
});

test("create_environment is pure and echoes constraints", async () => {
  const { client } = await connect("lab");
  const res = await client.callTool({ name: "create_environment", arguments: {
    name: "Small Biotech Lab", type: "laboratory", actors: 2,
    resourceConstraints: [{ task: "thermal-cycler", maxConcurrent: 4 }, { task: "centrifuge", maxConcurrent: 1 }],
  } });
  assert.equal(res.isError, undefined);
  assert.ok(res.content[0].text.includes("small-biotech-lab"));
  assert.ok(res.content[0].text.includes("thermal-cycler: max 4"));
});

test("resources expose schema, guide and examples", async () => {
  const { client } = await connect("generic");
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes("rhylthyme://schema/program"));
  assert.ok(uris.includes("rhylthyme://guide/authoring"));
  assert.ok(uris.some((u) => u.startsWith("rhylthyme://examples/")));
  const schema = await client.readResource({ uri: "rhylthyme://schema/program" });
  const parsed = JSON.parse(schema.contents[0].text);
  assert.ok(parsed.properties && parsed.properties.tracks);
  const guide = await client.readResource({ uri: "rhylthyme://guide/authoring" });
  assert.ok(guide.contents[0].text.includes("afterStepWithBuffer"));
  const ex = await client.readResource({ uri: "rhylthyme://examples/breakfast_schedule" });
  assert.ok(JSON.parse(ex.contents[0].text).tracks.length > 0);
});

test("plan_schedule prompt renders with arguments", async () => {
  const { client } = await connect("events");
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "plan_schedule"));
  const res = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "wedding at 2pm", finishAt: "2026-06-06T22:00:00Z" } });
  const text = res.messages[0].content.text;
  assert.ok(text.includes("wedding at 2pm"));
  assert.ok(text.includes("plan_event"));
  assert.ok(text.includes("finishAt=\"2026-06-06T22:00:00Z\""));
});

test("formatProgramSummary uses the resolved makespan, not summed track durations", () => {
  const md = handler._formatProgramSummary(GOOD, "https://kitchen.rhylthyme.com/?share=x", { vertical: "kitchen" });
  assert.ok(md.includes("**Time:** 30min"), md.split("\n").find((l) => l.includes("Time")));
  assert.ok(md.includes("![Pancakes](https://example.com/p.jpg)"));
  assert.ok(md.includes("## Timeline"));
  assert.ok(md.includes("## Itinerary"));
  assert.equal(handler._programTotalSec(GOOD), 1800);
});

test("detectVertical + verticalizeUrl", () => {
  assert.equal(handler._detectVertical("/kitchen/mcp", "www.rhylthyme.com"), "kitchen");
  assert.equal(handler._detectVertical("/mcp", "lab.rhylthyme.com"), "lab");
  assert.equal(handler._detectVertical("/mcp", "mcp.rhylthyme.com"), "generic");
  assert.equal(handler._verticalizeUrl("https://www.rhylthyme.com?share=abc", "gym"), "https://gym.rhylthyme.com?share=abc");
  assert.equal(handler._verticalizeUrl("https://www.rhylthyme.com?share=abc", "generic"), "https://www.rhylthyme.com?share=abc");
});

// ---- Vercel entry point through mcp-handler ------------------------------

// A Readable (like a real IncomingMessage) buffers the body until the
// handler attaches a 'data' listener, which may happen after an await.
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
  res.done = new Promise((resolve) => { res.end = (c) => { if (c) res.chunks.push(Buffer.from(c)); resolve(); }; });
  res.text = () => Buffer.concat(res.chunks).toString("utf8");
  return res;
}

// Streamable HTTP responses may come back as SSE; pull the JSON out.
function parseRpc(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const dataLines = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  assert.ok(dataLines.length, `no JSON in response: ${t.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]);
}

test("HTTP entry: initialize on /kitchen/mcp advertises the kitchen server + instructions", async () => {
  const req = fakeReq("POST", "/kitchen/mcp", {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  const res = fakeRes();
  await handler(req, res);
  await res.done;
  assert.equal(res.statusCode, 200, res.text());
  const rpc = parseRpc(res.text());
  assert.equal(rpc.result.serverInfo.name, "rhylthyme-kitchen-mcp");
  assert.ok(rpc.result.instructions.includes("cook_recipe"));
  assert.ok(rpc.result.capabilities.tools);
  assert.ok(rpc.result.capabilities.resources);
  assert.ok(rpc.result.capabilities.prompts);
});

test("HTTP entry: tools/call validate_program over Streamable HTTP", async () => {
  const req = fakeReq("POST", "/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "validate_program", arguments: { program: GOOD } },
  });
  const res = fakeRes();
  await handler(req, res);
  await res.done;
  assert.equal(res.statusCode, 200, res.text());
  const rpc = parseRpc(res.text());
  assert.equal(rpc.result.structuredContent.valid, true);
});
