// node --test mcp-api/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const G = require("./galago.js");
const S = require("./schedule.js");
const CASES = require("./galago-command-cases.json");

test("messages match rhylthyme_galago.validate_command word for word", () => {
  for (const c of CASES) {
    assert.deepEqual(G.validateCommand(c.toolType, c.command, c.params), c.problems,
      `${c.toolType}.${c.command} ${JSON.stringify(c.params)}`);
  }
});

test("pyRepr reads like Python", () => {
  assert.equal(G.pyRepr("fast"), "'fast'");
  assert.equal(G.pyRepr("it's"), `"it's"`);
  assert.equal(G.pyRepr([1, true, null, { a: "b" }]), "[1, True, None, {'a': 'b'}]");
});

function program(...steps) {
  return {
    programId: "shake-plate", name: "Shake a plate", schemaVersion: "0.2.0-alpha",
    tracks: [{ trackId: "bench", name: "Bench", steps }],
  };
}
const load = { stepId: "load", name: "Load", duration: { type: "fixed", seconds: 3 }, startTrigger: { type: "programStart" } };
const shake = (instrument) => ({
  stepId: "shake", name: "Shake",
  instrument: Object.assign({ tool: "shaker", toolType: "bioshake", command: "start_shake", params: { speed: 1000, duration: 5 } }, instrument || {}),
  startTrigger: { type: "afterStep", stepId: "load" },
});

test("an instrument step may omit its duration", () => {
  const v = S.validateProgram(program(load, shake()));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const [noteFound] = v.info.filter((f) => f.code === "I_INSTRUMENT_DURATION");
  assert.match(noteFound.message, /ends when shaker replies\. Timings use 5 s \(from its params\)/);
  assert.equal(v.stats.makespanSeconds, 8);
});

test("a hand step still needs a duration", () => {
  const hand = { stepId: "look", name: "Look", startTrigger: { type: "programStart" } };
  const v = S.validateProgram(program(hand));
  assert.ok(v.errors.some((e) => e.code === "missing_duration"));
});

test("bad commands are errors with the CLI's wording", () => {
  const v = S.validateProgram(program(load, shake({ params: { rpm: 5 } })));
  assert.equal(v.valid, false);
  const [e] = v.errors.filter((f) => f.code === "instrument_invalid_command");
  assert.equal(e.message, "Step 'shake': shaker (bioshake) start_shake: unknown param 'rpm' (takes speed, acceleration, duration)");
  assert.equal(e.where, "step:shake");
});

test("without toolType the command is only warned about", () => {
  const v = S.validateProgram(program(load, shake({ toolType: undefined, command: "anything" })));
  assert.equal(v.valid, true);
  assert.ok(v.warnings.some((w) => w.code === "instrument_unchecked"));
});

test("unknown tool types and malformed instruments are errors", () => {
  const codes = (p) => S.validateProgram(p).errors.map((e) => e.code);
  assert.ok(codes(program(load, shake({ toolType: "blender" }))).includes("instrument_unknown_tool_type"));
  const noCommand = shake(); delete noCommand.instrument.command;
  assert.ok(codes(program(load, noCommand)).includes("instrument_bad_shape"));
  assert.ok(codes(program(load, shake({ timeoutSeconds: 0 }))).includes("instrument_bad_shape"));
  assert.ok(codes(program(load, shake({ params: [1] }))).includes("instrument_bad_shape"));
});

test("analyze_schedule times instrument steps by their estimate", () => {
  const home = { stepId: "home", name: "Home", instrument: { tool: "shaker", command: "home" }, startTrigger: { type: "afterStep", stepId: "shake" } };
  const a = S.analyzeSchedule(program(load, shake(), home));
  assert.equal(a.makespanSeconds, 3 + 5 + 60);
});

test("programs without instrument steps are unaffected", () => {
  const v = S.validateProgram(program(load));
  assert.equal(v.valid, true);
  assert.ok(!v.info.some((f) => f.code === "I_INSTRUMENT_DURATION"));
  assert.ok(!v.warnings.some((f) => f.code.startsWith("instrument")));
});

// --- Phase actions (start / until / end / onAbort) ---------------------------

const heat = (instrument, extra) => Object.assign({
  stepId: "heat", name: "Heat and stir",
  duration: { type: "fixed", seconds: 600 },
  instrument: Object.assign({
    tool: "stirrer",
    start: [{ command: "set_temperature", params: { temperature_c: 40 } }, { command: "start_heating" }],
    end: [{ command: "stop_heating" }],
  }, instrument || {}),
  startTrigger: { type: "afterStep", stepId: "load" },
}, extra || {});

test("start/end actions around a timer are valid", () => {
  const v = S.validateProgram(program(load, heat()));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.deepEqual(G.instrumentCalls(heat().instrument).map((c) => `${c.phase}:${c.tool}.${c.command}`),
    ["start:stirrer.set_temperature", "start:stirrer.start_heating", "end:stirrer.stop_heating"]);
  assert.equal(G.blockingCall(heat().instrument), null);
});

test("until is the blocking call, and actions may name another tool", () => {
  const ph = heat({ start: [{ tool: "stirrer", command: "set_speed", params: { speed_rpm: 150 } }],
    until: { command: "log_series", params: { count: 10, interval_s: 3 } }, end: undefined, tool: "ph" },
  { stepId: "ph", duration: undefined });
  delete ph.instrument.end;
  const v = S.validateProgram(program(load, ph));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.deepEqual(G.blockingCall(ph.instrument), { phase: "until", tool: "ph", command: "log_series", params: { count: 10, interval_s: 3 } });
  assert.ok(v.warnings.some((w) => w.code === "instrument_unchecked" && /actions on stirrer/.test(w.message)));
  // Timed by the until call's params (none duration-like here: the default)
  assert.ok(v.info.some((f) => f.code === "I_INSTRUMENT_DURATION" && /ends when ph replies/.test(f.message)));
});

test("galago actions on the step's tool are checked against its toolType", () => {
  const bad = shake({ command: undefined, start: [{ command: "start_shake", params: { speed: "fast" } }], end: [{ command: "no_such" }] });
  delete bad.instrument.command;
  bad.duration = { type: "fixed", seconds: 5 };
  const errors = S.validateProgram(program(load, bad)).errors.filter((e) => e.code === "instrument_invalid_command");
  assert.equal(errors.length, 2, JSON.stringify(errors));
});

test("malformed phase actions are errors", () => {
  const codes = (p) => S.validateProgram(p).errors.map((e) => e.code);
  assert.ok(codes(program(load, heat({ command: "x", until: { command: "y" } }))).includes("instrument_bad_shape"));
  assert.ok(codes(program(load, heat({ start: [] }))).includes("instrument_bad_shape"));
  assert.ok(codes(program(load, heat({ start: [{ params: {} }] }))).includes("instrument_bad_shape"));
  assert.ok(codes(program(load, heat({ end: [{ command: "a", extra: 1 }] }))).includes("instrument_bad_shape"));
  assert.ok(codes(program(load, heat({ start: undefined, end: undefined }))).includes("instrument_bad_shape"));
});

test("start/end steps without a duration end only by hand (warning)", () => {
  const v = S.validateProgram(program(load, heat({}, { duration: undefined })));
  assert.ok(v.warnings.some((w) => w.code === "instrument_no_end"));
});

test("LabMCP toolTypes are left to labmcp.js, not galago", () => {
  const step = shake({ toolType: "labmcp-ika", command: "set_temperature", params: { temperature_c: 40 } });
  const v = S.validateProgram(program(load, step));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(!v.warnings.some((w) => w.code.startsWith("instrument")), JSON.stringify(v.warnings));
});
