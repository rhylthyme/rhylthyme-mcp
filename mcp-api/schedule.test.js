// node --test mcp-api/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const S = require("./schedule.js");
const R = require("../static/js/timeline-render.js");

function fixed(id, seconds, trigger, extra) {
  return Object.assign({
    stepId: id, name: id.toUpperCase(), task: "prep",
    duration: { type: "fixed", seconds },
    startTrigger: trigger,
  }, extra || {});
}

const GOOD = {
  schemaVersion: "0.1.0",
  programId: "good",
  name: "Good",
  tracks: [
    { trackId: "a", name: "A", steps: [
      fixed("a1", 600, { type: "programStart" }),
      fixed("a2", "5m", { type: "afterStep", stepId: "a1" }),
    ] },
    { trackId: "b", name: "B", steps: [
      fixed("b1", 120, { type: "programStartOffset", offsetSeconds: "10m" }),
      fixed("b2", 60, { type: "afterStepWithBuffer", stepId: "b1", bufferSeconds: 30 }),
    ] },
  ],
  resourceConstraints: [{ task: "prep", maxConcurrent: 2 }],
};

test("parseSeconds handles numbers, numeric strings and unit strings", () => {
  assert.equal(R.parseSeconds(90), 90);
  assert.equal(R.parseSeconds("90"), 90);
  assert.equal(R.parseSeconds("5m"), 300);
  assert.equal(R.parseSeconds("1h30m"), 5400);
  assert.equal(R.parseSeconds("-20m"), -1200);
  assert.equal(R.parseSeconds("2 hours 5 min"), 7500);
  assert.equal(R.parseSeconds("garbage"), 0);
  assert.equal(R.parseSeconds(null), 0);
});

test("computeStepTimings honors string durations, buffers, offsets, compound and manual triggers", () => {
  const p = { tracks: [{ trackId: "t", steps: [
    fixed("s1", "5m", { type: "programStart" }),
    fixed("s2", 60, { type: "afterStepWithBuffer", stepId: "s1", bufferSeconds: "2m" }),
    Object.assign(fixed("s3", 0, { logic: "all", triggers: [{ type: "afterStep", stepId: "s2" }, { type: "programStartOffset", offsetSeconds: "10m" }] }),
      { duration: { type: "variable", minSeconds: 10, maxSeconds: 100, defaultSeconds: 50 } }),
    fixed("s4", 30, { type: "manual" }),
    fixed("s5", 30, { type: "afterStep", stepId: "s1", event: "start", offsetSeconds: 15 }),
  ] }] };
  const t = R.computeStepTimings(p);
  assert.deepEqual([t.s1.start, t.s1.end], [0, 300]);
  assert.deepEqual([t.s2.start, t.s2.end], [420, 480]);
  assert.deepEqual([t.s3.start, t.s3.end], [600, 650]);
  assert.deepEqual([t.s4.start, t.s4.end], [650, 680]);
  assert.deepEqual([t.s5.start, t.s5.end], [15, 45]);
  Object.values(t).forEach((x) => assert.equal(x.resolved, true));
});

test("computeStepTimings marks cycles and dangling refs as unresolved", () => {
  const p = { tracks: [{ trackId: "t", steps: [
    fixed("x", 10, { type: "afterStep", stepId: "y" }),
    fixed("y", 10, { type: "afterStep", stepId: "x" }),
    fixed("z", 10, { type: "afterStep", stepId: "nope" }),
  ] }] };
  const t = R.computeStepTimings(p);
  assert.equal(t.x.resolved, false);
  assert.equal(t.y.resolved, false);
  assert.equal(t.z.resolved, false);
});

test("validateProgram passes a good program", () => {
  const v = S.validateProgram(GOOD);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.stats.tracks, 2);
  assert.equal(v.stats.steps, 4);
  assert.equal(v.stats.makespanSeconds, 900);
});

test("validateProgram reports each class of error with a fix hint", () => {
  const bad = {
    programId: "Bad Id", name: "",
    tracks: [
      { trackId: "t", name: "T", steps: [
        fixed("a", 600, { type: "programStart" }, { task: "oven" }),
        fixed("a", 60, { type: "programStart" }),                       // duplicate id + overlap
        fixed("c", 60, { type: "afterStep", stepId: "zzz" }, { task: "stove" }), // dangling + unconstrained task
        fixed("d", 60, { type: "afterStep", stepId: "e" }),
        fixed("e", 60, { type: "afterStep", stepId: "d" }),             // cycle
        { stepId: "f", name: "F", task: "oven", duration: { type: "fixed" }, startTrigger: { type: "bogus" } },
        { stepId: "g", name: "G", task: "oven", duration: { type: "variable", minSeconds: 100, maxSeconds: 10 }, startTrigger: { type: "afterStep", stepId: "f", choiceId: "x" } },
      ] },
    ],
    resourceConstraints: [{ task: "oven", maxConcurrent: 1 }, { task: "unused", maxConcurrent: 1 }],
  };
  const v = S.validateProgram(bad);
  assert.equal(v.valid, false);
  const codes = new Set(v.errors.map((e) => e.code));
  for (const c of ["missing_name", "duplicate_step_id", "dangling_step_ref", "task_not_constrained",
                   "dependency_cycle", "fixed_without_seconds", "unknown_trigger_type",
                   "variable_min_gt_max", "choice_ref_no_choice", "track_overlap"]) {
    assert.ok(codes.has(c), `expected error code ${c}; got ${Array.from(codes).join(",")}`);
  }
  assert.ok(v.warnings.some((w) => w.code === "unused_constraint"));
  assert.ok(v.warnings.some((w) => w.code === "program_id_format"));
  v.errors.forEach((e) => assert.ok(e.message && e.code));
  // Overlap check must not fire for unresolvable (cycle) steps.
  assert.ok(!v.errors.some((e) => e.code === "track_overlap" && /"D"|"E"/.test(e.message)));
});

test("validateProgram exempts choice branches from within-track overlap", () => {
  const p = {
    schemaVersion: "0.2.0-alpha", programId: "choice", name: "Choice",
    tracks: [{ trackId: "t", name: "T", steps: [
      Object.assign(fixed("pick", 10, { type: "programStart" }), { choice: { prompt: "?", options: [{ choiceId: "x", label: "X" }, { choiceId: "y", label: "Y" }] } }),
      fixed("dox", 100, { type: "afterStep", stepId: "pick", choiceId: "x" }),
      fixed("doy", 100, { type: "afterStep", stepId: "pick", choiceId: "y" }),
    ] }],
    resourceConstraints: [{ task: "prep", maxConcurrent: 1 }],
  };
  const v = S.validateProgram(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("analyzeSchedule computes makespan, critical path, conflicts and wall clock", () => {
  const p = JSON.parse(JSON.stringify(GOOD));
  p.resourceConstraints = [{ task: "prep", maxConcurrent: 1 }];
  const a = S.analyzeSchedule(p, { finishAt: "2026-11-26T18:00:00Z" });
  assert.equal(a.makespanSeconds, 900);
  assert.deepEqual(a.criticalPath, ["a1", "a2"]);
  assert.equal(a.wallClock.anchoredBy, "finishAt");
  assert.equal(a.wallClock.startAt, "2026-11-26T17:45:00.000Z");
  assert.equal(a.wallClock.finishAt, "2026-11-26T18:00:00.000Z");
  const a1 = a.steps.find((s) => s.stepId === "a1");
  assert.equal(a1.startAt, "2026-11-26T17:45:00.000Z");
  // a2 (600-900) and b1 (600-720) both use prep with max 1 → conflict.
  assert.equal(a.resourceConflicts.length >= 1, true);
  const c = a.resourceConflicts[0];
  assert.equal(c.task, "prep");
  assert.ok(c.steps.includes("a2") && c.steps.includes("b1"));
  assert.ok(a.actorPeak.concurrentSteps >= 2);
  assert.ok(S.formatAnalysis(a).includes("Critical path"));
});

test("analyzeSchedule with startAt anchors forwards", () => {
  const a = S.analyzeSchedule(GOOD, { startAt: "2026-01-01T00:00:00Z" });
  assert.equal(a.wallClock.anchoredBy, "startAt");
  assert.equal(a.wallClock.finishAt, "2026-01-01T00:15:00.000Z");
});

test("validator agrees with the Python validator across the example corpus", () => {
  // Mirrors tests/test_examples_integration.py expectations: these
  // examples are known-valid; three known-broken ones are excluded.
  const dir = path.join(__dirname, "..", "..", "rhylthyme-examples", "programs");
  if (!fs.existsSync(dir)) return; // examples not checked out alongside
  const knownBroken = new Set([
    "academy_awards_ceremony.json", "corporate_conference.json",
    "software_product_launch.json", "comprehensive_manual_demo.json",
  ]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 10);
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const v = S.validateProgram(p);
    if (knownBroken.has(f)) assert.equal(v.valid, false, `${f} should fail`);
    else assert.equal(v.valid, true, `${f}: ${JSON.stringify(v.errors.slice(0, 2))}`);
    const a = S.analyzeSchedule(p);
    assert.ok(a.makespanSeconds > 0, f);
    assert.ok(R.renderTimelineSvg(p).startsWith("<svg"), f);
  }
});
