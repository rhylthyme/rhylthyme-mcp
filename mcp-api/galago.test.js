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
