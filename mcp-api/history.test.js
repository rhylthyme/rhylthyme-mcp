// node --test mcp-api/history.test.js
//
// Parity tests for the shared usable-run filter and duration statistics.
// The fixture is owned by the Python side (it is generated from, and asserted
// by, rhylthyme-cli-runner/tests/test_usable.py) so drift between the two
// implementations fails here. When rhylthyme-mcp is checked out on its own the
// fixture is absent and the parity tests skip; durationStats still runs.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const H = require("./history.js");

const FIXTURE = path.join(
  __dirname, "..", "..",
  "rhylthyme-cli-runner", "tests", "fixtures", "history", "usable-cases.json"
);

function loadCases() {
  if (!fs.existsSync(FIXTURE)) return null;
  const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  return data.cases;
}

// --------------------------------------------------------------- parity

test("usable-run filter matches the Python implementation on every fixture case", (t) => {
  const cases = loadCases();
  if (!cases) {
    t.skip("usable-cases.json not present (rhylthyme-cli-runner not checked out)");
    return;
  }
  assert.ok(cases.length >= 8, `expected the full corpus, got ${cases.length}`);
  for (const c of cases) {
    const run = H.isUsableRun(c.record);
    assert.equal(run.usable, c.expectUsable, `${c.name}: usable`);
    assert.equal(run.reason, c.expectReason, `${c.name}: reason`);

    for (const includeFixed of [false, true]) {
      const expected = includeFixed ? c.stepReasonsIncludingFixed : c.stepReasons;
      const got = {};
      for (const entry of H.usableSteps(c.record, { includeFixed })) {
        got[entry.step.stepId] = entry.reason;
      }
      assert.deepEqual(got, expected, `${c.name}: step reasons (includeFixed=${includeFixed})`);

      const ids = H.measuredSteps(c.record, { includeFixed }).map((s) => s.stepId);
      const expectedIds = includeFixed ? c.usableStepIdsIncludingFixed : c.usableStepIds;
      assert.deepEqual(ids, expectedIds, `${c.name}: measured ids (includeFixed=${includeFixed})`);
    }
  }
});

test("usableSteps returns one entry per step, in record order", (t) => {
  const cases = loadCases();
  if (!cases) {
    t.skip("usable-cases.json not present");
    return;
  }
  for (const c of cases) {
    const entries = H.usableSteps(c.record);
    assert.equal(entries.length, c.record.steps.length, c.name);
    assert.deepEqual(
      entries.map((e) => e.step.stepId),
      c.record.steps.map((s) => s.stepId),
      c.name
    );
  }
});

// ------------------------------------------------------------ run filter

const RUN = {
  runId: "2026-02-01T10:00:00Z-0001",
  programId: "p",
  programVersion: "sha256:" + "ab".repeat(32),
  runtime: { kind: "cli", version: "0.1.0a0", clockMode: "wall", speed: 1 },
  startedAt: "2026-02-01T10:00:00.000Z",
  outcome: "completed",
  steps: [],
};

test("isUsableRun checks outcome, clock mode and speed in that order", () => {
  assert.deepEqual(H.isUsableRun(RUN), { usable: true, reason: null });
  assert.equal(H.isUsableRun({ ...RUN, outcome: "abandoned" }).reason, "outcome-not-completed");
  assert.equal(
    H.isUsableRun({ ...RUN, runtime: { ...RUN.runtime, clockMode: "simulated" } }).reason,
    "clock-not-wall"
  );
  assert.equal(
    H.isUsableRun({ ...RUN, runtime: { ...RUN.runtime, speed: 10 } }).reason,
    "speed-not-1"
  );
  // The first failing condition wins, so a scaled simulated run reports the clock.
  assert.equal(
    H.isUsableRun({ ...RUN, runtime: { clockMode: "simulated", speed: 10 } }).reason,
    "clock-not-wall"
  );
  // Missing speed is real time; a missing runtime is not a wall clock.
  assert.equal(H.isUsableRun({ ...RUN, runtime: { clockMode: "wall" } }).usable, true);
  assert.equal(H.isUsableRun({ ...RUN, runtime: undefined }).reason, "clock-not-wall");
  assert.equal(H.isUsableRun(null).usable, false);
});

test("fixed steps are measurements only with includeFixed", () => {
  const record = {
    ...RUN,
    steps: [
      {
        stepId: "f",
        planned: { start: 0, end: 600, durationType: "fixed", seconds: 600 },
        actual: { start: 0, end: 610 },
        endedBy: "timer",
        pausedSeconds: 0,
      },
    ],
  };
  assert.equal(H.usableSteps(record)[0].reason, "fixed-duration");
  assert.equal(H.usableSteps(record, { includeFixed: true })[0].reason, null);
  assert.equal(H.stepDuration(record.steps[0]), 610);
  assert.equal(H.plannedDuration(record.steps[0]), 600);
  assert.equal(H.stepDuration({ planned: {}, actual: { start: 1 } }), null);
  assert.equal(H.plannedDuration({}), null);
});

// --------------------------------------------------------- durationStats

test("durationStats on known values", () => {
  // 1..9: mean 5, sample stdev sqrt(60/8) = 2.7386..., median 5,
  // p10 = 1 + 0.8*(2-1) = 1.8, p90 = 8.2, IQR = p75 - p25 = 7 - 3 = 4.
  const s = H.durationStats([5, 3, 1, 9, 7, 2, 8, 4, 6]);
  assert.equal(s.n, 9);
  assert.equal(s.mean, 5);
  assert.equal(s.median, 5);
  assert.ok(Math.abs(s.p10 - 1.8) < 1e-12, String(s.p10));
  assert.ok(Math.abs(s.p90 - 8.2) < 1e-12, String(s.p90));
  assert.equal(s.iqr, 4);
  assert.ok(Math.abs(s.cv - Math.sqrt(60 / 8) / 5) < 1e-12, String(s.cv));
});

test("durationStats edge cases", () => {
  assert.deepEqual(H.durationStats([]), {
    n: 0, median: null, p10: null, p90: null, iqr: null, mean: null, cv: null,
  });
  const one = H.durationStats([42]);
  assert.equal(one.n, 1);
  assert.equal(one.median, 42);
  assert.equal(one.p10, 42);
  assert.equal(one.iqr, 0);
  assert.equal(one.cv, null, "a single value has no coefficient of variation");
  // A constant sample is perfectly predictable.
  assert.equal(H.durationStats([600, 600, 600]).cv, 0);
  // Even numbers of values interpolate the median.
  assert.equal(H.durationStats([10, 20]).median, 15);
  // Nulls are dropped, not counted.
  assert.equal(H.durationStats([10, null, undefined, 20]).n, 2);
  // A zero mean leaves cv undefined rather than dividing by zero.
  assert.equal(H.durationStats([0, 0]).cv, null);
});

test("percentile agrees with durationStats and needs no pre-sorting", () => {
  const values = [9, 1, 5, 3, 7];
  assert.equal(H.percentile(values, 0.5), H.durationStats(values).median);
  assert.equal(H.percentile(values, 0), 1);
  assert.equal(H.percentile(values, 1), 9);
  assert.equal(H.percentile([], 0.5), null);
});

// ------------------------------------------- the verdict rule it feeds

test("the CV threshold separates predictable from executor-controlled", () => {
  // A step whose observed durations cluster (CV <= 0.25) is predictable; one
  // whose durations scatter is the executor's choice, not a measurement.
  const tight = H.durationStats([1180, 1200, 1210, 1195, 1205]);
  const loose = H.durationStats([600, 1800, 900, 3600, 1200]);
  assert.ok(tight.cv <= 0.25, String(tight.cv));
  assert.ok(loose.cv > 0.25, String(loose.cv));
});

// ==================================================================
// Prediction (Phase 6): the identical-then-similar lookup.
// ==================================================================

const PREDICT_FIXTURE = path.join(
  __dirname, "..", "..",
  "rhylthyme-cli-runner", "tests", "fixtures", "history", "predict-cases.json"
);
const FIXTURE_DIR = path.dirname(PREDICT_FIXTURE);
const THANKSGIVING = path.join(__dirname, "..", "static", "examples", "thanksgiving_one_oven.json");

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadPredictCases() {
  if (!fs.existsSync(PREDICT_FIXTURE)) return null;
  return loadJson(PREDICT_FIXTURE);
}

/** The program of a fixture case: inline, or the named bundled example. */
function casProgram(c) {
  if (typeof c.program !== "string") return c.program;
  if (c.program === "thanksgiving") return loadJson(THANKSGIVING);
  throw new Error(`unknown program reference ${c.program}`);
}

function caseRecords(c) {
  if (!c.recordsFixture) return c.records;
  return loadJson(path.join(FIXTURE_DIR, c.recordsFixture)).runs;
}

function synthRuns() {
  const file = path.join(FIXTURE_DIR, "thanksgiving-synth-runs.json");
  return fs.existsSync(file) ? loadJson(file).runs : null;
}

function assertClose(got, want, tol, label) {
  if (want === null || want === undefined) {
    assert.equal(got, want, label);
    return;
  }
  assert.ok(typeof got === "number", `${label}: expected a number, got ${got}`);
  assert.ok(Math.abs(got - want) <= tol, `${label}: ${got} != ${want}`);
}

// --------------------------------------------------------------- parity

test("predictDurations matches the Python implementation on every fixture case", (t) => {
  const fixture = loadPredictCases();
  if (!fixture) {
    t.skip("predict-cases.json not present (rhylthyme-cli-runner not checked out)");
    return;
  }
  const tol = fixture.tolerance || 1e-6;
  assert.ok(fixture.cases.length >= 8, `expected the full corpus, got ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = H.predictDurations(casProgram(c), caseRecords(c), c.context || {});
    assert.deepEqual(
      Object.keys(got).sort(), Object.keys(c.expect).sort(),
      `${c.name}: predicted step ids`
    );
    for (const sid of Object.keys(c.expect)) {
      const want = c.expect[sid];
      const mine = got[sid];
      assert.equal(mine.basis, want.basis, `${c.name}/${sid}: basis`);
      assert.equal(mine.n, want.n, `${c.name}/${sid}: n`);
      assert.equal(mine.source, want.source, `${c.name}/${sid}: source`);
      assert.equal(mine.method, want.method, `${c.name}/${sid}: method`);
      assert.equal(mine.reason, want.reason, `${c.name}/${sid}: reason`);
      assertClose(mine.seconds, want.seconds, tol, `${c.name}/${sid}: seconds`);
      assertClose(mine.low, want.low, tol, `${c.name}/${sid}: low`);
      assertClose(mine.high, want.high, tol, `${c.name}/${sid}: high`);
      if (want.factors === undefined) {
        assert.equal(mine.factors, undefined, `${c.name}/${sid}: no factors expected`);
      } else {
        assert.deepEqual(
          mine.factors.map((f) => f.key), want.factors.map((f) => f.key),
          `${c.name}/${sid}: factor keys`
        );
        want.factors.forEach((f, i) => {
          assertClose(mine.factors[i].coef, f.coef, tol, `${c.name}/${sid}: coef ${f.key}`);
        });
      }
      if (want.seconds !== null) {
        assert.ok(mine.low <= mine.seconds, `${c.name}/${sid}: low <= seconds`);
        assert.ok(mine.high >= mine.seconds, `${c.name}/${sid}: seconds <= high`);
      }
    }
    if (c.expectEmpty) assert.deepEqual(got, {}, `${c.name}: nothing to predict`);
  }
});

test("the fixture's approximate expectations hold independently of the fixture's numbers", (t) => {
  const fixture = loadPredictCases();
  if (!fixture) {
    t.skip("predict-cases.json not present");
    return;
  }
  let checked = 0;
  for (const c of fixture.cases) {
    if (!c.expectApprox) continue;
    const got = H.predictDurations(casProgram(c), caseRecords(c), c.context || {});
    for (const sid of Object.keys(c.expectApprox)) {
      const want = c.expectApprox[sid];
      const tol = want.tolerance !== undefined
        ? want.tolerance
        : (want.tolerancePct / 100) * want.seconds;
      assertClose(got[sid].seconds, want.seconds, tol, `${c.name}/${sid}: law`);
      checked++;
    }
  }
  assert.ok(checked >= 2, "the fixture should state at least two laws to check against");
});

// ---------------------------------------------- the law, fitted from scratch

test("OLS recovers a known generating law from the Thanksgiving corpus", (t) => {
  const runs = synthRuns();
  if (!runs || !fs.existsSync(THANKSGIVING)) {
    t.skip("synthetic Thanksgiving history not present");
    return;
  }
  const program = loadJson(THANKSGIVING);
  // PRD §7 / plan Phase 6 acceptance: duration = 600 + 90 * turkeyKg, so a
  // 7 kg turkey is 1230 s. (A test law, not a roasting rule.)
  const p = H.predictDurations(program, runs, {
    programVersion: runs[0].programVersion,
    environmentId: "home-kitchen",
    userTags: { turkeyKg: 7, oven: "electric" },
  });
  const roast = p["turkey-roast"];
  assert.equal(roast.basis, "model");
  assert.equal(roast.method, "ols");
  assert.equal(roast.n, 20);
  assert.deepEqual(roast.factors.map((f) => f.key), ["turkeyKg"],
    "only turkeyKg correlates: the oven cycles with a coprime period");
  assert.ok(Math.abs(roast.seconds - 1230) / 1230 < 0.05,
    `predicted ${roast.seconds}, law says 1230`);
  assert.ok(Math.abs(roast.factors[0].coef - 90) / 90 < 0.25,
    `slope ${roast.factors[0].coef}, law says 90 s/kg`);
  // The interval brackets the point estimate and is narrower than the plan.
  assert.ok(roast.low < roast.seconds && roast.seconds < roast.high);
  assert.ok(roast.high - roast.low < 9900, "an interval wider than the plan is no forecast");

  // A step with no law gets no factor and falls back to the median.
  const boil = p["potatoes-boil"];
  assert.equal(boil.basis, "model");
  assert.equal(boil.method, "median");
  assert.deepEqual(boil.factors, []);

  // Fixed steps are never predicted: their observed length confirms a timer.
  assert.equal(p["turkey-prep"], undefined);
  assert.equal(p["stuffing-bake"], undefined);

  // Extrapolating the law to a bigger bird moves the prediction the right way.
  const big = H.predictDurations(program, runs, {
    programVersion: runs[0].programVersion,
    environmentId: "home-kitchen",
    userTags: { turkeyKg: 12, oven: "electric" },
  })["turkey-roast"];
  assert.ok(big.seconds > roast.seconds, "12 kg must predict longer than 7 kg");
  assert.ok(Math.abs(big.seconds - (600 + 90 * 12)) / (600 + 90 * 12) < 0.10);
});

// ------------------------------------------------------- the lookup order

const PROG = {
  programId: "lookup",
  actors: 2,
  tracks: [{ trackId: "t", steps: [
    { stepId: "s", name: "S", task: "prep",
      duration: { type: "variable", minSeconds: 60, maxSeconds: 6000, defaultSeconds: 1200 },
      startTrigger: { type: "programStart" } },
  ] }],
  metadata: { serves: "8", varianceFactors: [{ key: "kg", label: "kg", type: "number" }] },
};

function run(i, seconds, extra) {
  return Object.assign({
    runId: `2026-04-${String(i + 1).padStart(2, "0")}T10:00:00Z-000${i}`,
    programId: "lookup",
    programVersion: "sha256:" + "11".repeat(32),
    runtime: { kind: "cli", version: "t", clockMode: "wall", speed: 1 },
    environmentId: "env-1",
    startedAt: "2026-04-01T10:00:00.000Z",
    outcome: "completed",
    context: { serves: "8", actors: 2, userTags: { kg: 4 } },
    steps: [{
      stepId: "s", instance: 1,
      planned: { start: 0, end: 1200, durationType: "variable", defaultSeconds: 1200 },
      actual: { start: 0, end: seconds },
      endedBy: "executor", pausedSeconds: 0,
    }],
  }, extra || {});
}

const CTX = {
  programVersion: "sha256:" + "11".repeat(32),
  environmentId: "env-1",
  userTags: { kg: 4 },
};

test("identical context needs minIdentical measurements and reports median/P10/P90", () => {
  const three = [run(0, 1000), run(1, 1200), run(2, 1400)];
  const p = H.predictDurations(PROG, three, CTX).s;
  assert.equal(p.basis, "identical");
  assert.equal(p.n, 3);
  assert.equal(p.source, "all");
  assert.equal(p.seconds, 1200);
  assert.equal(p.low, 1040, "P10 of 1000/1200/1400 interpolates at 0.2 of the way up");
  assert.equal(p.high, 1360);
  assert.equal(p.factors, undefined, "an identical-context median claims no factors");

  // Two is not enough, and with nothing else to go on the median answers under
  // the model basis rather than pretending to a fit.
  const two = H.predictDurations(PROG, three.slice(0, 2), CTX).s;
  assert.equal(two.basis, "model");
  assert.equal(two.method, "median");
  assert.equal(two.n, 2);

  // minIdentical is a knob, not a constant.
  assert.equal(H.predictDurations(PROG, three.slice(0, 2), Object.assign({ minIdentical: 2 }, CTX)).s.basis, "identical");
  assert.equal(H.predictDurations(PROG, three, Object.assign({ minIdentical: 4 }, CTX)).s.basis, "model");
});

test("a different version, environment or factor answer is not the identical context", () => {
  const base = [run(0, 1000), run(1, 1200), run(2, 1400)];
  const check = (mutate) => {
    const records = base.map((r) => mutate(JSON.parse(JSON.stringify(r))));
    return H.predictDurations(PROG, records, CTX).s.basis;
  };
  assert.equal(check((r) => r), "identical");
  assert.equal(check((r) => { r.programVersion = "sha256:" + "22".repeat(32); return r; }), "model");
  assert.equal(check((r) => { r.environmentId = "env-2"; return r; }), "model");
  assert.equal(check((r) => { r.context.userTags.kg = 9; return r; }), "model");
  // An unanswered factor matches only an unanswered one.
  assert.equal(check((r) => { delete r.context.userTags.kg; return r; }), "model");
  // Numbers compare numerically and enum spellings case-insensitively, so a
  // record written by one runtime matches a context typed in another.
  assert.equal(check((r) => { r.context.userTags.kg = "4.0"; return r; }), "identical");
  // An unconstrained version does not constrain: leaving programVersion out
  // makes "identical" a looser match, as documented.
  const mixed = base.map((r, i) => {
    const c = JSON.parse(JSON.stringify(r));
    if (i === 0) c.programVersion = "sha256:" + "33".repeat(32);
    return c;
  });
  const constrained = H.predictDurations(PROG, mixed, CTX).s;
  assert.equal(constrained.basis, "model", "only two runs are that version — fewer than minIdentical");
  const loose = H.predictDurations(PROG, mixed, { environmentId: "env-1", userTags: { kg: 4 } }).s;
  assert.equal(loose.basis, "identical");
  assert.equal(loose.n, 3);
});

test("the caller's own identical runs are preferred over everyone's", () => {
  const records = [
    run(0, 900, { context: { serves: "8", actors: 2, userId: "me", userTags: { kg: 4 } } }),
    run(1, 960, { context: { serves: "8", actors: 2, userId: "me", userTags: { kg: 4 } } }),
    run(2, 1020, { context: { serves: "8", actors: 2, userId: "me", userTags: { kg: 4 } } }),
    run(3, 3600, { context: { serves: "8", actors: 2, userId: "you", userTags: { kg: 4 } } }),
    run(4, 3700, { context: { serves: "8", actors: 2, userId: "you", userTags: { kg: 4 } } }),
    run(5, 3800, { context: { serves: "8", actors: 2, userId: "you", userTags: { kg: 4 } } }),
  ];
  const mine = H.predictDurations(PROG, records, Object.assign({ userId: "me" }, CTX)).s;
  assert.equal(mine.source, "user");
  assert.equal(mine.n, 3);
  assert.equal(mine.seconds, 960);

  // Everyone's history when no user is named …
  const all = H.predictDurations(PROG, records, CTX).s;
  assert.equal(all.source, "all");
  assert.equal(all.n, 6);

  // … and when the named user has too few of their own.
  const few = H.predictDurations(PROG, records, Object.assign({ userId: "someone-new" }, CTX)).s;
  assert.equal(few.source, "all");
  assert.equal(few.n, 6);

  // The owner may also arrive as a column beside the record, as the web API
  // returns it, rather than inside context.
  const flat = records.map((r) => {
    const c = JSON.parse(JSON.stringify(r));
    c.userId = c.context.userId;
    delete c.context.userId;
    return c;
  });
  assert.equal(H.predictDurations(PROG, flat, Object.assign({ userId: "me" }, CTX)).s.source, "user");
  assert.equal(H.recordUserId(records[0]), "me");
  assert.equal(H.recordUserId({}), null);
});

test("the Pearson filter keeps only factors that correlate, and minModel gates the fit", () => {
  // 10 runs: duration = 300 + 100 * kg exactly; `pinch` is noise.
  const records = [];
  for (let i = 0; i < 10; i++) {
    const kg = 1 + (i % 5);
    const r = run(i, 300 + 100 * kg, {
      environmentId: "other",
      context: { serves: "8", actors: 2, userTags: { kg, pinch: [3, 1, 4, 1, 5, 9, 2, 6, 5, 3][i] } },
    });
    records.push(r);
  }
  const p = H.predictDurations(PROG, records, { environmentId: "env-1", userTags: { kg: 4, pinch: 2 } }).s;
  assert.equal(p.basis, "model");
  assert.equal(p.method, "ols");
  assert.equal(p.n, 10);
  assert.deepEqual(p.factors.map((f) => f.key), ["kg"], "pinch correlates with nothing");
  assert.ok(Math.abs(p.factors[0].coef - 100) < 1e-6);
  assert.ok(Math.abs(p.seconds - 700) < 1e-6, String(p.seconds));
  // An exact law leaves no residual, so the interval collapses onto the point.
  assert.equal(p.low, p.seconds);
  assert.equal(p.high, p.seconds);

  // Raise minModel above n and the same history answers with the median.
  const gated = H.predictDurations(PROG, records, { environmentId: "env-1", minModel: 11, userTags: { kg: 4 } }).s;
  assert.equal(gated.method, "median");
  assert.deepEqual(gated.factors, []);

  // Raise the correlation threshold past the real factor and the fit is dropped
  // rather than fitted on nothing.
  const strict = H.predictDurations(PROG, records, { environmentId: "env-1", corrThreshold: 1.01, userTags: { kg: 4 } }).s;
  assert.equal(strict.method, "median");
});

test("a factor the caller cannot supply is not used to predict", () => {
  const records = [];
  for (let i = 0; i < 10; i++) {
    const kg = 1 + (i % 5);
    records.push(run(i, 300 + 100 * kg, {
      environmentId: "other",
      context: { serves: "8", actors: 2, userTags: { kg } },
    }));
  }
  // No kg in the context: the column cannot be evaluated, so the median answers.
  const p = H.predictDurations(PROG, records, { environmentId: "env-1", userTags: {} }).s;
  assert.equal(p.method, "median");
  assert.equal(p.seconds, 600, "median of 400,500,600,700,800 twice over");
});

test("enum factors become one-hot columns", () => {
  const seconds = { gas: 1200, electric: 1800, convection: 900 };
  const records = [];
  ["gas", "electric", "convection"].forEach((oven) => {
    [-20, 0, 20, 10].forEach((drift, j) => {
      records.push(run(records.length, seconds[oven] + drift, {
        environmentId: "other",
        context: { serves: "8", actors: 2, userTags: { kg: 4, oven } },
      }));
    });
  });
  const p = H.predictDurations(PROG, records, { environmentId: "env-1", userTags: { kg: 4, oven: "electric" } }).s;
  assert.equal(p.method, "ols");
  assert.ok(p.factors.every((f) => f.key.indexOf("oven=") === 0), JSON.stringify(p.factors));
  assert.ok(Math.abs(p.seconds - 1800) < 60, String(p.seconds));
  // kg is constant across the corpus, so it correlates with nothing and is out.
  assert.ok(!p.factors.some((f) => f.key === "kg"));
  // A gas oven predicts the gas group, from the same fit.
  const gas = H.predictDurations(PROG, records, { environmentId: "env-1", userTags: { kg: 4, oven: "gas" } }).s;
  assert.ok(Math.abs(gas.seconds - 1200) < 60, String(gas.seconds));
});

test("an executor-controlled verdict blocks prediction; other verdicts do not", () => {
  const records = [run(0, 1000), run(1, 1200), run(2, 1400)];
  const blocked = H.predictDurations(PROG, records, Object.assign({ verdicts: { s: "executor-controlled" } }, CTX)).s;
  assert.equal(blocked.basis, "none");
  assert.equal(blocked.seconds, null);
  assert.equal(blocked.n, 3, "the measurements are still counted, just not used");
  assert.equal(blocked.reason, "executor-controlled");

  // A report object or a list of rows says the same thing.
  const asReport = H.predictDurations(PROG, records, Object.assign({ verdicts: { steps: [{ stepId: "s", verdict: "executor-controlled" }] } }, CTX)).s;
  assert.equal(asReport.basis, "none");
  assert.equal(H.predictDurations(PROG, records, Object.assign({ verdicts: [{ stepId: "s", verdict: "predictable" }] }, CTX)).s.basis, "identical");
  assert.equal(H.predictDurations(PROG, records, Object.assign({ verdicts: { s: "insufficient" } }, CTX)).s.basis, "identical");
});

test("unusable runs, foreign programs and unmeasured steps contribute nothing", () => {
  assert.deepEqual(H.predictDurations(PROG, [], CTX), {});
  assert.deepEqual(H.predictDurations(PROG, null, CTX), {});
  const unusable = [
    run(0, 1000, { outcome: "abandoned" }),
    run(1, 1000, { runtime: { kind: "cli", version: "t", clockMode: "simulated", speed: 1 } }),
    run(2, 1000, { runtime: { kind: "cli", version: "t", clockMode: "wall", speed: 10 } }),
    run(3, 1000, { programId: "another-program" }),
  ];
  assert.deepEqual(H.predictDurations(PROG, unusable, CTX), {});
  // A step the program does not declare is ignored even from a usable run.
  const foreign = run(4, 1000);
  foreign.steps[0].stepId = "not-in-this-program";
  assert.deepEqual(H.predictDurations(PROG, [foreign], CTX), {});
  // A timer-ended step is not a measurement.
  const timed = run(5, 1000);
  timed.steps[0].endedBy = "timer";
  assert.deepEqual(H.predictDurations(PROG, [timed], CTX), {});
});

test("predictedSeconds narrows a prediction set to the numbers a planner can use", () => {
  const predictions = {
    a: { seconds: 1200, basis: "identical" },
    b: { seconds: null, basis: "none" },
    c: { basis: "none" },
  };
  assert.deepEqual(H.predictedSeconds(predictions), { a: 1200 });
  assert.deepEqual(H.predictedSeconds(null), {});
});

test("pearson and olsFit are exported and behave", () => {
  assert.equal(H.pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.ok(Math.abs(H.pearson([1, 2, 3], [6, 4, 2]) + 1) < 1e-12);
  assert.equal(H.pearson([1, 1, 1], [1, 2, 3]), null, "a constant column has no correlation");
  assert.equal(H.pearson([1], [1]), null);
  const beta = H.olsFit([[1], [2], [3], [4], [5]], [3, 5, 7, 9, 11]);
  assert.ok(Math.abs(beta[0] - 1) < 1e-9 && Math.abs(beta[1] - 2) < 1e-9);
  assert.equal(H.olsFit([[1], [2]], [1, 2]), null, "too few rows for an intercept and a slope");
  assert.equal(H.olsFit([[1], [1], [1], [1]], [1, 2, 3, 4]), null, "collinear with the intercept");
  assert.equal(H.olsFit([], []), null);
});

test("declaredFactorKeys and programStepIds read the program the same way both sides do", () => {
  assert.deepEqual(H.declaredFactorKeys(PROG), ["kg"]);
  assert.deepEqual(H.declaredFactorKeys({}), []);
  assert.deepEqual(H.programStepIds(PROG), ["s"]);
  // Expanded replicate instances pool back onto the authored step id.
  assert.deepEqual(
    H.programStepIds({ tracks: [{ steps: [
      { stepId: "bake-r1", instanceOf: "bake" },
      { stepId: "bake-r2", instanceOf: "bake" },
      { stepId: "box" },
    ] }] }),
    ["bake", "box"]
  );
});
