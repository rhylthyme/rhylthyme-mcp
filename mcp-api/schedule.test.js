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

function cookies() {
  return {
    schemaVersion: "0.3.0-alpha", programId: "cookies", name: "Cookies", environmentType: "kitchen",
    tracks: [{ trackId: "cookies", name: "Cookies", steps: [
      { stepId: "mix", name: "Mix", task: "prep", duration: { type: "fixed", seconds: 900 }, startTrigger: { type: "programStart" } },
      { stepId: "bake", name: "Bake", task: "oven", duration: { type: "fixed", seconds: 720 },
        replicates: { count: 3, mode: "serial" }, startTrigger: { type: "afterStep", stepId: "mix" } },
      { stepId: "cool", name: "Cool", task: "rack", duration: { type: "fixed", seconds: 900 },
        startTrigger: { type: "afterStep", stepId: "bake", instances: "each" } },
      { stepId: "box", name: "Box", task: "prep", duration: { type: "fixed", seconds: 300 },
        startTrigger: { type: "afterStep", stepId: "cool", instances: "all" } },
    ] }],
    resourceConstraints: [{ task: "prep", maxConcurrent: 1 }, { task: "oven", maxConcurrent: 1 }, { task: "rack", maxConcurrent: 2 }],
  };
}

test("0.3.0-alpha `instances` program validates and resolves per instance", () => {
  const p = cookies();
  const v = S.validateProgram(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.errors.length, 0);
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(v.info, [], "explicit instances: no implicit-barrier note");
  // Expanded ids: serial bake chain in-track, one cool per instance, a barrier into box.
  const e = R.expandReplicates(p);
  assert.deepEqual(e.tracks.map((t) => t.trackId), ["cookies", "cookies--bake-r1", "cookies--bake-r2", "cookies--bake-r3"]);
  assert.equal(e.tracks[1].parentTrackId, "cookies");
  const cool2 = e.tracks[2].steps[0];
  assert.deepEqual(cool2.startTrigger, { type: "afterStep", stepId: "bake-r2" });
  assert.equal(cool2.instanceOf, "cool"); assert.equal(cool2.instanceIndex, 2);
  assert.ok(!JSON.stringify(e).includes('"instances"'), "no 0.3.0 construct survives expansion");
  const a = S.analyzeSchedule(p);
  assert.equal(a.makespanSeconds, 4260);
  const t = R.computeStepTimings(p);
  assert.deepEqual([t["cool-r1"].start, t["cool-r2"].start, t["cool-r3"].start, t.box.start], [1620, 2340, 3060, 3960]);
  assert.equal(a.resourceConflicts.length, 0, JSON.stringify(a.resourceConflicts));
});

test("instances: \"any\" starts on the first instance; 0.2.0 join semantics unchanged", () => {
  const p = cookies();
  p.tracks[0].steps[3].startTrigger = { type: "afterStep", stepId: "cool", instances: "any" };
  const e = R.expandReplicates(p);
  assert.equal(e.tracks[0].steps[4].startTrigger.logic, "any");
  assert.equal(R.computeStepTimings(p).box.start, 2520);
  // Same program without `instances` (0.2.0 reading): cool waits for all bakes.
  const q = cookies();
  q.schemaVersion = "0.2.0-alpha";
  delete q.tracks[0].steps[2].startTrigger.instances;
  delete q.tracks[0].steps[3].startTrigger.instances;
  assert.equal(S.validateProgram(q).valid, true);
  const tq = R.computeStepTimings(q);
  assert.equal(tq.cool.start, 3060);
  assert.equal(tq.box.start, 3960);
});

test("an expansion the expander cannot express is a validation error, not a throw", () => {
  // Mixed join logic inside one compound has no PRD code yet; the
  // expander's raise is reported as expansion_failed (the backstop).
  const p = cookies();
  p.tracks[0].steps[3].startTrigger = { logic: "any", triggers: [
    { type: "afterStep", stepId: "cool", instances: "all" }, { type: "afterStep", stepId: "mix" },
  ] };
  const v = S.validateProgram(p);
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, "expansion_failed");
  assert.match(v.errors[0].message, /cool/);
  assert.ok(v.errors[0].fix);
});

test("instance checks run before expansion and carry the PRD codes and fix hints", () => {
  // E_EACH_WITH_REPLICATES: the expander would throw; the code wins.
  let p = cookies();
  p.tracks[0].steps[2].replicates = { count: 2 };
  let v = S.validateProgram(p);
  assert.equal(v.valid, false);
  assert.deepEqual(v.errors.map((e) => e.code), ["E_EACH_WITH_REPLICATES"]);
  assert.equal(v.errors[0].where, "step:cool");
  assert.equal(v.errors[0].fix, "drop `replicates` on `cool`; it inherits `3` instances from `bake`");

  // E_INSTANCES_ON_SINGLE: the expander silently strips; the validator reports.
  // cool's "each" on the unreplicated mix is wrong, and so, in turn, is
  // box's "all" on cool (no longer "each"-derived): one finding per misuse.
  p = cookies();
  p.tracks[0].steps[2].startTrigger = { type: "afterStep", stepId: "mix", instances: "each" };
  v = S.validateProgram(p);
  // Validation continues on the expanded program (cool now overlaps the
  // bake chain in-track), so compare only the instance codes.
  const instErrs = (r) => r.errors.filter((e) => /^E_/.test(e.code));
  assert.deepEqual(instErrs(v).map((e) => [e.code, e.where]), [["E_INSTANCES_ON_SINGLE", "step:cool"], ["E_INSTANCES_ON_SINGLE", "step:box"]]);
  assert.equal(instErrs(v)[0].fix, "remove `instances`, or add `replicates` to `mix`");
  assert.equal(instErrs(v)[1].fix, "remove `instances`, or add `replicates` to `cool`");
  assert.ok(v.errors.some((e) => e.code === "track_overlap"), "later checks still run");
  p.tracks[0].steps[3].startTrigger = { type: "afterStep", stepId: "cool" };
  assert.deepEqual(instErrs(S.validateProgram(p)).map((e) => e.code), ["E_INSTANCES_ON_SINGLE"]);

  // E_EACH_COUNT_MISMATCH on a compound "each"; equal counts pair i -> i.
  const pair = (ny) => ({
    schemaVersion: "0.3.0-alpha", programId: "pair", name: "Pair",
    tracks: [
      { trackId: "a", name: "A", steps: [fixed("x", 100, { type: "programStart" }, { replicates: { count: 2, mode: "stagger", delay: 50 } })] },
      { trackId: "b", name: "B", steps: [fixed("y", 80, { type: "programStart" }, { replicates: { count: ny, mode: "stagger", delay: 200 } })] },
      { trackId: "c", name: "C", steps: [fixed("s", 10, { logic: "all", triggers: [
        { type: "afterStep", stepId: "x", instances: "each" }, { type: "afterStep", stepId: "y", instances: "each" },
      ] })] },
    ],
    resourceConstraints: [{ task: "prep", maxConcurrent: 9 }],
  });
  v = S.validateProgram(pair(3));
  assert.deepEqual(v.errors.map((e) => e.code), ["E_EACH_COUNT_MISMATCH"]);
  assert.equal(v.errors[0].fix, "both upstream steps must have `count: 2`");
  v = S.validateProgram(pair(2));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings.map((w) => w.code), [], "the other root of a compound each is not a later step");
  const t = R.computeStepTimings(pair(2));
  assert.deepEqual([t["s-r1"].start, t["s-r2"].start], [Math.max(100, 80), Math.max(150, 280)]);

  // W_UNBARRIERED_CHAIN is a warning: valid stays true.
  p = cookies();
  p.tracks[0].steps.pop(); // drop box
  p.tracks.push({ trackId: "cleanup", name: "Cleanup", steps: [fixed("wipe", 300, { type: "programStartOffset", offsetSeconds: 3600 })] });
  v = S.validateProgram(p);
  assert.equal(v.valid, true);
  assert.deepEqual(v.warnings.map((w) => w.code), ["W_UNBARRIERED_CHAIN"]);
  assert.equal(v.warnings[0].where, "step:bake");
  assert.ok(v.warnings[0].fix.includes('instances:"all"'));
});

test("I_IMPLICIT_BARRIER is an info note on a 0.3.0 program, never on 0.2.0", () => {
  const p = cookies();
  delete p.tracks[0].steps[3].startTrigger.instances; // box waits for cool without instances
  const v = S.validateProgram(p);
  assert.equal(v.valid, true);
  assert.equal(v.errors.length + v.warnings.length, 0);
  assert.deepEqual(v.info.map((i) => i.code), ["I_IMPLICIT_BARRIER"]);
  assert.equal(v.info[0].where, "step:box");
  assert.ok(v.info[0].fix.includes('instances: "all"'));
  assert.match(S.formatValidation(v), /I_IMPLICIT_BARRIER/);
  // Explicit "all": no note. 0.2.0 program: no note (default join is not advisory there).
  assert.deepEqual(S.validateProgram(cookies()).info, []);
  p.schemaVersion = "0.2.0-alpha";
  delete p.tracks[0].steps[2].startTrigger.instances;
  assert.deepEqual(S.validateProgram(p).info, []);
});

test("every invalid/<CODE>.json provokes exactly its declared finding", () => {
  const dir = path.join(__dirname, "..", "..", "rhylthyme-examples", "invalid");
  if (!fs.existsSync(dir)) return; // examples not checked out alongside
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length >= 7, "one negative example per validator code");
  for (const code of ["E_INSTANCES_ON_SINGLE", "E_EACH_WITH_REPLICATES", "E_EACH_COUNT_MISMATCH",
    "E_INFLIGHT_GT_COUNT", "E_INFLIGHT_NO_CHAIN", "W_UNBARRIERED_CHAIN", "I_IMPLICIT_BARRIER"]) {
    assert.ok(files.includes(`${code}.json`), `invalid/${code}.json is missing`);
  }
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const expected = p.metadata && p.metadata.expectedFinding;
    assert.ok(expected && expected.code && expected.severity, `${f}: metadata.expectedFinding`);
    assert.equal(path.basename(f, ".json"), expected.code, `${f}: named after its code`);
    const v = S.validateProgram(p);
    const bucket = { error: v.errors, warning: v.warnings, info: v.info }[expected.severity];
    const hits = bucket.filter((x) => x.code === expected.code);
    assert.equal(hits.length, 1, `${f}: expected one ${expected.code}, got ${JSON.stringify({ e: v.errors, w: v.warnings, i: v.info })}`);
    assert.ok(hits[0].fix && hits[0].where && hits[0].message, `${f}: finding carries fix/where/message`);
    if (expected.severity === "error") {
      assert.equal(v.valid, false, `${f}: an error must invalidate`);
      assert.deepEqual(v.errors.map((x) => x.code), [expected.code], `${f}: no other errors`);
    } else {
      assert.equal(v.valid, true, `${f}: ${JSON.stringify(v.errors)}`);
    }
  }
});

test("validator agrees with the Python validator across the example corpus", () => {
  // Both validators expand replicates before checking, and both reject
  // the same three programs: two for within-track overlaps and one for
  // tasks with no resource constraint. Verified against the Python
  // validator on 2026-09-09.
  const dir = path.join(__dirname, "..", "..", "rhylthyme-examples", "programs");
  if (!fs.existsSync(dir)) return; // examples not checked out alongside
  const knownBroken = new Set([
    "academy_awards_ceremony.json",
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

// ---------------------------------------------------------------------
// Phase 4: in-flight windows and the binding constraint (PRD §6.2, §7)
// ---------------------------------------------------------------------

function cookiesInFlight() {
  const p = cookies();
  p.tracks[0].steps[1].replicates.maxInFlight = 2;
  return p;
}

// The expanded cookie program with its synthetic gates relaxed to fire
// on the leaf's *start* instead of its end: the `_synthetic` markers
// survive (so the analyzer still knows the cap) but they no longer hold
// anything back, which is exactly the hand-edited schedule the in-flight
// sweep exists to catch.
function relaxedGates(program) {
  const e = JSON.parse(JSON.stringify(R.expandReplicates(program)));
  e.tracks.forEach((t) => (t.steps || []).forEach((s) => {
    const trig = s.startTrigger || {};
    const atoms = Array.isArray(trig.triggers) ? trig.triggers : [trig];
    atoms.forEach((a) => { if (a && a._synthetic === "inFlight") a.event = "start"; });
  }));
  return e;
}

test("every resourceConflicts item carries a kind", () => {
  const p = JSON.parse(JSON.stringify(GOOD));
  p.resourceConstraints = [{ task: "prep", maxConcurrent: 1 }];
  const a = S.analyzeSchedule(p);
  assert.ok(a.resourceConflicts.length >= 1);
  assert.ok(a.resourceConflicts.every((c) => c.kind === "maxConcurrent"), JSON.stringify(a.resourceConflicts));
  assert.match(S.formatAnalysis(a), /\[maxConcurrent\]/);
});

test("cookie example: the rack, not the oven, binds the critical path", () => {
  const a = S.analyzeSchedule(cookiesInFlight());
  assert.equal(a.makespanSeconds, 4440);
  assert.deepEqual(a.criticalPath, ["mix", "bake-r1", "cool-r1", "bake-r3", "cool-r3", "box"]);
  assert.deepEqual(a.resourceConflicts, [], "a correct expansion never over-subscribes its own cap");

  // One binding constraint per critical-path edge; the bake-r3 edge is
  // the rack's in-flight cap and nothing on the path names the oven.
  assert.equal(a.bindingConstraints.length, a.criticalPath.length - 1);
  const gate = a.bindingConstraints.find((b) => b.to === "bake-r3");
  assert.deepEqual(gate, { from: "cool-r1", to: "bake-r3", kind: "inFlight", task: "rack", limit: 2, inFlightOf: "bake" });
  assert.ok(!a.bindingConstraints.some((b) => b.task === "oven"), JSON.stringify(a.bindingConstraints));
  assert.deepEqual(a.bindingConstraints.filter((b) => b.kind !== "inFlight").map((b) => b.kind), ["dependency", "dependency", "dependency", "dependency"]);

  // In-flight windows: instance i runs from bake-r<i> start to cool-r<i> end.
  assert.equal(a.inFlight.length, 1);
  const g = a.inFlight[0];
  assert.equal(g.inFlightOf, "bake");
  assert.equal(g.maxInFlight, 2);
  assert.equal(g.count, 3);
  assert.equal(g.task, "rack");
  assert.deepEqual(g.leafSteps, ["cool"]);
  assert.deepEqual(g.windows.map((w) => [w.stepId, w.startSeconds, w.endSeconds]),
    [["bake-r1", 900, 2520], ["bake-r2", 1620, 3240], ["bake-r3", 2520, 4140]]);
  assert.deepEqual(g.windows.map((w) => w.leafStepIds), [["cool-r1"], ["cool-r2"], ["cool-r3"]]);
  assert.equal(g.peakInFlight, 2, "the cap is respected, and reached");

  // Instance sub-tracks are their own slack rows, tagged for grouping.
  const sub = a.tracks.find((t) => t.trackId === "cookies--bake-r1");
  assert.equal(sub.parentTrackId, "cookies");
  assert.equal(sub.steps, 1);
  assert.equal(sub.slackBeforeFinishSeconds, 1920);
  assert.equal(a.tracks.find((t) => t.trackId === "cookies").parentTrackId, null);
  const cool1 = a.steps.find((s) => s.stepId === "cool-r1");
  assert.equal(cool1.instanceOf, "cool");
  assert.equal(cool1.instanceIndex, 1);
  assert.equal(cool1.parentTrackId, "cookies");
  assert.equal(a.steps.find((s) => s.stepId === "mix").instanceOf, null);

  const digest = S.formatAnalysis(a);
  assert.match(digest, /\*\*Binding constraints:\*\* `rack` \(in-flight ≤ 2\) gates `bake-r3`\./);
  assert.match(digest, /\*\*In-flight windows \(1\):\*\*/);
  assert.match(digest, /`bake` ×3 through `rack`: maxInFlight 2, peak 2/);
});

test("the same kitchen with rack maxConcurrent only reports a maxConcurrent conflict instead", () => {
  // PRD §7's counterexample: without maxInFlight the third bake runs
  // 39-51 min and the trays pile up on the rack rather than the oven
  // being held back. A 30-minute cool makes the pile-up visible.
  const p = cookies();
  p.tracks[0].steps[2].duration = { type: "fixed", seconds: 1800 };
  const a = S.analyzeSchedule(p);
  const bake3 = a.steps.find((s) => s.stepId === "bake-r3");
  assert.deepEqual([bake3.startSeconds, bake3.endSeconds], [2340, 3060], "39-51 min, per PRD §7");
  assert.deepEqual(a.inFlight, [], "no maxInFlight, no in-flight group");
  assert.equal(a.resourceConflicts.length, 1);
  const c = a.resourceConflicts[0];
  assert.equal(c.kind, "maxConcurrent");
  assert.equal(c.task, "rack");
  assert.equal(c.maxConcurrent, 2);
  assert.ok(c.steps.includes("cool-r3"), JSON.stringify(c));
  assert.deepEqual([c.startSeconds, c.endSeconds], [3060, 3420]);
  assert.ok(a.bindingConstraints.every((b) => b.kind === "dependency"), JSON.stringify(a.bindingConstraints));
  assert.match(S.formatAnalysis(a), /Binding constraints:\*\* step dependencies only/);
});

test("in-flight over-subscription fires on a schedule whose gates were stripped", () => {
  const a = S.analyzeSchedule(relaxedGates(cookiesInFlight()));
  // bake-r3 is no longer held: three trays are between bake and box.
  assert.equal(a.steps.find((s) => s.stepId === "bake-r3").startSeconds, 2340);
  assert.equal(a.resourceConflicts.length, 1);
  const c = a.resourceConflicts[0];
  assert.equal(c.kind, "inFlight");
  assert.equal(c.task, "rack");
  assert.equal(c.inFlightOf, "bake");
  assert.equal(c.maxInFlight, 2);
  assert.equal(c.demand, 3);
  assert.deepEqual(c.steps, ["bake-r1", "bake-r2", "bake-r3"]);
  assert.deepEqual([c.startSeconds, c.endSeconds], [2340, 2520]);
  assert.match(c.fix, /maxInFlight/);
  assert.equal(a.inFlight[0].peakInFlight, 3);
  assert.match(S.formatAnalysis(a), /\[inFlight\] `rack` holds 3 instances of `bake` but maxInFlight is 2/);
});

test("both kinds are reported when both limits are violated", () => {
  const p = relaxedGates(cookiesInFlight());
  p.tracks.forEach((t) => t.steps.forEach((s) => { if (s.instanceOf === "cool") s.duration = { type: "fixed", seconds: 1800 }; }));
  const a = S.analyzeSchedule(p);
  assert.deepEqual(a.resourceConflicts.map((c) => c.kind).sort(), ["inFlight", "maxConcurrent"]);
  assert.ok(a.resourceConflicts.every((c) => c.task === "rack"));
  const digest = S.formatAnalysis(a);
  assert.match(digest, /\[maxConcurrent\]/);
  assert.match(digest, /\[inFlight\]/);
});

test("a critical edge gated by a freeing maxConcurrent task is reported as such", () => {
  // `bake` is ready when `mix` ends at 300 but only starts at 1800 —
  // exactly when the single oven is released by `roast`.
  const p = {
    schemaVersion: "0.2.0-alpha", programId: "oven-bound", name: "Oven bound",
    tracks: [
      { trackId: "a", name: "A", steps: [
        { stepId: "mix", name: "Mix", task: "prep", duration: { type: "fixed", seconds: 300 }, startTrigger: { type: "programStart" } },
        { stepId: "bake", name: "Bake", task: "oven", duration: { type: "fixed", seconds: 600 },
          startTrigger: { logic: "all", triggers: [{ type: "afterStep", stepId: "mix" }, { type: "programStartOffset", offsetSeconds: 1800 }] } },
      ] },
      { trackId: "b", name: "B", steps: [
        { stepId: "roast", name: "Roast", task: "oven", duration: { type: "fixed", seconds: 1800 }, startTrigger: { type: "programStart" } },
      ] },
    ],
    resourceConstraints: [{ task: "prep", maxConcurrent: 1 }, { task: "oven", maxConcurrent: 1 }],
  };
  const a = S.analyzeSchedule(p);
  assert.deepEqual(a.criticalPath, ["mix", "bake"]);
  assert.deepEqual(a.bindingConstraints, [{ from: "mix", to: "bake", kind: "maxConcurrent", task: "oven", limit: 1 }]);
  assert.match(S.formatAnalysis(a), /`oven` \(maxConcurrent 1\) gates `bake`/);
});

test("inFlightGroups / inFlightWindows are exported for the planners", () => {
  const e = R.expandReplicates(cookiesInFlight());
  const t = R.computeStepTimings(e);
  const groups = S.inFlightGroups(e);
  assert.deepEqual(groups.map((g) => [g.inFlightOf, g.maxInFlight, g.count, g.task]), [["bake", 2, 3, "rack"]]);
  assert.deepEqual(groups[0].gatedSteps, ["bake-r3"]);
  assert.deepEqual(S.inFlightWindows(e, t)[0].windows.map((w) => w.endSeconds), [2520, 3240, 4140]);
  assert.deepEqual(S.inFlightConflicts(e, t), []);
  // A program with no maxInFlight has no groups at all.
  assert.deepEqual(S.inFlightGroups(R.expandReplicates(cookies())), []);
});

// ---------------------------------------------------------------------
// Prediction (Phase 6 of plans/execution-history-duration-prediction.md,
// PRD §7): analyzeSchedule against the program's own execution history.
// ---------------------------------------------------------------------

const HIST_DIR = path.join(
  __dirname, "..", "..", "rhylthyme-cli-runner", "tests", "fixtures", "history"
);
const TG_PROGRAM = path.join(__dirname, "..", "static", "examples", "thanksgiving_one_oven.json");
const TG_RUNS = path.join(HIST_DIR, "thanksgiving-synth-runs.json");

function thanksgiving() {
  if (!fs.existsSync(TG_PROGRAM) || !fs.existsSync(TG_RUNS)) return null;
  const runs = JSON.parse(fs.readFileSync(TG_RUNS, "utf8")).runs;
  return {
    program: JSON.parse(fs.readFileSync(TG_PROGRAM, "utf8")),
    runs,
    // A 7 kg turkey in an electric oven: nothing in the history matches that
    // exactly, so the model answers (see history.test.js for the law).
    context: {
      programVersion: runs[0].programVersion,
      environmentId: "home-kitchen",
      userTags: { turkeyKg: 7, oven: "electric" },
    },
  };
}

test("withDurations substitutes a duration per step without touching the original", () => {
  const p = {
    tracks: [{ trackId: "t", steps: [
      fixed("f", 600, { type: "programStart" }),
      { stepId: "v", name: "V", task: "prep", startTrigger: { type: "afterStep", stepId: "f" },
        duration: { type: "variable", minSeconds: 900, maxSeconds: 1500, defaultSeconds: 1200 } },
      { stepId: "i", name: "I", task: "prep", startTrigger: { type: "afterStep", stepId: "v" },
        duration: { type: "indefinite", defaultSeconds: 9900 } },
      { stepId: "untouched", name: "U", task: "prep", startTrigger: { type: "programStart" },
        duration: "5m" },
    ] }],
  };
  const out = S.withDurations(p, { f: 900, v: 2000, i: 1230 });
  assert.deepEqual(out.tracks[0].steps[0].duration, { type: "fixed", seconds: 900 });
  // A variable step keeps its kind; the range is widened, never narrowed.
  assert.deepEqual(out.tracks[0].steps[1].duration,
    { type: "variable", minSeconds: 900, maxSeconds: 2000, defaultSeconds: 2000 });
  assert.deepEqual(out.tracks[0].steps[2].duration, { type: "indefinite", defaultSeconds: 1230 });
  assert.equal(out.tracks[0].steps[3].duration, "5m", "a step with no prediction is left alone");
  // A prediction below the author's floor widens the floor instead.
  assert.equal(S.withDurations(p, { v: 300 }).tracks[0].steps[1].duration.minSeconds, 300);
  // The input is never mutated.
  assert.deepEqual(p.tracks[0].steps[0].duration, { type: "fixed", seconds: 600 });
  assert.equal(p.tracks[0].steps[2].duration.defaultSeconds, 9900);
  // No map, no copy.
  assert.equal(S.withDurations(p, {}), p);
  assert.equal(S.withDurations(p, null), p);
  // Replicate instances match on the authored id.
  const rep = { tracks: [{ trackId: "t", steps: [
    { stepId: "bake-r1", instanceOf: "bake", duration: { type: "fixed", seconds: 900 }, startTrigger: { type: "programStart" } },
    { stepId: "bake-r2", instanceOf: "bake", duration: { type: "fixed", seconds: 900 }, startTrigger: { type: "programStart" } },
  ] }] };
  const repOut = S.withDurations(rep, { bake: 1200 });
  assert.equal(repOut.tracks[0].steps[0].duration.seconds, 1200);
  assert.equal(repOut.tracks[0].steps[1].duration.seconds, 1200);
});

test("with no history the analysis is exactly what it was before prediction existed", (t) => {
  const tg = thanksgiving();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const plain = S.analyzeSchedule(tg.program);
  // The new keys appear only when history is supplied, so a default call
  // serializes identically to before.
  assert.equal(plain.durationsUsed, undefined);
  assert.equal(plain.predictedMakespan, undefined);
  assert.equal(plain.predictedCriticalPath, undefined);
  assert.ok(plain.steps.every((s) => s.predicted === undefined && s.plannedDurationSeconds === undefined));
  // An empty history is no history; asking for predicted durations without
  // any changes nothing either.
  assert.deepEqual(S.analyzeSchedule(tg.program, { history: [] }), plain);
  assert.deepEqual(S.analyzeSchedule(tg.program, { useDurations: "predicted" }), plain);
  // Records of another program are not this program's history.
  const foreign = S.analyzeSchedule(tg.program, {
    history: tg.runs.map((r) => Object.assign({}, r, { programId: "somebody-else" })),
    predictionContext: tg.context,
    useDurations: "predicted",
  });
  assert.equal(foreign.makespanSeconds, plain.makespanSeconds);
  assert.equal(foreign.durationsUsed, "predicted");
  assert.equal(foreign.predictedMakespanSeconds, plain.makespanSeconds);
});

test("history adds predicted fields and leaves the planned schedule in charge", (t) => {
  const tg = thanksgiving();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const plain = S.analyzeSchedule(tg.program);
  const a = S.analyzeSchedule(tg.program, { history: tg.runs, predictionContext: tg.context });

  assert.equal(a.durationsUsed, "planned", "the default plans on what the program says");
  assert.equal(a.makespanSeconds, plain.makespanSeconds);
  assert.deepEqual(a.criticalPath, plain.criticalPath);
  assert.equal(a.plannedMakespanSeconds, plain.makespanSeconds);
  assert.ok(a.predictedMakespanSeconds < plain.makespanSeconds,
    "the history says the roast is far shorter than the author guessed");
  assert.ok(Array.isArray(a.predictedCriticalPath));

  // Every step reports its planned duration; only steps with history are
  // predicted, and fixed steps never are (their length confirms a timer).
  a.steps.forEach((s) => assert.equal(typeof s.plannedDurationSeconds, "number", s.stepId));
  const predicted = a.steps.filter((s) => s.predicted);
  assert.deepEqual(predicted.map((s) => s.stepId).sort(), ["potatoes-boil", "turkey-roast"]);
  assert.equal(a.steps.find((s) => s.stepId === "turkey-prep").predicted, undefined);

  const roast = a.steps.find((s) => s.stepId === "turkey-roast");
  assert.equal(roast.plannedDurationSeconds, 9900);
  assert.equal(roast.durationSeconds, 9900, "planned mode keeps the planned duration on the clock");
  assert.deepEqual(Object.keys(roast.predicted).sort(),
    ["basis", "factors", "high", "low", "method", "n", "seconds", "source"]);
  assert.equal(roast.predicted.basis, "model");
  assert.equal(roast.predicted.n, 20);
  assert.ok(Math.abs(roast.predicted.seconds - 1230) / 1230 < 0.05);
  assert.ok(roast.predicted.low < roast.predicted.seconds && roast.predicted.seconds < roast.predicted.high);
});

test("useDurations: predicted changes the makespan, the itinerary and the critical path", (t) => {
  const tg = thanksgiving();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const planned = S.analyzeSchedule(tg.program, { history: tg.runs, predictionContext: tg.context });
  const a = S.analyzeSchedule(tg.program, {
    history: tg.runs, predictionContext: tg.context, useDurations: "predicted",
  });

  assert.equal(a.durationsUsed, "predicted");
  assert.equal(a.makespanSeconds, a.predictedMakespanSeconds, "the clock is the predicted one");
  assert.equal(a.plannedMakespanSeconds, planned.makespanSeconds);
  assert.ok(a.makespanSeconds < planned.makespanSeconds);

  // The roast is on the clock for its predicted length, and its planned
  // length is still reported beside it.
  const roast = a.steps.find((s) => s.stepId === "turkey-roast");
  assert.ok(Math.abs(roast.durationSeconds - roast.predicted.seconds) < 1e-6,
    `${roast.durationSeconds} != ${roast.predicted.seconds}`);
  assert.equal(roast.plannedDurationSeconds, 9900);

  // The itinerary moves: everything the roast gates starts earlier.
  const restBefore = planned.steps.find((s) => s.stepId === "turkey-rest").startSeconds;
  const restAfter = a.steps.find((s) => s.stepId === "turkey-rest").startSeconds;
  assert.ok(restAfter < restBefore, `${restAfter} !< ${restBefore}`);

  // And the critical path is recomputed, not copied.
  assert.deepEqual(a.criticalPath, a.predictedCriticalPath);
  assert.notDeepEqual(a.criticalPath, planned.criticalPath);

  // Wall-clock anchoring works off the predicted makespan, which is the whole
  // point of "when do I start if we eat at six?".
  const anchored = S.analyzeSchedule(tg.program, {
    history: tg.runs, predictionContext: tg.context, useDurations: "predicted",
    finishAt: "2026-11-26T18:00:00Z",
  });
  assert.equal(anchored.wallClock.finishAt, "2026-11-26T18:00:00.000Z");
  assert.equal(
    new Date(anchored.wallClock.startAt).getTime(),
    new Date("2026-11-26T18:00:00Z").getTime() - anchored.makespanSeconds * 1000
  );
});

test("an executor-controlled verdict keeps a step on its planned duration", (t) => {
  const tg = thanksgiving();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const context = Object.assign({}, tg.context, { verdicts: { "turkey-roast": "executor-controlled" } });
  const a = S.analyzeSchedule(tg.program, {
    history: tg.runs, predictionContext: context, useDurations: "predicted",
  });
  const roast = a.steps.find((s) => s.stepId === "turkey-roast");
  assert.equal(roast.predicted.basis, "none");
  assert.equal(roast.predicted.reason, "executor-controlled");
  assert.equal(roast.durationSeconds, 9900, "no number, so the plan stands");
  // potatoes-boil is still predicted, so the makespan is not simply the plan.
  assert.ok(a.steps.find((s) => s.stepId === "potatoes-boil").predicted.seconds > 0);
});

test("formatAnalysis reports the predicted makespan and a line per predicted step", (t) => {
  const tg = thanksgiving();
  if (!tg) { t.skip("Thanksgiving example or synthetic runs not present"); return; }
  const plain = S.formatAnalysis(S.analyzeSchedule(tg.program));
  assert.ok(!plain.includes("Predicted"), "no history, no prediction in the digest");
  assert.ok(!plain.includes("Durations used"));

  const text = S.formatAnalysis(S.analyzeSchedule(tg.program, {
    history: tg.runs, predictionContext: tg.context,
  }));
  assert.ok(text.includes("**Durations used:** planned"), text);
  assert.ok(/\*\*predicted makespan [^*]+\*\*/.test(text), text);
  assert.ok(text.includes("**Predicted durations (2 of 13 steps have history):**"), text);
  assert.ok(/- Roast until 74°C: \*\*\d+m\*\* predicted vs 2h 45m planned \(\d+m–\d+m\) — model on turkeyKg, n=20/.test(text), text);
  assert.ok(text.includes("— median, n=20"), "a step with no correlating factor says median");

  const usePredicted = S.formatAnalysis(S.analyzeSchedule(tg.program, {
    history: tg.runs, predictionContext: tg.context, useDurations: "predicted",
  }));
  assert.ok(usePredicted.includes("**Durations used:** predicted"), usePredicted);

  // A blocked step is named as unpredicted rather than silently dropped.
  const blocked = S.formatAnalysis(S.analyzeSchedule(tg.program, {
    history: tg.runs,
    predictionContext: Object.assign({}, tg.context, { verdicts: { "turkey-roast": "executor-controlled" } }),
  }));
  assert.ok(blocked.includes("not predicted: Roast until 74°C (executor-controlled)"), blocked);
});

test("predictDurations and predictedSeconds are re-exported for callers of schedule.js", () => {
  assert.equal(typeof S.predictDurations, "function");
  assert.equal(typeof S.predictedSeconds, "function");
  assert.deepEqual(S.predictedSeconds({ a: { seconds: 60 }, b: { seconds: null } }), { a: 60 });
});

test("one prediction covers every replicate instance, and the expansion survives it", (t) => {
  const file = path.join(__dirname, "..", "static", "examples", "cookies_three_trays.json");
  if (!fs.existsSync(file)) { t.skip("cookies example not present"); return; }
  const program = JSON.parse(fs.readFileSync(file, "utf8"));
  // History is recorded against the AUTHORED step id with an instance number,
  // so three instances of one run are three measurements of `cool`.
  const record = {
    runId: "2026-01-01T10:00:00Z-0001",
    programId: program.programId,
    programVersion: "sha256:" + "aa".repeat(32),
    runtime: { kind: "cli", version: "t", clockMode: "wall", speed: 1 },
    startedAt: "2026-01-01T10:00:00.000Z",
    outcome: "completed",
    context: { userTags: {} },
    steps: [1, 2, 3].map((i) => ({
      stepId: "cool", instance: i,
      planned: { start: 0, end: 900, durationType: "variable", defaultSeconds: 900 },
      actual: { start: 0, end: 1800 }, endedBy: "executor", pausedSeconds: 0,
    })),
  };
  const plain = S.analyzeSchedule(program);
  const a = S.analyzeSchedule(program, { history: [record], useDurations: "predicted" });

  // The prediction is keyed by `cool` and lands on every cool-r<i>.
  assert.deepEqual(
    a.steps.filter((s) => s.predicted).map((s) => s.stepId).sort(),
    ["cool-r1", "cool-r2", "cool-r3"]
  );
  a.steps.filter((s) => s.predicted).forEach((s) => {
    assert.equal(s.predicted.seconds, 1800);
    assert.equal(s.durationSeconds, 1800);
    assert.equal(s.plannedDurationSeconds, 900);
  });
  // Re-resolving a substituted copy of an already-expanded program keeps the
  // instance sub-tracks and the in-flight groups intact.
  assert.equal(a.tracks.length, plain.tracks.length);
  assert.equal(a.inFlight.length, plain.inFlight.length);
  assert.equal(a.inFlight[0].inFlightOf, "bake");
  assert.ok(a.makespanSeconds > plain.makespanSeconds, "cooling twice as long costs time");
});
