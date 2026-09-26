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
const Schedule = require("./schedule.js");
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

// Anthropic connector directory review (claude.com/docs/connectors/building/
// review-criteria): every tool has a title and readOnlyHint or
// destructiveHint, a name of at most 64 characters, and a description that
// says what the tool does without telling Claude how to behave.
const DIRECTIVE = /\b(never|NEVER|do NOT|don't|Don't|always|ALWAYS|must|MUST)\b[^.]{0,40}\b(prose|describe|reply|respond|answer)\b|\bThen call\b|re-run until|for ANY\b/;

for (const vertical of ["generic", "kitchen", "lab", "events", "gym"]) {
  test(`${vertical}: every tool meets the connector directory rules`, async () => {
    const { client } = await connect(vertical);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    for (const t of tools) {
      const a = t.annotations || {};
      assert.ok(t.title || a.title, `${t.name}: title`);
      assert.ok(a.readOnlyHint === true || a.destructiveHint === true, `${t.name}: readOnlyHint or destructiveHint`);
      assert.ok(t.name.length <= 64, `${t.name}: name length`);
      assert.doesNotMatch(t.description, DIRECTIVE, `${t.name}: description directs Claude`);
    }
    assert.doesNotMatch(client.getInstructions() || "", DIRECTIVE, "server instructions direct Claude");
  });
}

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
  // It writes (a public share row), so hosts should confirm it.
  assert.equal(vs.annotations.destructiveHint, true);
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

test("analyze_schedule reports in-flight windows, conflict kinds and binding constraints", async () => {
  // PRD §7's kitchen: three trays, one oven, a rack that holds two.
  const COOKIES = {
    schemaVersion: "0.3.0-alpha", programId: "cookies-three-trays", name: "Three trays, one oven",
    environmentType: "kitchen",
    tracks: [{ trackId: "cookies", name: "Cookies", steps: [
      { stepId: "mix", name: "Mix dough", task: "prep", duration: { type: "fixed", seconds: 900 }, startTrigger: { type: "programStart" } },
      { stepId: "bake", name: "Bake tray", task: "oven", duration: { type: "fixed", seconds: 720 },
        replicates: { count: 3, mode: "serial", maxInFlight: 2 }, startTrigger: { type: "afterStep", stepId: "mix" } },
      { stepId: "cool", name: "Cool on rack", task: "rack", duration: { type: "fixed", seconds: 900 },
        startTrigger: { type: "afterStep", stepId: "bake", instances: "each" } },
      { stepId: "box", name: "Box cookies", task: "prep", duration: { type: "fixed", seconds: 300 },
        startTrigger: { type: "afterStep", stepId: "cool", instances: "all" } },
    ] }],
    resourceConstraints: [{ task: "prep", maxConcurrent: 1 }, { task: "oven", maxConcurrent: 1 }, { task: "rack", maxConcurrent: 2 }],
  };
  const { client } = await connect("kitchen");
  const res = await client.callTool({ name: "analyze_schedule", arguments: { program: COOKIES } });
  assert.equal(res.isError, undefined);
  // The output schema (zod) accepts bindingConstraints, inFlight and the
  // kind-tagged conflict items, or structuredContent would not come back.
  const a = res.structuredContent;
  assert.equal(a.makespanSeconds, 4440);
  assert.deepEqual(a.criticalPath, ["mix", "bake-r1", "cool-r1", "bake-r3", "cool-r3", "box"]);
  assert.deepEqual(a.bindingConstraints.find((b) => b.to === "bake-r3"),
    { from: "cool-r1", to: "bake-r3", kind: "inFlight", task: "rack", limit: 2, inFlightOf: "bake" });
  assert.equal(a.inFlight.length, 1);
  assert.equal(a.inFlight[0].maxInFlight, 2);
  assert.deepEqual(a.inFlight[0].windows.map((w) => [w.startSeconds, w.endSeconds]), [[900, 2520], [1620, 3240], [2520, 4140]]);
  assert.deepEqual(a.resourceConflicts, []);
  assert.equal(a.tracks.find((t) => t.trackId === "cookies--bake-r1").parentTrackId, "cookies");
  assert.ok(res.content[0].text.includes("`rack` (in-flight ≤ 2) gates `bake-r3`"), res.content[0].text);
  assert.ok(res.content[0].text.includes("In-flight windows"), res.content[0].text);

  // A program with no in-flight cap keeps the fields, empty.
  const plain = await client.callTool({ name: "analyze_schedule", arguments: { program: GOOD } });
  assert.deepEqual(plain.structuredContent.inFlight, []);
  assert.ok(plain.structuredContent.bindingConstraints.every((b) => b.kind === "dependency"));
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

test("import_from_source takes `enrich` and forwards it on the import body", async () => {
  const { client } = await connect("lab");
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "import_from_source");
  // In the schema, optional, boolean, and described.
  const enrich = tool.inputSchema.properties.enrich;
  assert.ok(enrich, "enrich missing from import_from_source inputSchema");
  assert.equal(enrich.type, "boolean");
  assert.ok(!(tool.inputSchema.required || []).includes("enrich"));
  assert.ok(/track/i.test(enrich.description));
  assert.ok(/import_from_source/.test(tool.description) || /enrich/.test(tool.description));

  // In the request body: capture the fetch the tool makes.
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        program: GOOD,
        enrichment: { added: ["rest"], changed: ["cook"], iterations: 1, tracks: 2 },
      }),
    };
  };
  try {
    const res = await client.callTool({ name: "import_from_source", arguments: {
      source: "protocolsio", action: "import", query: "https://protocols.io/view/x",
      token: "tok", enrich: true,
    } });
    assert.equal(res.isError, undefined);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.endsWith("/api/import"));
    assert.equal(seen[0].body.enrich, true);
    assert.equal(seen[0].body.source, "protocolsio");
    // The reply says what enrichment did, so the model knows which steps
    // were read from the source and which were inferred.
    const text = res.content.map((c) => c.text || "").join("\n");
    assert.ok(/Enriched into 2 track/.test(text), text.slice(0, 400));
    assert.ok(/1 inferred step/.test(text));

    // Omitted: the body is byte-identical to today's, with no `enrich` key.
    seen.length = 0;
    await client.callTool({ name: "import_from_source", arguments: {
      source: "protocolsio", action: "import", query: "https://protocols.io/view/x", token: "tok",
    } });
    assert.equal("enrich" in seen[0].body, false);
  } finally {
    global.fetch = realFetch;
  }
});

test("import_from_source reports a failed enrichment without losing the import", async () => {
  const { client } = await connect("lab");
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ program: GOOD, enrichment: { error: "ANTHROPIC_API_KEY is not set on this server." } }),
  });
  try {
    const res = await client.callTool({ name: "import_from_source", arguments: {
      source: "protocolsio", action: "import", query: "x", token: "tok", enrich: true,
    } });
    assert.equal(res.isError, undefined);
    const text = res.content.map((c) => c.text || "").join("\n");
    assert.ok(/Enrichment skipped/.test(text), text.slice(0, 400));
    assert.ok(/ANTHROPIC_API_KEY/.test(text));
    assert.ok(/Pancakes/.test(text));
  } finally {
    global.fetch = realFetch;
  }
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
  // The 0.3.0-alpha worked example (per-instance chain + barrier + in-flight cap).
  assert.ok(uris.includes("rhylthyme://examples/cookies_three_trays"), uris.join(", "));
  const cookies = await client.readResource({ uri: "rhylthyme://examples/cookies_three_trays" });
  const cookieProgram = JSON.parse(cookies.contents[0].text);
  assert.equal(cookieProgram.schemaVersion, "0.3.0-alpha");
  assert.equal(cookieProgram.tracks[0].steps[1].replicates.maxInFlight, 2);
  const cookieCheck = Schedule.validateProgram(cookieProgram);
  assert.equal(cookieCheck.valid, true, JSON.stringify(cookieCheck.errors));
});

test("authoring guide documents replicates, instances and maxInFlight", async () => {
  const { client } = await connect("generic");
  const guide = (await client.readResource({ uri: "rhylthyme://guide/authoring" })).contents[0].text;
  assert.ok(guide.includes("## Repeating work: per-instance chains, barriers and in-flight limits"), guide.slice(0, 200));
  for (const needle of ["`replicates`", "maxInFlight", '`"each"`', '`"all"`', '`"any"`',
                        "E_INSTANCES_ON_SINGLE", "E_INFLIGHT_NO_CHAIN", "I_IMPLICIT_BARRIER",
                        "maxConcurrent"]) {
    assert.ok(guide.includes(needle), `guide is missing ${needle}`);
  }
  // The sample program at the top of the guide is the current schema.
  assert.ok(guide.includes('"schemaVersion": "0.3.0-alpha"'));
  assert.ok(!guide.includes('(schemaVersion "0.2.0-alpha")'), "choice heading still pins 0.2.0-alpha");
  // `instances` is listed in the trigger table.
  assert.ok(/\| afterStep .*instances\?/.test(guide), "instances missing from the trigger table");
});

test("the authoring guide's 0.3.0 snippet is a valid program", async () => {
  const { client } = await connect("generic");
  const guide = (await client.readResource({ uri: "rhylthyme://guide/authoring" })).contents[0].text;
  const m = guide.match(/<!-- rhylthyme:example cookies-three-trays -->\n```json\n([\s\S]*?)\n```/);
  assert.ok(m, "marked cookies-three-trays snippet not found in the guide");
  const program = JSON.parse(m[1]);
  const res = Schedule.validateProgram(program);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(res.errors, []);
  // And it really is the in-flight-limited schedule the prose describes:
  // 74 minutes, with the third bake held by the rack.
  const analysis = Schedule.analyzeSchedule(program);
  assert.equal(analysis.makespanSeconds, 4440);
  assert.equal(analysis.steps.find((s) => s.stepId === "bake-r3").startSeconds, 2520);
});

// ---- plan_schedule: the four turns -----------------------------------
//
// The prompt hands the host four user messages (prompts.js). Assertions
// that used to read messages[0] read the whole conversation now: what
// matters is that the guidance reaches the model, not which turn carries
// it.
function promptText(res) {
  return res.messages.map((m) => m.content.text).join("\n\n");
}

test("plan_schedule returns the four turns, in order, as user messages", async () => {
  const { client } = await connect("kitchen");
  const { prompts } = await client.listPrompts();
  const plan = prompts.find((p) => p.name === "plan_schedule");
  assert.ok(plan);
  assert.ok(plan.arguments.some((a) => a.name === "sourceText"));
  const res = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "brunch for six" } });
  assert.equal(res.messages.length, 4);
  for (const m of res.messages) {
    assert.equal(m.role, "user");
    assert.equal(m.content.type, "text");
    assert.ok(m.content.text.length > 200);
  }
  const texts = res.messages.map((m) => m.content.text);
  assert.ok(texts[0].startsWith("Turn 1 of 4 — read-back"), texts[0].slice(0, 60));
  assert.ok(texts[1].startsWith("Turn 2 of 4 — model check"), texts[1].slice(0, 60));
  assert.ok(texts[2].startsWith("Turn 3 of 4 — extraction"), texts[2].slice(0, 60));
  assert.ok(texts[3].startsWith("Turn 4 of 4 — relationships"), texts[3].slice(0, 60));
  // T3 extracts, T4 relates: no triggers before the step list exists.
  assert.ok(texts[2].includes("no tracks, no triggers"), texts[2].slice(0, 400));
  assert.ok(texts[2].includes("sourceSpan"));
  assert.ok(texts[3].includes("startTrigger"));
  // No slot marker survived rendering.
  assert.equal(texts.join("\n").match(/\{[A-Za-z][A-Za-z0-9_]*\}/), null);
  // The kitchen vertical's nouns reached the scenario prompt.
  assert.ok(texts[2].includes("carry out this recipe yourself"), texts[2].slice(0, 300));
  assert.ok(texts[2].includes("a kitchen with one oven and two burners"));
});

test("plan_schedule prompt renders with arguments", async () => {
  const { client } = await connect("events");
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "plan_schedule"));
  const res = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "wedding at 2pm", finishAt: "2026-06-06T22:00:00Z" } });
  const text = promptText(res);
  assert.ok(text.includes("wedding at 2pm"));
  assert.ok(text.includes("plan_event"));
  assert.ok(text.includes("finishAt=\"2026-06-06T22:00:00Z\""));
  // The deadline reaches the read-back line and the scenario prompt.
  assert.ok(res.messages[0].content.text.includes("Everything must be finished by 2026-06-06T22:00:00Z."));
  assert.ok(res.messages[2].content.text.includes("everything must be ready at 2026-06-06T22:00:00Z"));
  assert.ok(text.includes("run-of-show"));
});

test("plan_schedule without a deadline or constraints says so instead of leaving a hole", async () => {
  const { client } = await connect("generic");
  const res = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "something multi-step" } });
  const first = res.messages[0].content.text;
  assert.ok(first.includes("No finishing time was given"), first);
  assert.ok(first.includes("Resource limits: none were given"), first);
  assert.ok(res.messages[2].content.text.includes("everything must be ready at the earliest time the work allows"));
  // Step 5 loses the finishAt argument, as the single-message prompt did.
  assert.ok(promptText(res).includes("5. Run analyze_schedule to check the makespan"), promptText(res));
  assert.ok(promptText(res).includes("(search_public_recipes)"), "generic has no one-shot");
});

test("plan_schedule embeds sourceText in turns 1 and 3 only", async () => {
  const { client } = await connect("lab");
  const SOURCE = "Digest 1 ug of plasmid with EcoRI for 60 minutes at 37 C.";
  const res = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "miniprep and digest", sourceText: SOURCE } });
  const texts = res.messages.map((m) => m.content.text);
  assert.ok(texts[0].includes(SOURCE), "T1 must carry the source");
  assert.ok(texts[2].includes(SOURCE), "T3 must carry the source");
  assert.ok(!texts[1].includes(SOURCE));
  assert.ok(!texts[3].includes(SOURCE));
  assert.ok(texts[0].includes("Source text (read all of it):"));
  // Without it, both turns say so rather than pretending there is one.
  const none = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "miniprep and digest" } });
  const noneTexts = none.messages.map((m) => m.content.text);
  assert.ok(noneTexts[0].includes("No source text was supplied"), noneTexts[0]);
  assert.ok(noneTexts[2].includes("No source text was supplied"), noneTexts[2]);
  assert.ok(noneTexts[2].includes("carry out this protocol yourself"));
});

test("plan_schedule points the model at replicates / instances / maxInFlight", async () => {
  const { client } = await connect("generic");
  const res = await client.getPrompt({ name: "plan_schedule", arguments: { goal: "12 samples through one thermocycler" } });
  const text = promptText(res);
  assert.ok(text.includes("maxInFlight"), text);
  assert.ok(text.includes("instances"), text);
  assert.ok(text.includes("replicates"), text);
  assert.ok(text.includes("never n hand-copied steps or tracks"), text);
  // The server instructions carry the same pointer for hosts that only read those.
  const instructions = handler._serverInstructions("generic");
  assert.ok(instructions.includes("maxInFlight"), instructions);
  assert.ok(instructions.includes("rhylthyme://guide/authoring"));
});

// Stand-in for the manual host check in the PRD's acceptance criteria:
// we cannot drive a real MCP host here, so assert that the text the host
// would hand the model contains the guidance that leads to maxInFlight.
test("plan_schedule on \"three trays, one oven, rack holds two\" spells out the in-flight cap", async () => {
  const { client } = await connect("kitchen");
  const res = await client.getPrompt({ name: "plan_schedule", arguments: {
    goal: "three trays of cookies",
    constraints: "one oven, the cooling rack holds two",
  } });
  const text = promptText(res);
  assert.ok(text.includes("Resource limits: one oven, the cooling rack holds two."), text);
  assert.ok(/a rack that holds two trays/.test(text), text);
  assert.ok(/replicates\.maxInFlight: k/.test(text), text);
  assert.ok(/"instances":"each"/.test(text), text);
  assert.ok(/"instances":"all"/.test(text), text);
  assert.ok(text.includes("rhylthyme://guide/authoring"), text);
  // The constraints also shape the scenario prompt's environment slot.
  assert.ok(res.messages[2].content.text.includes("in a kitchen where you have: one oven, the cooling rack holds two"), res.messages[2].content.text);
});

test("the extraction guide resource carries the same four turns", async () => {
  const { client } = await connect("generic");
  const { resources } = await client.listResources();
  assert.ok(resources.map((r) => r.uri).includes("rhylthyme://guide/extraction"));
  const guide = (await client.readResource({ uri: "rhylthyme://guide/extraction" })).contents[0].text;
  for (const needle of ["# Rhylthyme extraction guide", "## T1 — read-back", "## T2 — model check",
                        "## T3 — extraction", "## T4 — relationships", "sourceSpan", "occurrence",
                        "`{goal}`", "`{source}`", "Expected output shape:"]) {
    assert.ok(guide.includes(needle), `extraction guide is missing ${needle}`);
  }
  // Unrendered: a host fills the slots itself.
  assert.ok(guide.includes("{deadline}"));
  // The authoring guide points at it.
  const authoring = (await client.readResource({ uri: "rhylthyme://guide/authoring" })).contents[0].text;
  assert.ok(authoring.includes("rhylthyme://guide/extraction"), "authoring guide must cross-link the extraction guide");
});

// Phase 3 shortened the instructions: the four turns live in the prompt
// and the extraction guide, not in every host's system preamble.
const INSTRUCTIONS_LENGTH_BEFORE = { generic: 2275, kitchen: 2306, lab: 2309, events: 2308, gym: 2305 };

test("server instructions are shorter than before and point at the prompt and both guides", () => {
  for (const [vertical, before] of Object.entries(INSTRUCTIONS_LENGTH_BEFORE)) {
    const text = handler._serverInstructions(vertical);
    assert.ok(text.length < before, `${vertical} instructions grew: ${text.length} >= ${before}`);
    assert.ok(text.includes("plan_schedule"), vertical);
    assert.ok(text.includes("rhylthyme://guide/extraction"), vertical);
    assert.ok(text.includes("rhylthyme://guide/authoring"), vertical);
    // The workflow diagram and the authoring rules stay.
    assert.ok(text.includes("Workflow:"), vertical);
    assert.ok(text.includes("validate_program"), vertical);
    assert.ok(text.includes("visualize_schedule"), vertical);
    assert.ok(text.includes("Authoring rules: stepIds unique across the whole program"), vertical);
  }
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

test("HTTP entry: clients that don't accept SSE still get a JSON reply, not 406", async () => {
  for (const accept of ["*/*", "application/json", undefined]) {
    const req = fakeReq("POST", "/mcp", { jsonrpc: "2.0", id: 9, method: "tools/list" }, { accept });
    if (accept === undefined) delete req.headers.accept;
    const res = fakeRes();
    await handler(req, res);
    await res.done;
    assert.equal(res.statusCode, 200, `${accept}: ${res.text().slice(0, 200)}`);
    assert.match(res.headers["content-type"], /application\/json/);
    const rpc = JSON.parse(res.text());
    assert.equal(rpc.id, 9);
    assert.ok(rpc.result.tools.some((t) => t.name === "validate_program"));
  }
});

test("HTTP entry: SSE-capable clients still get the event stream", async () => {
  const res = fakeRes();
  await handler(fakeReq("POST", "/mcp", { jsonrpc: "2.0", id: 10, method: "tools/list" }), res);
  await res.done;
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
});

test("Program input schema accepts a compound trigger labelled type: \"compound\"", () => {
  const p = JSON.parse(JSON.stringify(GOOD));
  p.tracks[1].steps[1].startTrigger = {
    type: "compound", logic: "all",
    triggers: [{ type: "afterStep", stepId: "rest" }, { type: "afterStep", stepId: "heat" }],
  };
  assert.equal(handler._schemas.Program.safeParse(p).success, true);
  assert.equal(Schedule.validateProgram(p).valid, true);
  // Inner triggers stay strict.
  p.tracks[1].steps[1].startTrigger.triggers[0].type = "compound";
  assert.equal(handler._schemas.Program.safeParse(p).success, false);
});

test("preview PNGs draw their text with no system fonts (bundled DejaVu)", () => {
  const { Resvg } = require("@resvg/resvg-js");
  const svg = handler._renderSvgGantt(GOOD);
  assert.match(svg, /rt-style-web/);
  assert.match(svg, /font-family="DejaVu Sans, sans-serif"/);
  const opts = handler._resvgOptions(820);
  assert.equal(opts.font.loadSystemFonts, false);
  for (const f of opts.font.fontFiles) assert.ok(require("fs").existsSync(f), f);
  const withText = new Resvg(svg, opts).render().asPng();
  const noText = new Resvg(svg.replace(/<text[\s\S]*?<\/text>/g, ""), opts).render().asPng();
  assert.ok(!withText.equals(noText), "text must change the pixels; a fontless host drew none");
  // Without any font the two are identical, which is the bug this guards.
  const bare = { fitTo: opts.fitTo, background: opts.background, font: { loadSystemFonts: false } };
  assert.ok(new Resvg(svg, bare).render().asPng().equals(new Resvg(svg.replace(/<text[\s\S]*?<\/text>/g, ""), bare).render().asPng()));
});

test("import_text is registered with its schema, annotations and login gate", async () => {
  const { client } = await connect("kitchen");
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "import_text");
  assert.ok(tool, "import_text not registered");
  // Read-only and open-world, like the other import tool: it creates
  // nothing on the user's account, but it does reach out to the server.
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.ok(tool.title);

  const props = tool.inputSchema.properties;
  assert.deepEqual(tool.inputSchema.required.sort(), ["environmentType", "text"]);
  for (const key of ["text", "environmentType", "deadline", "hints", "token"]) {
    assert.ok(props[key], `import_text is missing ${key}`);
    assert.equal(props[key].type, "string");
  }
  assert.ok(/login/i.test(props.token.description));
  assert.ok(/span/i.test(tool.description) || /source span/i.test(tool.description));

  // No token: say how to get one instead of surfacing a 401.
  const res = await client.callTool({ name: "import_text", arguments: { text: "Boil it.", environmentType: "kitchen" } });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("login"));
});

test("import_text posts the pasted text to /api/import as source llm-text", async () => {
  const { client } = await connect("kitchen");
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        program: GOOD,
        steps: [
          { stepId: "mix", name: "Mix batter", sourceSpan: { quote: "Mix the batter", occurrence: 1 }, inferred: false },
          { stepId: "rest", name: "Rest batter", sourceSpan: { quote: "let it rest", occurrence: 2 }, inferred: false },
          { stepId: "heat", name: "Heat griddle", sourceSpan: null, inferred: true },
        ],
        turns: { t1_score: 2, t2_score: 1 },
        chunks: 2,
        tokens: { input: 900, output: 700 },
      }),
    };
  };
  try {
    const res = await client.callTool({ name: "import_text", arguments: {
      text: "Mix the batter, let it rest, cook the pancakes.",
      environmentType: "kitchen", deadline: "10:00", hints: "one griddle, one cook", token: "tok",
    } });
    assert.equal(res.isError, undefined);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.endsWith("/api/import"));
    assert.equal(seen[0].body.source, "llm-text");
    assert.equal(seen[0].body.text, "Mix the batter, let it rest, cook the pancakes.");
    assert.equal(seen[0].body.environmentType, "kitchen");
    assert.equal(seen[0].body.deadline, "10:00");
    assert.equal(seen[0].body.hints, "one griddle, one cook");
    assert.equal(seen[0].headers.Authorization, "Bearer tok");

    const text = res.content.map((c) => c.text || "").join("\n");
    // The program itself, the turn scores, and the step -> span table.
    assert.ok(/Pancakes/.test(text));
    assert.ok(/read-back 2\/2/.test(text), text.slice(0, 600));
    assert.ok(/model check 1\/2/.test(text));
    assert.ok(/source read in 2 chunks/.test(text));
    assert.ok(/Where each step came from/.test(text));
    assert.ok(/"Mix the batter"/.test(text));
    assert.ok(/occurrence 2/.test(text));
    assert.ok(/inferred/.test(text));
    assert.ok(/visualize_schedule/.test(text));
  } finally {
    global.fetch = realFetch;
  }
});

test("import_text surfaces the turn that failed", async () => {
  const { client } = await connect("lab");
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 502,
    text: async () => JSON.stringify({ error: "turn 3 produced no steps from the source text.", stage: "T3" }),
    json: async () => ({ error: "turn 3 produced no steps from the source text.", stage: "T3" }),
  });
  try {
    const res = await client.callTool({ name: "import_text", arguments: {
      text: "something unreadable", environmentType: "lab", token: "tok",
    } });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text || "").join("\n");
    assert.ok(/failed at T3/.test(text), text.slice(0, 300));
  } finally {
    global.fetch = realFetch;
  }
});

test("import_from_source also accepts llm-text as a source", async () => {
  const { client } = await connect("generic");
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "import_from_source");
  assert.ok(tool.inputSchema.properties.source.enum.includes("llm-text"));
  // Still login-gated like every other import.
  const res = await client.callTool({ name: "import_from_source", arguments: {
    source: "llm-text", action: "import", text: "Boil it.",
  } });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("login"));
});

// ---------------------------------------------------------------------
// Execution history (plans/execution-history-duration-prediction.md §3)
// ---------------------------------------------------------------------

const RUN_RECORD = {
  schemaVersion: "0.1.0-alpha",
  runId: "2026-09-14T12:00:00Z-8f3a",
  programId: "runrec-demo",
  programVersion: "sha256:" + "ab".repeat(32),
  runtime: { kind: "web", version: "2.0.0-beta.3", clockMode: "wall", speed: 1 },
  startedAt: "2026-09-14T12:00:00.000Z",
  endedAt: "2026-09-14T12:02:45.000Z",
  outcome: "completed",
  context: { serves: "2", userTags: { oven: "gas" } },
  steps: [
    { stepId: "prep", instance: 1, planned: { start: 0, end: 600, durationType: "fixed", seconds: 600 },
      actual: { start: 0, end: 600 }, endedBy: "timer", triggerFiredAt: 0, pausedSeconds: 0 },
    { stepId: "simmer", instance: 1, planned: { start: 600, end: 1800, durationType: "indefinite", defaultSeconds: 1200 },
      actual: { start: 600, end: 2400 }, endedBy: "executor", triggerFiredAt: 600, waitedOn: ["prep"], pausedSeconds: 0 },
  ],
};

test("list_runs and load_run are registered, read-only and login-gated", async () => {
  const { client } = await connect("kitchen");
  const { tools } = await client.listTools();

  const list = tools.find((t) => t.name === "list_runs");
  assert.ok(list, "list_runs not registered");
  assert.equal(list.annotations.readOnlyHint, true);
  assert.equal(list.annotations.destructiveHint, false);
  assert.ok(list.title);
  assert.deepEqual(list.inputSchema.required, ["program_id"]);
  assert.ok(/login/i.test(list.inputSchema.properties.token.description));

  const one = tools.find((t) => t.name === "load_run");
  assert.ok(one, "load_run not registered");
  assert.equal(one.annotations.readOnlyHint, true);
  assert.deepEqual(one.inputSchema.required, ["run_id"]);
  assert.ok(/login/i.test(one.inputSchema.properties.token.description));

  // No token: explain how to get one instead of surfacing a 401.
  for (const [name, args] of [["list_runs", { program_id: "p" }], ["load_run", { run_id: "r" }]]) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, name);
    assert.ok(res.content[0].text.includes("login"), name);
  }
});

test("list_runs summarises the run list and load_run tables planned vs actual", async () => {
  const { client } = await connect("generic");
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: (options || {}).headers });
    if (/\/runs$/.test(String(url))) {
      return {
        ok: true, status: 200,
        json: async () => ({
          programId: "22222222-2222-2222-2222-222222222222",
          runs: [{
            id: "33333333-3333-3333-3333-333333333333",
            runId: RUN_RECORD.runId, startedAt: RUN_RECORD.startedAt, outcome: "completed",
            runtime: "web", speed: 1, clockMode: "wall", pausedSeconds: 0,
            plannedMakespanSeconds: 1800, actualMakespanSeconds: 2400, steps: 2,
          }],
        }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        id: "33333333-3333-3333-3333-333333333333",
        plannedMakespanSeconds: 1800, actualMakespanSeconds: 2400, run: RUN_RECORD,
      }),
    };
  };
  try {
    const listed = await client.callTool({ name: "list_runs", arguments: {
      program_id: "22222222-2222-2222-2222-222222222222", token: "tok",
    } });
    assert.ok(!listed.isError, JSON.stringify(listed).slice(0, 300));
    const listText = listed.content.map((c) => c.text || "").join("\n");
    assert.match(listText, /1 recorded run/);
    assert.match(listText, /completed/);
    assert.match(listText, /actual 40min vs planned 30min/);
    assert.match(listText, /\+33 %/);
    assert.match(listText, /load_run/);
    assert.match(seen[0].url, /\/api\/mcp\/programs\/22222222-2222-2222-2222-222222222222\/runs$/);
    assert.equal(seen[0].headers.Authorization, "Bearer tok");

    const loaded = await client.callTool({ name: "load_run", arguments: {
      run_id: "33333333-3333-3333-3333-333333333333", token: "tok",
    } });
    assert.ok(!loaded.isError, JSON.stringify(loaded).slice(0, 300));
    const text = loaded.content.map((c) => c.text || "").join("\n");
    assert.match(text, /Run 2026-09-14T12:00:00Z-8f3a/);
    assert.match(text, /\| Step \| Kind \| Planned \| Actual \| Ended by \| Paused \|/);
    assert.match(text, /\| simmer \| indefinite \| 20min \| 30min \(\+50 %\) \| executor \|/);
    assert.match(text, /oven=gas/);
    assert.match(seen[1].url, /\/api\/mcp\/runs\/33333333-3333-3333-3333-333333333333$/);
  } finally {
    global.fetch = realFetch;
  }
});

test("list_public_runs is registered, read-only and needs no login", async () => {
  const { client } = await connect("kitchen");
  const { tools } = await client.listTools();

  const tool = tools.find((t) => t.name === "list_public_runs");
  assert.ok(tool, "list_public_runs not registered");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.ok(tool.title);
  // Nothing is required: a hash or a program will do, and there is no token.
  assert.ok(!tool.inputSchema.required || tool.inputSchema.required.length === 0);
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties).sort(),
    ["limit", "program", "program_hash"],
  );
  assert.ok(!tool.inputSchema.properties.token, "contributed runs belong to nobody: no token");
  assert.ok(/no login/i.test(tool.description));

  // Without a hash or a program it explains itself instead of calling the API.
  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called++; throw new Error("must not be called"); };
  try {
    for (const args of [{}, { program_hash: "thanksgiving" }, { program_hash: "sha256:beef" }]) {
      const res = await client.callTool({ name: "list_public_runs", arguments: args });
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(res.content[0].text, /program_hash/);
    }
    assert.equal(called, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test("list_public_runs hashes a program, summarises the contributed runs and needs no token", async () => {
  const { client } = await connect("generic");
  const program = {
    schemaVersion: "0.3.0-alpha", programId: "runrec-demo", name: "Run record demo",
    tracks: [{ trackId: "pot", name: "Pot", steps: [
      { stepId: "prep", name: "Prep", task: "cook", duration: { type: "fixed", seconds: 600 }, startTrigger: { type: "programStart" } },
    ] }],
  };
  // Pinned so this is a parity check, not a tautology: the same value comes out
  // of `node rhylthyme-timeline/tools/hash-program.js`, of the element player
  // (Rhylthyme.programVersion) and of rhylthyme_cli_runner.history.hash.
  const hash = "sha256:25251ee76507035b7ef388b2ec2de0995a8eddffa8e6be31ab17809f81e17e98";

  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: (options || {}).headers });
    return {
      ok: true, status: 200,
      json: async () => ({
        programHash: hash,
        runs: [
          { id: "b1", runId: "2026-09-14T12:00:00Z-8f3a", startedAt: "2026-09-14T12:00:00.000Z",
            outcome: "completed", runtime: "web", speed: 1, clockMode: "wall", pausedSeconds: 0,
            userTags: { turkeyKg: 6.4, oven: "gas" },
            plannedMakespanSeconds: 1800, actualMakespanSeconds: 2400, steps: 2 },
          { id: "b2", runId: "2026-09-10T09:00:00Z-1c2d", startedAt: "2026-09-10T09:00:00.000Z",
            outcome: "completed", runtime: "cli", speed: 1, clockMode: "wall", pausedSeconds: 0,
            userTags: { turkeyKg: 5, oven: "convection" },
            plannedMakespanSeconds: 1800, actualMakespanSeconds: 1800, steps: 2 },
        ],
      }),
    };
  };
  try {
    const res = await client.callTool({ name: "list_public_runs", arguments: { program, limit: 10 } });
    assert.ok(!res.isError, JSON.stringify(res).slice(0, 300));
    const text = res.content.map((c) => c.text || "").join("\n");
    assert.match(text, /2 contributed runs/);
    assert.match(text, new RegExp(hash));
    assert.match(text, /actual 40min vs planned 30min \(\+33 %\)/);
    assert.match(text, /turkeyKg=6\.4, oven=gas/);
    assert.match(text, /Median actual total across 2 contributed runs: \*\*35min\*\*/);
    assert.match(text, /anonymous/);

    // The program was hashed here, exactly as the runtimes hash it, and the
    // request carried no Authorization header.
    assert.match(seen[0].url, new RegExp("/api/public/runs\\?programHash=" + hash.replace(":", "%3A")));
    assert.match(seen[0].url, /limit=10/);
    assert.ok(!seen[0].headers || !seen[0].headers.Authorization, "public runs need no token");

    // A hash passed directly gets the same request.
    await client.callTool({ name: "list_public_runs", arguments: { program_hash: hash } });
    assert.match(seen[1].url, new RegExp("programHash=" + hash.replace(":", "%3A")));
  } finally {
    global.fetch = realFetch;
  }
});

test("list_public_runs says so when nobody has contributed a run", async () => {
  const { client } = await connect("lab");
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ runs: [] }) });
  try {
    const res = await client.callTool({
      name: "list_public_runs", arguments: { program_hash: "sha256:" + "ab".repeat(32) },
    });
    assert.ok(!res.isError);
    assert.match(res.content[0].text, /No contributed runs/);
    assert.match(res.content[0].text, /opt-in per run/);
  } finally {
    global.fetch = realFetch;
  }
});

test("list_runs says so when a program has no recorded runs", async () => {
  const { client } = await connect("lab");
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ runs: [] }) });
  try {
    const res = await client.callTool({ name: "list_runs", arguments: { program_id: "p", token: "tok" } });
    assert.ok(!res.isError);
    assert.match(res.content[0].text, /No runs recorded/);
  } finally {
    global.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------
// Prediction and calibration through the tool surface
// (plans/execution-history-duration-prediction.md Phases 5 and 6).
// schedule.test.js / history.test.js pin the arithmetic; these tests pin
// the wiring: that the tool schemas carry the new arguments and fields,
// that the handler forwards them, and that a proposal renders.
// ---------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const TG_PROGRAM_PATH = path.join(__dirname, "..", "static", "examples", "thanksgiving_one_oven.json");
const TG_RUNS_PATH = path.join(
  __dirname, "..", "..", "rhylthyme-cli-runner", "tests", "fixtures", "history", "thanksgiving-synth-runs.json",
);

function thanksgivingHistory() {
  if (!fs.existsSync(TG_PROGRAM_PATH) || !fs.existsSync(TG_RUNS_PATH)) return null;
  const runs = JSON.parse(fs.readFileSync(TG_RUNS_PATH, "utf8")).runs;
  return {
    program: JSON.parse(fs.readFileSync(TG_PROGRAM_PATH, "utf8")),
    runs,
    context: {
      programVersion: runs[0].programVersion,
      environmentId: "home-kitchen",
      userTags: { turkeyKg: 7, oven: "electric" },
    },
  };
}

test("analyze_schedule declares the history arguments and the prediction output fields", async () => {
  const { client } = await connect("kitchen");
  const tool = (await client.listTools()).tools.find((t) => t.name === "analyze_schedule");
  const props = tool.inputSchema.properties;
  assert.ok(props.history, "history missing from the input schema");
  assert.equal(props.history.type, "array");
  assert.ok(props.predictionContext, "predictionContext missing");
  // The keys are named in the description and spelled out in the tool guide,
  // not declared one by one: that cost ~1,500 characters of every tools/list.
  const toolGuide = (await client.readResource({ uri: "rhylthyme://guide/tools" })).contents[0].text;
  for (const key of ["environmentId", "userTags", "userId", "programVersion",
                     "minIdentical", "minModel", "corrThreshold", "verdicts"]) {
    assert.ok(props.predictionContext.description.includes(key), `predictionContext.${key} not named`);
    assert.ok(toolGuide.includes("`" + key + "`"), `tool guide does not explain ${key}`);
  }
  assert.deepEqual(props.useDurations.enum, ["planned", "predicted"]);
  assert.equal(props.useDurations.default, "planned");
  assert.ok(props.program_id && props.token, "the program_id + token convenience is not declared");

  const out = tool.outputSchema.properties;
  for (const key of ["durationsUsed", "plannedMakespanSeconds", "plannedMakespan",
                     "predictedMakespanSeconds", "predictedMakespan", "predictedCriticalPath"]) {
    assert.ok(out[key], `output schema missing ${key}`);
  }
  // Prediction is a pure computation over what the caller hands in, so the
  // annotations must not change: still no network, still repeatable.
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
});

test("analyze_schedule with history predicts per step and reports the predicted makespan", async (t) => {
  const tg = thanksgivingHistory();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const { client } = await connect("kitchen");
  const res = await client.callTool({ name: "analyze_schedule", arguments: {
    program: tg.program, history: tg.runs, predictionContext: tg.context,
  } });
  assert.ok(!res.isError, JSON.stringify(res).slice(0, 300));
  const a = res.structuredContent;

  // Planned durations are still in charge by default...
  assert.equal(a.durationsUsed, "planned");
  assert.equal(a.makespanSeconds, a.plannedMakespanSeconds);
  // ...but the prediction rides along.
  assert.ok(typeof a.predictedMakespanSeconds === "number");
  assert.ok(a.predictedMakespanSeconds < a.plannedMakespanSeconds,
    "the synthetic history roasts the turkey far faster than the author guessed");
  assert.ok(Array.isArray(a.predictedCriticalPath));
  const roast = a.steps.find((s) => s.stepId === "turkey-roast");
  assert.ok(roast.predicted, "turkey-roast has 20 measured runs and no prediction");
  assert.equal(roast.predicted.basis, "model");
  assert.equal(roast.plannedDurationSeconds, 9900);

  const text = res.content.map((c) => c.text || "").join("\n");
  assert.match(text, /\*\*Durations used:\*\* planned/);
  assert.match(text, /predicted makespan/);
  assert.match(text, /Predicted durations \(\d+ of \d+ steps have history\)/);
});

test("analyze_schedule useDurations=predicted replans on the predicted durations", async (t) => {
  const tg = thanksgivingHistory();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const { client } = await connect("kitchen");
  const args = { program: tg.program, history: tg.runs, predictionContext: tg.context };
  const planned = (await client.callTool({ name: "analyze_schedule", arguments: args })).structuredContent;
  const predicted = (await client.callTool({
    name: "analyze_schedule", arguments: Object.assign({}, args, { useDurations: "predicted" }),
  })).structuredContent;

  assert.equal(predicted.durationsUsed, "predicted");
  assert.notEqual(predicted.makespanSeconds, planned.makespanSeconds);
  assert.equal(predicted.makespanSeconds, predicted.predictedMakespanSeconds);
  // The planned figure is still reported either way, so the two are comparable.
  assert.equal(predicted.plannedMakespanSeconds, planned.plannedMakespanSeconds);
});

test("analyze_schedule without history is byte-for-byte what it was before prediction", async () => {
  const { client } = await connect("generic");
  const bare = await client.callTool({ name: "analyze_schedule", arguments: { program: GOOD } });
  const a = bare.structuredContent;
  for (const key of ["durationsUsed", "plannedMakespanSeconds", "predictedMakespanSeconds",
                     "predictedMakespan", "predictedCriticalPath"]) {
    assert.equal(a[key], undefined, `${key} leaked into a call with no history`);
  }
  assert.ok(a.steps.every((s) => s.predicted === undefined));
  assert.equal(
    JSON.stringify(a),
    JSON.stringify(Object.assign(Schedule.analyzeSchedule(GOOD), {
      validation: a.validation,
    })),
  );
  // Asking for predicted durations with nothing to predict from is not an
  // error, it is just the plan.
  const asked = await client.callTool({
    name: "analyze_schedule", arguments: { program: GOOD, useDurations: "predicted" },
  });
  assert.equal(asked.structuredContent.makespanSeconds, a.makespanSeconds);
  assert.equal(asked.structuredContent.durationsUsed, undefined);
});

test("analyze_schedule loads the caller's own runs from program_id + token", async (t) => {
  const tg = thanksgivingHistory();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const { client } = await connect("kitchen");
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: (options || {}).headers });
    return {
      ok: true, status: 200,
      json: async () => ({ runs: tg.runs.map((r, i) => ({ id: String(i), run: r })) }),
    };
  };
  try {
    const res = await client.callTool({ name: "analyze_schedule", arguments: {
      program: tg.program, program_id: "22222222-2222-2222-2222-222222222222", token: "tok",
      predictionContext: tg.context,
    } });
    assert.ok(!res.isError, JSON.stringify(res).slice(0, 300));
    // `full=1` — the summary rows list_runs renders carry no record to predict from.
    assert.match(seen[0].url, /\/api\/mcp\/programs\/22222222-2222-2222-2222-222222222222\/runs\?full=1$/);
    assert.equal(seen[0].headers.Authorization, "Bearer tok");
    assert.equal(res.structuredContent.durationsUsed, "planned");
    assert.ok(res.structuredContent.predictedMakespanSeconds > 0);
    assert.match(res.content[0].text, /20 recorded runs of this program, loaded from your library/);
  } finally {
    global.fetch = realFetch;
  }
});

const CAL_PROPOSAL = {
  programId: "thanksgiving-one-oven",
  programVersion: "sha256:" + "cd".repeat(32),
  runsProgramVersion: "sha256:" + "cd".repeat(32),
  asOf: "2026-09-14T00:00:00Z",
  minRuns: 5, lowPercentile: 10, highPercentile: 90, since: null,
  runsConsidered: 20, runsUsable: 20, runsExcluded: [], programVersionsSeen: [],
  steps: [
    { stepId: "turkey-roast", durationType: "indefinite", task: "oven", status: "proposed",
      reason: null, note: null, verdict: "predictable", n: 20,
      evidence: { current: { type: "indefinite", defaultSeconds: 9900 }, n: 20,
        plannedSeconds: 9900, median: 1179, p10: 1000, p90: 1400, iqr: 120,
        proposed: { type: "indefinite", defaultSeconds: 1179 }, deltaSeconds: -8721 } },
    { stepId: "turkey-prep", durationType: "fixed", task: "prep", status: "note",
      reason: null, note: "consider variable", verdict: "lag", n: 20,
      evidence: { current: { type: "fixed", seconds: 1200 }, n: 20, plannedSeconds: 1200,
        lagSeconds: 300, endDriftSeconds: 300, lagThresholdSeconds: 120,
        median: null, p10: null, p90: null, iqr: null } },
    { stepId: "salad", durationType: "fixed", task: "prep", status: "skipped",
      reason: "fixed-duration", note: null, verdict: "lag", n: 20,
      evidence: { current: { type: "fixed", seconds: 600 }, n: 20, median: null, p10: null, p90: null } },
  ],
  effect: {
    acceptedSteps: ["turkey-roast"],
    makespanBeforeSeconds: 14100, makespanAfterSeconds: 6900, makespanDeltaSeconds: -7200,
    criticalPathBefore: ["turkey-prep", "turkey-roast"], criticalPathAfter: ["stuffing-prep"],
    criticalPathChanged: true, stepShifts: [],
  },
};

test("calibrate_program is registered, read-only and login-gated", async () => {
  const { client } = await connect("kitchen");
  const tool = (await client.listTools()).tools.find((t) => t.name === "calibrate_program");
  assert.ok(tool, "calibrate_program not registered");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.ok(tool.title);
  const props = tool.inputSchema.properties;
  for (const key of ["program", "program_id", "history", "k", "since", "accept", "token"]) {
    assert.ok(props[key], `calibrate_program input missing ${key}`);
  }
  assert.ok(/login/i.test(props.token.description));
  // The description has to say it writes nothing, because the model decides
  // whether to follow up with save_program.
  assert.match(tool.description, /never saves|saves nothing|writes nothing/i);

  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called++; throw new Error("must not be called"); };
  try {
    const res = await client.callTool({ name: "calibrate_program", arguments: { program_id: "p" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /login/);
    // Nothing to calibrate against: refused before any request.
    const noRuns = await client.callTool({
      name: "calibrate_program", arguments: { program: GOOD, token: "tok" },
    });
    assert.equal(noRuns.isError, true);
    assert.match(noRuns.content[0].text, /program_id|history/);
    assert.equal(called, 0, "calibrate_program reached the network with no token");
  } finally {
    global.fetch = realFetch;
  }
});

test("calibrate_program renders the per-step table and the effect line", async () => {
  const { client } = await connect("kitchen");
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), options: options || {} });
    return { ok: true, status: 200, json: async () => ({ proposal: CAL_PROPOSAL }) };
  };
  try {
    const res = await client.callTool({ name: "calibrate_program", arguments: {
      program_id: "22222222-2222-2222-2222-222222222222", token: "tok", k: 5,
    } });
    assert.ok(!res.isError, JSON.stringify(res).slice(0, 400));
    assert.match(seen[0].url, /\/api\/mcp\/calibrate$/);
    assert.equal(seen[0].options.method, "POST");
    assert.equal(seen[0].options.headers.Authorization, "Bearer tok");
    const body = JSON.parse(seen[0].options.body);
    assert.equal(body.programId, "22222222-2222-2222-2222-222222222222");
    assert.equal(body.k, 5);
    assert.equal(body.accept, undefined, "a plain call must not accept anything");

    const text = res.content[0].text;
    assert.match(text, /Calibration proposal: thanksgiving-one-oven/);
    assert.match(text, /Runs: \*\*20\*\* usable of 20/);
    assert.match(text, /\| Step \| Type \| n \| Current \| Proposed \| Median \| IQR \| Delta \| Note \|/);
    assert.match(text, /\| turkey-roast \| indefinite \| 20 \| 2h 45min \| 20min \| 20min \| 2min \| −2h 25min \| predictable \|/);
    assert.match(text, /consider variable \(lag \+5min\)/);
    assert.match(text, /fixed duration: history only confirms the timer/);
    assert.match(text, /\*\*Effect if accepted:\*\* makespan 3h 55min → 1h 55min \(−2h\)/);
    assert.match(text, /critical path changes to stuffing-prep/);
    assert.match(text, /Nothing has been written/);
    assert.match(text, /accept: \["turkey-roast"\]/);
    // The proposal itself travels as structured content for the editor/UI.
    assert.equal(res.structuredContent.proposal.steps.length, 3);
    assert.equal(res.structuredContent.program, undefined);
  } finally {
    global.fetch = realFetch;
  }
});

test("calibrate_program with accept returns the calibrated program and still saves nothing", async () => {
  const { client } = await connect("generic");
  const realFetch = global.fetch;
  const seen = [];
  const calibrated = { programId: "thanksgiving-one-oven", tracks: [] };
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), options: options || {} });
    return {
      ok: true, status: 200,
      json: async () => ({ proposal: CAL_PROPOSAL, program: calibrated, accepted: ["turkey-roast"], saved: false }),
    };
  };
  try {
    const res = await client.callTool({ name: "calibrate_program", arguments: {
      program_id: "22222222-2222-2222-2222-222222222222", token: "tok", accept: ["turkey-roast"],
    } });
    assert.ok(!res.isError);
    assert.deepEqual(JSON.parse(seen[0].options.body).accept, ["turkey-roast"]);
    // One request only: the calibrated program comes back, it is not saved.
    assert.equal(seen.length, 1);
    assert.ok(seen.every((s) => !/\/api\/mcp\/save/.test(s.url)), "calibrate_program saved the program");
    assert.deepEqual(res.structuredContent.program, calibrated);
    assert.match(res.content[0].text, /\*\*Nothing has been saved\.\*\*/);
    assert.match(res.content[0].text, /save_program/);
  } finally {
    global.fetch = realFetch;
  }
});

test("preview_timeline draws planned-vs-actual when a run is supplied", async () => {
  // The renderer's own tests cover the drawing; what matters here is that the
  // run reaches it, which is visible as the ghost bars in the SVG.
  const plain = handler._renderSvgGantt(GOOD);
  assert.ok(plain && plain.includes("<svg"));
  assert.ok(!plain.includes("rt-baseline"), "no run, no ghost bars");

  const run = {
    runId: "2026-09-14T12:00:00Z-1111", programId: "pancakes", outcome: "completed",
    runtime: { kind: "web", clockMode: "wall", speed: 1 },
    startedAt: "2026-09-14T12:00:00.000Z",
    steps: [
      { stepId: "mix", planned: { start: 0, end: 300, durationType: "fixed" }, actual: { start: 0, end: 420 }, endedBy: "timer" },
      { stepId: "rest", planned: { start: 300, end: 900, durationType: "fixed" }, actual: { start: 420, end: 900 }, endedBy: "timer" },
      { stepId: "heat", planned: { start: 600, end: 900, durationType: "fixed" }, actual: { start: 600, end: 700 }, endedBy: "timer" },
      { stepId: "cook", planned: { start: 900, end: 1800, durationType: "variable" }, actual: { start: 900, end: 2100 }, endedBy: "executor" },
    ],
  };
  const withRun = handler._renderSvgGantt(GOOD, run);
  assert.ok(withRun.includes("rt-baseline"), "the run did not reach the renderer");
  assert.match(withRun, /data-deviation="late"/);
  assert.match(withRun, /data-deviation="early"/);

  const { client } = await connect("kitchen");
  const tool = (await client.listTools()).tools.find((t) => t.name === "preview_timeline");
  assert.ok(tool.inputSchema.properties.run, "preview_timeline has no `run` input");
  assert.match(tool.description, /Planned versus actual/);

  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => { seen.push(String(url)); throw new Error("no network in this test"); };
  try {
    const res = await client.callTool({ name: "preview_timeline", arguments: { program: GOOD, run } });
    assert.ok(!res.isError, JSON.stringify(res).slice(0, 300));
    const text = res.content.map((c) => c.text || "").join("\n");
    assert.match(text, /Planned versus actual for run `2026-09-14T12:00:00Z-1111`/);
    // A planned-vs-actual picture has no OG-image twin, so no share row is made.
    assert.equal(seen.length, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test("load_run points at the two things to do with a run", async () => {
  const { client } = await connect("generic");
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ plannedMakespanSeconds: 1800, actualMakespanSeconds: 2400, run: RUN_RECORD }),
  });
  try {
    const res = await client.callTool({ name: "load_run", arguments: { run_id: "r", token: "tok" } });
    assert.match(res.content[0].text, /preview_timeline.*`run`/s);
    assert.match(res.content[0].text, /calibrate_program/);
  } finally {
    global.fetch = realFetch;
  }
});

// ---- tools/list budget ------------------------------------------------------
// A host pastes every tool definition into the model's context on every turn.
// The list was ~11,800 tokens; an agent choosing among many servers skips one
// that expensive. What the model sees is name + description + inputSchema.

const modelFacing = (tool) => JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length;

test("tools/list stays inside its budget on every endpoint", async () => {
  for (const vertical of ["generic", "kitchen", "lab", "events", "gym"]) {
    const { client } = await connect(vertical);
    const { tools } = await client.listTools();
    const seen = tools.reduce((n, t) => n + modelFacing(t), 0);
    const whole = JSON.stringify(tools).length;
    // 16000 held 18 tools; review_program made it 19. Raise this only with a new tool.
    assert.ok(seen <= 17000, `${vertical}: model-facing definitions are ${seen} chars (~${Math.round(seen / 4)} tokens); budget 17000`);
    assert.ok(whole <= 25000, `${vertical}: tools/list is ${whole} chars; budget 25000`);
    for (const tool of tools) {
      assert.ok(tool.description.length <= 400, `${vertical}/${tool.name}: description is ${tool.description.length} chars; keep it under 400 and put the rest in LONG_DESC`);
      assert.ok(modelFacing(tool) <= 2000, `${vertical}/${tool.name}: ${modelFacing(tool)} chars`);
    }
  }
});

test("the program shape is spelled out exactly once, and no tool inlines the JSON Schema", async () => {
  const { client } = await connect("generic");
  const { tools } = await client.listTools();
  const withShape = tools.filter((t) => JSON.stringify(t.inputSchema).includes("programStartOffset"));
  assert.deepEqual(withShape.map((t) => t.name), ["validate_program"]);
  for (const name of ["visualize_schedule", "save_program", "analyze_schedule", "preview_timeline"]) {
    const program = tools.find((t) => t.name === name).inputSchema.properties.program;
    assert.equal(program.type, "object");
    assert.ok(!program.properties || !Object.keys(program.properties).length, `${name} inlines the program schema again`);
    assert.match(program.description, /validate_program/);
  }
});

test("the long descriptions live on as rhylthyme://guide/tools, per vertical", async () => {
  for (const [vertical, oneShot] of [["generic", null], ["kitchen", "cook_recipe"], ["lab", "run_protocol"]]) {
    const { client } = await connect(vertical);
    const { tools } = await client.listTools();
    const guide = (await client.readResource({ uri: "rhylthyme://guide/tools" })).contents[0].text;
    for (const tool of tools) assert.ok(guide.includes(`## ${tool.name}\n`), `${vertical}: guide has no section for ${tool.name}`);
    if (oneShot) assert.ok(guide.includes(`## ${oneShot}\n`));
    assert.match(guide, /E_INSTANCES_ON_SINGLE/, "validate_program's finding codes");
    assert.match(guide, /predictedCriticalPath/, "analyze_schedule's history output");
    assert.match(guide, /get_renderer_source/);
  }
  const kitchen = (await (await connect("kitchen")).client.readResource({ uri: "rhylthyme://guide/tools" })).contents[0].text;
  assert.match(kitchen, /cookbook/, "the kitchen guide keeps the kitchen wording");
});

test("visualize_schedule takes a loose program: nothing stripped, problems reported by the validator", async () => {
  const { client } = await connect("generic");
  const realFetch = global.fetch;
  let shared = null;
  global.fetch = async (url, init) => {
    if (init && init.body) { try { shared = JSON.parse(init.body); } catch (_) { /* not json */ } }
    return { ok: true, status: 200, json: async () => ({ share_id: "abc123", id: "abc123" }), text: async () => "{}" };
  };
  try {
    const bad = await client.callTool({ name: "visualize_schedule", arguments: { program: { name: "no tracks" } } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /validation errors|tracks/i, "an actionable finding, not a schema rejection");
    assert.ok(!/invalid_type|Invalid arguments/i.test(bad.content[0].text), bad.content[0].text);
  } finally { global.fetch = realFetch; }
  assert.equal(shared, null, "nothing was published");
});

test("a missing argument is reported to the model as an error and tagged as the caller's", async () => {
  const { client } = await connect("generic");
  const res = await client.callTool({ name: "import_from_source", arguments: { source: "spoonacular", action: "search" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs `query`/);
  assert.equal(res._meta["com.rhylthyme/errorKind"], "input");
});

test("refusing an invalid program is the caller's problem, tagged as such", async () => {
  const { client } = await connect("kitchen");
  const bad = { programId: "x", name: "x", tracks: [{ trackId: "a", name: "A", steps: [
    { stepId: "s1", name: "One", task: "t", duration: { type: "fixed", seconds: 60 }, startTrigger: { type: "programStart" } },
    { stepId: "s2", name: "Two", task: "t", duration: { type: "fixed", seconds: 60 }, startTrigger: { type: "programStart" } },
  ] }], resourceConstraints: [{ task: "t", maxConcurrent: 1 }] };
  const res = await client.callTool({ name: "visualize_schedule", arguments: { program: bad } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /track_overlap/);
  assert.equal(res._meta["com.rhylthyme/errorKind"], "input");
});

test("review_program: an account tool that forwards program and source to the API and formats the findings", async () => {
  const { client } = await connect("kitchen");
  const anon = await client.callTool({ name: "review_program", arguments: { program: { programId: "x", name: "x", tracks: [] } } });
  assert.equal(anon.isError, true);
  assert.match(anon.content[0].text, /account|login/i);

  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ summary: "One problem.", usable: false, model: "m",
      findings: [{ severity: "error", stepId: "s1", message: "Too short.", suggestion: "90m" }, { severity: "note", message: "Fine." }] }) };
  };
  try {
    const res = await client.callTool({ name: "review_program", arguments: { program: { programId: "x", name: "x", tracks: [] }, source_text: "simmer 90 min", token: "tok" } });
    assert.ok(!res.isError, res.content[0].text);
    assert.match(seen.url, /\/api\/import\/review$/);
    assert.equal(seen.auth, "Bearer tok");
    assert.equal(seen.body.source_text, "simmer 90 min");
    assert.match(res.content[0].text, /One problem\./);
    assert.match(res.content[0].text, /✗ `s1` Too short\.\n  → 90m/);
    assert.equal(res.structuredContent.usable, false);
  } finally { global.fetch = realFetch; }
});
