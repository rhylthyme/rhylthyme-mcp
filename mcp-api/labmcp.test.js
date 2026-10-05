// node --test mcp-api/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const L = require("./labmcp.js");
const S = require("./schedule.js");
const CASES = require("./labmcp-check-cases.json");

test("problems and estimates match rhylthyme_labmcp word for word", () => {
  assert.equal(CASES.source.labmcp, L.CATALOG.source.labmcp, "cases and catalogue from one export");
  assert.ok(CASES.cases.length > 1000);
  for (const c of CASES.cases) {
    const label = `${c.package}.${c.command} ${JSON.stringify(c.params)}`;
    assert.deepEqual(L.callProblems(c.package, c.command, c.params), c.problems, label);
    if (c.estimate) {
      const e = L.estimateCall(c.package, c.command, c.params);
      assert.deepEqual({ seconds: e.seconds, source: e.source, detail: e.detail }, c.estimate, label);
    }
  }
});

test("pump timing checks match rhylthyme_labmcp word for word", () => {
  assert.ok(CASES.timing.some((c) => c.problems.length));
  for (const c of CASES.timing) {
    assert.deepEqual(L.timingProblems(c.package, c.command, c.params, c.phase, c.stepSeconds), c.problems,
      `${c.package}.${c.command} ${c.phase} ${c.stepSeconds}`);
  }
});

test("the catalogue carries LabMCP's attribution", () => {
  assert.equal(L.CATALOG.source.license, "Apache-2.0");
  assert.match(L.CATALOG.source.attribution, /K-Dense/);
});

test("Python's number formats", () => {
  assert.equal(L.pyRepr(1e-5), "1e-05");
  assert.equal(L.pyRepr(0.25), "0.25");
  assert.equal(L.pyRepr([1, "a", null, true]), "[1, 'a', None, True]");
  assert.equal(L.fmtG(120), "120");
  assert.equal(L.fmtG(2.5), "2.5");
  assert.equal(L.fmtG(1e6), "1e+06");
  assert.equal(L.fmtG(0.0001234), "0.0001234");
});

function program(...steps) {
  return { programId: "t", name: "T", schemaVersion: "0.2.0-alpha", tracks: [{ trackId: "bench", name: "Bench", steps }] };
}
const heat = {
  stepId: "heat", name: "Heat",
  duration: { type: "fixed", seconds: 120 },
  instrument: {
    tool: "stirrer", toolType: "labmcp-ika",
    start: [{ command: "set_temperature", params: { temperature_c: 40 } }, { command: "start_heating" }],
    end: [{ command: "stop_heating" }],
  },
  startTrigger: { type: "programStart" },
};
const log = {
  stepId: "log", name: "Log pH",
  instrument: { tool: "ph", toolType: "labmcp-atlas-ezo", until: { command: "log_series", params: { count: 10, interval_s: 3 } } },
  startTrigger: { type: "afterStep", stepId: "heat" },
};

test("validate_program checks every call on a LabMCP step's tool", () => {
  assert.equal(S.validateProgram(program(heat, log)).valid, true);
  const bad = JSON.parse(JSON.stringify(heat));
  bad.instrument.start[0].params.temperature_c = 200;
  bad.instrument.end[0].command = "stop";
  const errors = S.validateProgram(program(bad, log)).errors.map((e) => [e.code, e.message]);
  assert.deepEqual(errors, [
    ["instrument_over_limit", "Step 'heat': stirrer (labmcp-ika) set_temperature: temperature_c=200 is above the server's default limit max_temperature_c=150 °C"],
    ["instrument_invalid_command", "Step 'heat': stirrer (labmcp-ika) stop: labmcp-ika has no tool 'stop' (tools: " +
      Object.keys(L.CATALOG.packages["labmcp-ika"].tools).sort().join(", ") + ")"],
  ]);
});

test("unknown LabMCP servers are a warning, not an error", () => {
  const step = Object.assign({}, log, { instrument: Object.assign({}, log.instrument, { toolType: "labmcp-nope" }) });
  const v = S.validateProgram(program(heat, step));
  assert.equal(v.valid, true);
  assert.ok(v.warnings.some((w) => w.code === "instrument_unknown_tool_type"));
});

test("analyze_schedule times LabMCP steps by their estimate, flagged", () => {
  const a = S.analyzeSchedule(program(heat, log));
  assert.equal(a.makespanSeconds, 120 + 27);
  const v = S.validateProgram(program(heat, log));
  assert.ok(v.info.some((i) => i.code === "I_INSTRUMENT_DURATION" && /27 s \(from params\.count, params\.interval_s\)/.test(i.message)));
  const filled = L.withEstimates(program(heat, log));
  assert.deepEqual(filled.tracks[0].steps[1].duration, { type: "fixed", seconds: 27 });
  assert.deepEqual(filled.tracks[0].steps[1].metadata.durationEstimate, { source: "params", seconds: 27 });
  assert.equal(log.duration, undefined, "the input is not modified");
});
