// node --test mcp-api/prompts.test.js
//
// The four-turn templates and the slot renderer. Pure strings: no SDK, no
// network. The harness in rhylthyme-cli-runner keeps Python copies of the
// same templates and a parity test that extracts these exports with node,
// so a change here fails there until the copies are regenerated.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const P = require("./prompts.js");

const KEYS = ["T1", "T2", "T3", "T4"];

test("FOUR_TURNS is the four turns, in order, with their templates", () => {
  assert.equal(P.FOUR_TURNS.length, 4);
  assert.deepEqual(P.FOUR_TURNS.map((t) => t.key), KEYS);
  assert.deepEqual(P.FOUR_TURNS.map((t) => t.name),
    ["read-back", "model check", "extraction", "relationships"]);
  const templates = [P.T1_READBACK, P.T2_MODEL_CHECK, P.T3_EXTRACTION, P.T4_RELATIONSHIPS];
  P.FOUR_TURNS.forEach((turn, i) => {
    assert.equal(turn.template, templates[i]);
    assert.equal(turn.expected, P.EXPECTED_OUTPUT[turn.key]);
    assert.deepEqual(turn.slots, P.slotsIn(turn.template));
    assert.ok(turn.purpose.length > 20);
    assert.ok(turn.template.startsWith(`Turn ${i + 1} of 4 — `), turn.template.slice(0, 40));
    // Every template states its own expected output shape.
    assert.ok(turn.template.includes(turn.expected));
  });
});

test("each expected-output shape is valid JSON of the documented shape", () => {
  const t1 = JSON.parse(P.EXPECTED_OUTPUT.T1);
  assert.equal(typeof t1.summary, "string");
  assert.ok("servesOrScale" in t1 && "deadline" in t1);
  assert.ok(Array.isArray(t1.constraints));

  const t2 = JSON.parse(P.EXPECTED_OUTPUT.T2);
  assert.equal(typeof t2.acknowledgement, "string");
  assert.ok(Array.isArray(t2.resourceConstraints));
  assert.ok(t2.resourceConstraints.every((r) => typeof r.task === "string" && typeof r.maxConcurrent === "number"));

  const t3 = JSON.parse(P.EXPECTED_OUTPUT.T3);
  assert.ok(Array.isArray(t3.steps) && t3.steps.length >= 2);
  for (const step of t3.steps) {
    assert.equal(typeof step.stepId, "string");
    assert.equal(typeof step.duration.type, "string");
    assert.equal(typeof step.inferred, "boolean");
    assert.ok("sourceSpan" in step);
  }
  // A flat step list: no tracks, no triggers.
  assert.ok(!("tracks" in t3));
  assert.ok(t3.steps.every((s) => !("startTrigger" in s)));
  // Spans are quote + occurrence; an inferred step has no span.
  const withSpan = t3.steps.find((s) => s.sourceSpan);
  assert.equal(typeof withSpan.sourceSpan.quote, "string");
  assert.equal(typeof withSpan.sourceSpan.occurrence, "number");
  const inferred = t3.steps.find((s) => s.inferred);
  assert.equal(inferred.sourceSpan, null);

  const t4 = JSON.parse(P.EXPECTED_OUTPUT.T4);
  assert.ok(Array.isArray(t4.tracks) && t4.tracks.length >= 1);
  assert.ok(Array.isArray(t4.resourceConstraints));
  const steps = t4.tracks.flatMap((t) => t.steps);
  assert.ok(steps.every((s) => s.startTrigger && s.metadata && "sourceSpan" in s.metadata && "inferred" in s.metadata));
  // Every task the sample program uses is constrained, as the rules require.
  const tasks = new Set(t4.resourceConstraints.map((r) => r.task));
  assert.ok(steps.every((s) => tasks.has(s.task)));
});

test("render fills every slot", () => {
  assert.equal(P.render("a {x} b {y} c", { x: "1", y: "2" }), "a 1 b 2 c");
  // A slot may repeat.
  assert.equal(P.render("{x}-{x}", { x: "z" }), "z-z");
  // No slots at all is fine.
  assert.equal(P.render("plain", {}), "plain");
  assert.equal(P.render("plain"), "plain");
  // A $ in the value is not a replacement pattern.
  assert.equal(P.render("{x}", { x: "$&$1" }), "$&$1");
  // Non-strings are stringified.
  assert.equal(P.render("{n}", { n: 3 }), "3");
});

test("render throws on an unknown slot and on a missing one", () => {
  assert.throws(() => P.render("a {x} b", { x: "1", nope: "2" }), /unknown slot\(s\) nope/);
  assert.throws(() => P.render("a {x} b {y}", { x: "1" }), /missing slot\(s\) y/);
  assert.throws(() => P.render("no slots here", { x: "1" }), /template takes no slots/);
});

test("slotsIn finds the markers and ignores JSON braces", () => {
  assert.deepEqual(P.slotsIn("{a} and {b} and {a}"), ["a", "b"]);
  assert.deepEqual(P.slotsIn('{"type":"afterStep","stepId":"x"}'), []);
  assert.deepEqual(P.slotsIn('replicates: {count: n, mode: "serial"}'), []);
  assert.deepEqual(P.slotsIn("{}"), []);
  // The shipped templates carry only the slots they declare.
  assert.deepEqual(P.slotsIn(P.T1_READBACK), ["kind", "goal", "constraintsLine", "deadlineLine", "source"]);
  assert.deepEqual(P.slotsIn(P.T2_MODEL_CHECK), ["kind"]);
  assert.deepEqual(P.slotsIn(P.T3_EXTRACTION), ["kind", "environment", "deadline", "source"]);
  assert.deepEqual(P.slotsIn(P.T4_RELATIONSHIPS), ["catalogTools", "finishAtArg"]);
  // ... and none of the expected-output shapes hides a marker.
  for (const key of KEYS) assert.deepEqual(P.slotsIn(P.EXPECTED_OUTPUT[key]), []);
});

test("the slot helpers turn plan_schedule arguments into words", () => {
  assert.equal(P.kindFor("kitchen"), "recipe");
  assert.equal(P.kindFor("lab"), "protocol");
  assert.equal(P.kindFor("events"), "run-of-show");
  assert.equal(P.kindFor("gym"), "workout");
  assert.equal(P.kindFor("nonsense"), "process");

  assert.equal(P.environmentPhrase("kitchen"), "a kitchen with one oven and two burners");
  assert.equal(P.environmentPhrase("kitchen", "one oven, two cooks"), "a kitchen where you have: one oven, two cooks");
  assert.equal(P.environmentPhrase("lab", "  "), "a lab with one of each shared instrument");

  assert.equal(P.deadlinePhrase("18:00"), "18:00");
  assert.equal(P.deadlinePhrase(""), "the earliest time the work allows");
  assert.equal(P.deadlineLine("18:00"), "Everything must be finished by 18:00.");
  assert.ok(P.deadlineLine(undefined).startsWith("No finishing time was given"));
  assert.equal(P.constraintsLine("one oven"), "Resource limits: one oven.");
  assert.ok(P.constraintsLine(null).startsWith("Resource limits: none were given"));

  assert.equal(P.catalogTools(null), "search_public_recipes");
  assert.equal(P.catalogTools("cook_recipe"), "search_public_recipes or cook_recipe");
  assert.equal(P.finishAtArg(null), "");
  assert.equal(P.finishAtArg("18:00"), ' with finishAt="18:00"');

  assert.ok(P.sourceBlock("Boil water.").includes("<<<\nBoil water.\n>>>"));
  assert.ok(P.sourceBlock("").startsWith("No source text was supplied"));
  assert.ok(P.sourceBlock(null).startsWith("No source text was supplied"));
});

test("renderFourTurns produces four fully-filled messages", () => {
  const turns = P.renderFourTurns({
    goal: "Thanksgiving for 8",
    finishAt: "2026-11-26T18:00:00",
    constraints: "one oven, four burners",
    sourceText: "Roast the turkey for 3 hours.",
    vertical: "kitchen",
    oneShot: "cook_recipe",
  });
  assert.deepEqual(turns.map((t) => t.key), KEYS);
  for (const turn of turns) {
    assert.equal(turn.text.match(/\{[A-Za-z][A-Za-z0-9_]*\}/), null, `unfilled slot in ${turn.key}: ${turn.text}`);
  }
  const [t1, t2, t3, t4] = turns.map((t) => t.text);
  assert.ok(t1.includes("Thanksgiving for 8"));
  assert.ok(t1.includes("Resource limits: one oven, four burners."));
  assert.ok(t1.includes("Everything must be finished by 2026-11-26T18:00:00."));
  assert.ok(t1.includes("Roast the turkey for 3 hours."));
  assert.ok(t2.includes("this recipe"));
  assert.ok(t3.includes("in a kitchen where you have: one oven, four burners"));
  assert.ok(t3.includes("ready at 2026-11-26T18:00:00"));
  assert.ok(t3.includes("Roast the turkey for 3 hours."));
  assert.ok(t4.includes("search_public_recipes or cook_recipe"));
  assert.ok(t4.includes('analyze_schedule with finishAt="2026-11-26T18:00:00"'));
  // Nothing but T1 and T3 sees the source text.
  assert.ok(!t2.includes("Roast the turkey for 3 hours."));
  assert.ok(!t4.includes("Roast the turkey for 3 hours."));

  // Bare goal, generic vertical: every slot still resolves.
  const bare = P.renderFourTurns({ goal: "something" });
  for (const turn of bare) assert.equal(turn.text.match(/\{[A-Za-z][A-Za-z0-9_]*\}/), null);
  assert.ok(bare[3].text.includes("(search_public_recipes)"));
  assert.ok(bare[3].text.includes("5. Run analyze_schedule to check"));
});

test("turnSlots names exactly the slots each template takes", () => {
  const slots = P.turnSlots({ goal: "g", vertical: "lab", oneShot: "run_protocol" });
  for (const turn of P.FOUR_TURNS) {
    assert.deepEqual(Object.keys(slots[turn.key]).sort(), turn.slots.slice().sort(), turn.key);
  }
});

test("EXTRACTION_GUIDE carries all four turns, unrendered, with their shapes", () => {
  const guide = P.EXTRACTION_GUIDE;
  assert.ok(guide.startsWith("# Rhylthyme extraction guide"));
  for (const turn of P.FOUR_TURNS) {
    assert.ok(guide.includes(`## ${turn.key} — ${turn.name}`), turn.key);
    assert.ok(guide.includes(turn.template), `${turn.key} template missing from the guide`);
    assert.ok(guide.includes(turn.expected), `${turn.key} expected shape missing from the guide`);
    assert.ok(guide.includes(turn.purpose));
    for (const slot of turn.slots) assert.ok(guide.includes("`{" + slot + "}`"), `${turn.key} slot ${slot}`);
  }
  // The turn table and the provenance contract.
  assert.ok(guide.includes("| T1 read-back |"));
  assert.ok(guide.includes("metadata.sourceSpan"));
  assert.ok(guide.includes("metadata.inferred"));
  // The templates embed ```json blocks, so the guide must fence them wider.
  assert.ok(guide.includes("`````"));
});

test("T4 splits into a core half and the host workflow tail", () => {
  // rhylthyme-server's server-side `enrich` pass renders the relationship
  // half on its own: it holds the validator in-process and has no MCP
  // tools to hand the model, so the six numbered tool steps would be a
  // lie. The concatenation must stay byte-identical to what
  // plan_schedule has always sent.
  assert.equal(P.T4_RELATIONSHIPS_CORE + P.T4_HOST_WORKFLOW_TAIL, P.T4_RELATIONSHIPS);
  assert.equal(P.FOUR_TURNS[3].template, P.T4_RELATIONSHIPS);

  // The core is self-contained: the tracks/triggers/refinement sections
  // and the expected program shape, and no slots at all.
  assert.deepEqual(P.slotsIn(P.T4_RELATIONSHIPS_CORE), []);
  assert.equal(P.render(P.T4_RELATIONSHIPS_CORE, {}), P.T4_RELATIONSHIPS_CORE);
  assert.ok(P.T4_RELATIONSHIPS_CORE.startsWith("Turn 4 of 4 — "));
  assert.ok(P.T4_RELATIONSHIPS_CORE.includes("**First, tracks.**"));
  assert.ok(P.T4_RELATIONSHIPS_CORE.includes("**Second, triggers.**"));
  assert.ok(P.T4_RELATIONSHIPS_CORE.includes("**Third, refine the question"));
  assert.ok(P.T4_RELATIONSHIPS_CORE.includes(P.EXPECTED_OUTPUT.T4));
  assert.ok(!P.T4_RELATIONSHIPS_CORE.includes("Then finish the job with the tools"));

  // Both slots live in the tail, which is only about the tools.
  assert.deepEqual(P.slotsIn(P.T4_HOST_WORKFLOW_TAIL), ["catalogTools", "finishAtArg"]);
  assert.ok(P.T4_HOST_WORKFLOW_TAIL.includes("Then finish the job with the tools:"));
  for (const n of ["1.", "2.", "3.", "4.", "5.", "6."]) {
    assert.ok(P.T4_HOST_WORKFLOW_TAIL.includes("\n" + n + " "), n);
  }
  assert.ok(P.T4_HOST_WORKFLOW_TAIL.includes("validate_program"));
  assert.ok(P.T4_HOST_WORKFLOW_TAIL.includes("visualize_schedule"));
});
