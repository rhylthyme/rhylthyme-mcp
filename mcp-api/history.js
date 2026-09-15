// Execution history helpers for the Rhylthyme MCP server.
//
// The JavaScript twin of rhylthyme-cli-runner/src/rhylthyme_cli_runner/history/
// {usable,report,predict}.py. Two runtimes record runs (the terminal runner
// and the browser player) and two languages read them back, so the rule that
// decides which runs and steps are *measurements* has to be the same rule on
// both sides. It is defined once in each language and pinned by shared
// fixtures, rhylthyme-cli-runner/tests/fixtures/history/{usable,predict}-cases
// .json, asserted by history.test.js here and tests/test_{usable,predict}.py
// there.
//
// Pure and dependency-free: no imports from index.js, nothing async, no I/O.
//
//   isUsableRun(record)              -> { usable, reason }
//   usableSteps(record, opts)        -> [{ step, reason }]
//   durationStats(values)            -> { n, median, p10, p90, iqr, mean, cv }
//   predictDurations(program, records, opts)
//                                    -> { [stepId]: { seconds, low, high,
//                                         basis, n, source, ... } }
//
// A run is usable when outcome is "completed", the clock was "wall" and the
// speed was 1. Within a usable run a step is usable when it started and ended,
// was never paused, and was ended by the executor. Fixed steps are therefore
// never measurements — their observed length only confirms the timer — unless
// includeFixed is set, which keeps them (timer- or executor-ended) for lag
// analysis.

"use strict";

// Run-level reasons
const OUTCOME_NOT_COMPLETED = "outcome-not-completed";
const CLOCK_NOT_WALL = "clock-not-wall";
const SPEED_NOT_1 = "speed-not-1";

// Step-level reasons
const NO_ACTUAL = "no-actual";
const NOT_ENDED = "not-ended";
const PAUSED = "paused";
const FIXED_DURATION = "fixed-duration";

function _isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

/**
 * Decide whether one run record is a measurement.
 * @returns {{usable: boolean, reason: (string|null)}}
 */
function isUsableRun(record) {
  if (!_isObj(record)) return { usable: false, reason: OUTCOME_NOT_COMPLETED };
  if (record.outcome !== "completed") return { usable: false, reason: OUTCOME_NOT_COMPLETED };
  const runtime = _isObj(record.runtime) ? record.runtime : {};
  if (runtime.clockMode !== "wall") return { usable: false, reason: CLOCK_NOT_WALL };
  const speed = runtime.speed === undefined || runtime.speed === null ? 1 : Number(runtime.speed);
  if (!Number.isFinite(speed) || speed !== 1) return { usable: false, reason: SPEED_NOT_1 };
  return { usable: true, reason: null };
}

/**
 * Reason `step` is not a measurement, or null if it is. Assumes the enclosing
 * run is usable; usableSteps applies the run-level reason when it is not.
 */
function stepReason(step, includeFixed) {
  const planned = _isObj(step && step.planned) ? step.planned : {};
  const actual = _isObj(step && step.actual) ? step.actual : {};
  if (actual.start === undefined || actual.start === null) return NO_ACTUAL;
  if (actual.end === undefined || actual.end === null) return NOT_ENDED;
  if (Number(step.pausedSeconds || 0) > 0) return PAUSED;
  const endedBy = step.endedBy;
  if (planned.durationType === "fixed") {
    if (!includeFixed) return FIXED_DURATION;
    if (endedBy === "executor" || endedBy === "timer") return null;
    return "ended-by-" + (endedBy ? String(endedBy) : "none");
  }
  if (endedBy === "executor") return null;
  return "ended-by-" + (endedBy ? String(endedBy) : "none");
}

/**
 * Every step of `record` paired with the reason it is not a measurement
 * (null when it is). When the run itself is unusable, every step carries the
 * run's reason.
 * @param {object} record
 * @param {{includeFixed?: boolean}} [opts]
 * @returns {Array<{step: object, reason: (string|null)}>}
 */
function usableSteps(record, opts) {
  const includeFixed = !!(opts && opts.includeFixed);
  const steps = _isObj(record) && Array.isArray(record.steps) ? record.steps : [];
  const run = isUsableRun(record);
  if (!run.usable) return steps.map((step) => ({ step, reason: run.reason }));
  return steps.map((step) => ({ step, reason: stepReason(step, includeFixed) }));
}

/** Just the measured steps of `record`. */
function measuredSteps(record, opts) {
  return usableSteps(record, opts).filter((e) => e.reason === null).map((e) => e.step);
}

/** Observed duration of a step record in seconds, or null. */
function stepDuration(step) {
  const actual = _isObj(step && step.actual) ? step.actual : {};
  if (actual.start === undefined || actual.start === null) return null;
  if (actual.end === undefined || actual.end === null) return null;
  return Number(actual.end) - Number(actual.start);
}

/** Planned duration of a step record in seconds, or null. */
function plannedDuration(step) {
  const planned = _isObj(step && step.planned) ? step.planned : {};
  if (planned.start === undefined || planned.start === null) return null;
  if (planned.end === undefined || planned.end === null) return null;
  return Number(planned.end) - Number(planned.start);
}

/**
 * Linear-interpolated percentile (q in 0..1) — the same definition as NumPy's
 * default and as report.percentile in Python: position q * (n - 1) in the
 * sorted sample. `values` must already be sorted ascending.
 */
function _percentileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function percentile(values, q) {
  const nums = (values || []).filter((v) => v !== null && v !== undefined).map(Number);
  nums.sort((a, b) => a - b);
  return _percentileSorted(nums, q);
}

/**
 * { n, median, p10, p90, iqr, mean, cv } for a sample of durations.
 *
 * `cv` is the sample standard deviation (n - 1 denominator) over the mean and
 * is null when undefined (fewer than two values, or a mean of zero). It is the
 * number the inferentiality verdict is made on: at or below the threshold
 * (0.25 by default) a step is predictable, above it the executor decides.
 */
function durationStats(values) {
  const nums = (values || []).filter((v) => v !== null && v !== undefined).map(Number);
  const n = nums.length;
  if (n === 0) {
    return { n: 0, median: null, p10: null, p90: null, iqr: null, mean: null, cv: null };
  }
  const sorted = nums.slice().sort((a, b) => a - b);
  const mean = nums.reduce((a, b) => a + b, 0) / n;
  let cv = null;
  if (n > 1) {
    const variance = nums.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1);
    const stdev = Math.sqrt(variance);
    cv = mean ? stdev / mean : null;
  }
  return {
    n,
    median: _percentileSorted(sorted, 0.5),
    p10: _percentileSorted(sorted, 0.10),
    p90: _percentileSorted(sorted, 0.90),
    iqr: _percentileSorted(sorted, 0.75) - _percentileSorted(sorted, 0.25),
    mean,
    cv,
  };
}

// ============================================================ prediction
//
// Badosa et al. (2019) §3 predict a job's run time by looking first for
// *identical* executions and only then for *similar* ones, fitting a
// regression on the predictor variables whose Pearson correlation with the
// outcome clears a threshold. `predictDurations` is that lookup over run
// records, per authored step:
//
//   1. identical  runs of the same programVersion, the same environmentId and
//                 the same answers to the program's declared variance factors
//                 -> median of the measurements, P10/P90 as the interval.
//                 The caller's own runs are preferred when there are enough of
//                 them (PRD open question 3), which is what `source` reports.
//   2. model      otherwise, every usable measurement of the same program ->
//                 an ordinary-least-squares fit on the numeric factors and
//                 one-hot enums that survive the correlation filter,
//                 evaluated at the caller's factor values. Residual P10/P90
//                 give the interval. With too few measurements, or when no
//                 factor survives, the same basis falls back to the median
//                 (`method: "median"`, `factors: []`).
//   3. none       no measurement at all, or the inferentiality report says the
//                 executor decides this step's length -> no number.
//
// The Python twin is rhylthyme_server/rhylthyme/predict.py (copied verbatim to
// rhylthyme_cli_runner/history/predict.py); the parity fixture is
// rhylthyme-cli-runner/tests/fixtures/history/predict-cases.json.

const DEFAULT_MIN_IDENTICAL = 3;
const DEFAULT_MIN_MODEL = 8;
const DEFAULT_CORR_THRESHOLD = 0.3;

const BASIS_IDENTICAL = "identical";
const BASIS_MODEL = "model";
const BASIS_NONE = "none";
const METHOD_OLS = "ols";
const METHOD_MEDIAN = "median";
const EXECUTOR_CONTROLLED = "executor-controlled";
const NO_HISTORY = "no-history";

// Context keys that every run has whether or not the author declared any
// variance factors, so a program with no `metadata.varianceFactors` can still
// be conditioned on how many people and how many portions.
const IMPLICIT_FACTORS = ["serves", "actors"];

/** Round to 3 decimals, half away from zero, identically in both languages. */
function _round3(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 0 ? -Math.floor(-n * 1000 + 0.5) / 1000 : Math.floor(n * 1000 + 0.5) / 1000;
}

/** `v` as a finite number, or null. Booleans are categories, not numbers. */
function _num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "object") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The keys of `metadata.varianceFactors`, in declaration order. */
function declaredFactorKeys(program) {
  const meta = _isObj(program) && _isObj(program.metadata) ? program.metadata : {};
  const raw = Array.isArray(meta.varianceFactors) ? meta.varianceFactors : [];
  const keys = [];
  raw.forEach((f) => {
    if (_isObj(f) && typeof f.key === "string" && f.key && keys.indexOf(f.key) === -1) keys.push(f.key);
  });
  return keys;
}

/** Authored step ids of `program`, in program order, deduplicated. */
function programStepIds(program) {
  const ids = [];
  const tracks = _isObj(program) && Array.isArray(program.tracks) ? program.tracks : [];
  tracks.forEach((t) => {
    ((_isObj(t) && t.steps) || []).forEach((s) => {
      if (!_isObj(s)) return;
      const id = s.instanceOf || s.stepId;
      if (typeof id === "string" && id && ids.indexOf(id) === -1) ids.push(id);
    });
  });
  return ids;
}

function _context(record) {
  return _isObj(record) && _isObj(record.context) ? record.context : {};
}

function _userTags(record) {
  const tags = _context(record).userTags;
  return _isObj(tags) ? tags : {};
}

/**
 * Who ran `record`, or null. The runs schema is closed, so the owner lives in
 * the open `context` object; a `userId` / `user_id` alongside the record (the
 * shape the web API returns) is accepted too.
 */
function recordUserId(record) {
  if (!_isObj(record)) return null;
  const ctx = _context(record);
  const candidates = [ctx.userId, ctx.user_id, record.userId, record.user_id];
  for (const c of candidates) {
    if (c !== null && c !== undefined && c !== "") return String(c);
  }
  return null;
}

/** environmentId of a record or a context, normalised so "" and undefined are null. */
function _envId(v) {
  return v === null || v === undefined || v === "" ? null : String(v);
}

/**
 * The flat `{key: value}` a record's (or the caller's) factors amount to:
 * the implicit context factors first, overridden by the declared `userTags`.
 */
function _flatFactors(tags, implicit) {
  const out = {};
  IMPLICIT_FACTORS.forEach((k) => {
    const v = implicit ? implicit[k] : undefined;
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  });
  Object.keys(tags || {}).sort().forEach((k) => {
    const v = tags[k];
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  });
  return out;
}

function _recordFactors(record) {
  const ctx = _context(record);
  return _flatFactors(_userTags(record), { serves: ctx.serves, actors: ctx.actors });
}

function _contextFactors(program, opts) {
  const meta = _isObj(program) && _isObj(program.metadata) ? program.metadata : {};
  const implicit = {
    serves: meta.serves,
    actors: _isObj(program) ? program.actors : undefined,
  };
  return _flatFactors(opts.userTags, implicit);
}

/** Do two factor values mean the same thing? Numbers numerically, else text. */
function _sameFactor(a, b) {
  const an = _num(a);
  const bn = _num(b);
  if (an !== null && bn !== null) return an === bn;
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** `{stepId: verdict}` from an inferentiality report, a map, or a list of rows. */
function _verdictMap(verdicts) {
  const out = {};
  if (!verdicts) return out;
  let rows = null;
  if (Array.isArray(verdicts)) rows = verdicts;
  else if (_isObj(verdicts) && Array.isArray(verdicts.steps)) rows = verdicts.steps;
  if (rows) {
    rows.forEach((r) => {
      if (_isObj(r) && r.stepId) out[String(r.stepId)] = r.verdict === undefined ? null : r.verdict;
    });
    return out;
  }
  if (_isObj(verdicts)) {
    Object.keys(verdicts).forEach((k) => { out[k] = verdicts[k]; });
  }
  return out;
}

// ------------------------------------------------------------ linear algebra

/** Pearson correlation of two equal-length samples, or null when undefined. */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? r : null;
}

/**
 * Ordinary least squares with an intercept, by the normal equations
 * (X'X)b = X'y solved with Gauss-Jordan elimination and partial pivoting.
 *
 * `rows` are the design rows WITHOUT the intercept column, which is prepended
 * here. Returns `[intercept, ...coefficients]`, or null when the system is
 * singular (a collinear or constant column) — the caller then falls back to
 * the median rather than reporting a fitted number it cannot trust.
 */
function olsFit(rows, y) {
  const n = rows.length;
  if (n === 0 || n !== y.length) return null;
  const p = rows[0].length;
  const m = p + 1;
  if (n < m + 1) return null;
  // Augmented normal matrix [X'X | X'y].
  const a = [];
  for (let i = 0; i < m; i++) a.push(new Array(m + 1).fill(0));
  for (let k = 0; k < n; k++) {
    const row = [1];
    for (let j = 0; j < p; j++) row.push(rows[k][j]);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) a[i][j] += row[i] * row[j];
      a[i][m] += row[i] * y[k];
    }
  }
  // Scale-free pivot tolerance: the largest magnitude anywhere in X'X.
  let scale = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) scale = Math.max(scale, Math.abs(a[i][j]));
  }
  if (scale === 0) return null;
  const tol = 1e-10 * scale;
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < tol) return null;
    if (piv !== col) { const t = a[piv]; a[piv] = a[col]; a[col] = t; }
    const d = a[col][col];
    for (let j = col; j <= m; j++) a[col][j] /= d;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = col; j <= m; j++) a[r][j] -= f * a[col][j];
    }
  }
  const beta = [];
  for (let i = 0; i < m; i++) {
    if (!Number.isFinite(a[i][m])) return null;
    beta.push(a[i][m]);
  }
  return beta;
}

// ------------------------------------------------------------- the columns

/**
 * The candidate predictor columns for one step's measurements.
 *
 * A numeric factor becomes one column; a categorical factor becomes one
 * column per observed value (one-hot). A factor that is missing from any of
 * the measurements is dropped rather than imputed, because an imputed zero
 * would be a measurement the history does not contain.
 *
 * @returns {Array<{key: string, get: function}>}
 */
function _candidateColumns(samples) {
  const numeric = {};
  const categorical = {};
  samples.forEach((s) => {
    Object.keys(s.factors).forEach((k) => {
      if (_num(s.factors[k]) !== null) numeric[k] = (numeric[k] || 0) + 1;
      else categorical[k] = (categorical[k] || 0) + 1;
    });
  });
  const n = samples.length;
  const columns = [];
  Object.keys(numeric).sort().forEach((k) => {
    if (numeric[k] !== n || categorical[k]) return;
    columns.push({ key: k, kind: "numeric", get: (f) => _num(f[k]) });
  });
  Object.keys(categorical).sort().forEach((k) => {
    if (categorical[k] !== n || numeric[k]) return;
    const values = [];
    samples.forEach((s) => {
      const v = String(s.factors[k]);
      if (values.indexOf(v) === -1) values.push(v);
    });
    values.sort().forEach((v) => {
      columns.push({
        key: k + "=" + v,
        kind: "enum",
        get: (f) => (f[k] !== undefined && String(f[k]) === v ? 1 : 0),
      });
    });
  });
  return columns;
}

function _medianPrediction(values, basis, n, source, extra) {
  const stats = durationStats(values);
  return Object.assign({
    seconds: _round3(stats.median),
    low: _round3(stats.p10),
    high: _round3(stats.p90),
    basis,
    n,
    source,
    method: METHOD_MEDIAN,
  }, extra || {});
}

/**
 * Fit and evaluate one step's model, or null when it cannot be fitted.
 * @returns {{seconds, low, high, factors}|null}
 */
function _modelPrediction(samples, at, minModel, corrThreshold) {
  const n = samples.length;
  if (n < minModel) return null;
  const y = samples.map((s) => s.value);
  const candidates = _candidateColumns(samples);
  const kept = [];
  candidates.forEach((col) => {
    const xs = samples.map((s) => col.get(s.factors));
    if (xs.some((v) => v === null || !Number.isFinite(v))) return;
    const r = pearson(xs, y);
    if (r === null || Math.abs(r) < corrThreshold) return;
    const here = col.get(at);
    if (here === null || !Number.isFinite(here)) return;
    kept.push({ col, xs, here });
  });
  if (!kept.length) return null;
  const rows = samples.map((_s, i) => kept.map((k) => k.xs[i]));
  const beta = olsFit(rows, y);
  if (!beta) return null;
  let predicted = beta[0];
  kept.forEach((k, j) => { predicted += beta[j + 1] * k.here; });
  if (!Number.isFinite(predicted)) return null;
  const residuals = y.map((v, i) => {
    let fit = beta[0];
    kept.forEach((k, j) => { fit += beta[j + 1] * k.xs[i]; });
    return v - fit;
  });
  const lo = predicted + percentile(residuals, 0.10);
  const hi = predicted + percentile(residuals, 0.90);
  return {
    seconds: _round3(Math.max(0, predicted)),
    low: _round3(Math.max(0, Math.min(lo, predicted))),
    high: _round3(Math.max(hi, predicted)),
    factors: kept.map((k, j) => ({ key: k.col.key, coef: _round3(beta[j + 1]) })),
  };
}

/**
 * Predict each step's duration from run history.
 *
 * @param {object} program  the program being planned (read for programId,
 *   step ids, `metadata.varianceFactors` and the implicit serves/actors).
 * @param {Array<object>} records  run records, any programId (foreign ones are
 *   ignored) and any quality (only usable runs are read — see isUsableRun).
 * @param {object} [opts]
 *   environmentId, userTags, userId, programVersion  — the context being
 *       planned for; `programVersion` unset means the version is not
 *       constrained, which makes "identical" a looser match than Badosa's.
 *   minIdentical (3)   measurements needed before an identical-context median
 *                      is reported, and before the caller's own runs are used
 *                      in preference to everyone's.
 *   minModel (8)       measurements needed before a model is fitted at all.
 *   corrThreshold (.3) |Pearson r| a factor must clear to enter the model.
 *   verdicts           inferentiality verdicts ({stepId: verdict}, a list of
 *                      rows, or a whole report): an `executor-controlled` step
 *                      is never predicted.
 * @returns {Object<string, {seconds, low, high, basis, n, source, factors?,
 *   method?, reason?}>} keyed by authored stepId; steps with no history at all
 *   are absent.
 */
function predictDurations(program, records, opts) {
  opts = opts || {};
  const minIdentical = opts.minIdentical === undefined ? DEFAULT_MIN_IDENTICAL : Number(opts.minIdentical);
  const minModel = opts.minModel === undefined ? DEFAULT_MIN_MODEL : Number(opts.minModel);
  const corrThreshold = opts.corrThreshold === undefined ? DEFAULT_CORR_THRESHOLD : Number(opts.corrThreshold);
  const verdicts = _verdictMap(opts.verdicts);

  const stepIds = programStepIds(program);
  const known = new Set(stepIds);
  const programId = _isObj(program) ? program.programId : null;

  // Which runs count as the identical context, and the factors to predict at.
  const at = _contextFactors(program, opts);
  const wantEnv = _envId(opts.environmentId);
  const wantVersion = opts.programVersion === undefined || opts.programVersion === null || opts.programVersion === ""
    ? null : String(opts.programVersion);
  let matchKeys = declaredFactorKeys(program);
  if (!matchKeys.length) matchKeys = Object.keys(_isObj(opts.userTags) ? opts.userTags : {}).sort();
  const wantUser = opts.userId === undefined || opts.userId === null || opts.userId === ""
    ? null : String(opts.userId);
  const wantTags = _isObj(opts.userTags) ? opts.userTags : {};

  function isIdentical(record) {
    if (wantVersion !== null && String(record.programVersion || "") !== wantVersion) return false;
    if (_envId(record.environmentId) !== wantEnv) return false;
    const tags = _userTags(record);
    for (const key of matchKeys) {
      if (!_sameFactor(tags[key], wantTags[key])) return false;
    }
    return true;
  }

  // Every measurement of every step, with the context it was measured in.
  const byStep = {};
  (records || []).forEach((record) => {
    if (!_isObj(record)) return;
    if (programId && record.programId && record.programId !== programId) return;
    if (!isUsableRun(record).usable) return;
    const factors = _recordFactors(record);
    const identical = isIdentical(record);
    const owner = recordUserId(record);
    measuredSteps(record).forEach((step) => {
      const sid = step.stepId;
      if (!sid || (known.size && !known.has(sid))) return;
      const value = stepDuration(step);
      if (value === null || !Number.isFinite(value)) return;
      (byStep[sid] = byStep[sid] || []).push({ value, factors, identical, owner });
    });
  });

  const out = {};
  const order = stepIds.length ? stepIds : Object.keys(byStep);
  order.forEach((sid) => {
    const samples = byStep[sid] || [];
    if (verdicts[sid] === EXECUTOR_CONTROLLED) {
      out[sid] = { seconds: null, low: null, high: null, basis: BASIS_NONE, n: samples.length, source: "all", reason: EXECUTOR_CONTROLLED };
      return;
    }
    if (!samples.length) return;

    // 1. Identical context, the caller's own runs first.
    const identical = samples.filter((s) => s.identical);
    let chosen = null, source = null;
    if (wantUser !== null) {
      const mine = identical.filter((s) => s.owner === wantUser);
      if (mine.length >= minIdentical) { chosen = mine; source = "user"; }
    }
    if (!chosen && identical.length >= minIdentical) { chosen = identical; source = "all"; }
    if (chosen) {
      out[sid] = _medianPrediction(chosen.map((s) => s.value), BASIS_IDENTICAL, chosen.length, source);
      return;
    }

    // 2. Similar context: a model over every measurement of this program.
    const model = _modelPrediction(samples, at, minModel, corrThreshold);
    if (model) {
      out[sid] = {
        seconds: model.seconds, low: model.low, high: model.high,
        basis: BASIS_MODEL, n: samples.length, source: "all",
        method: METHOD_OLS, factors: model.factors,
      };
      return;
    }
    out[sid] = _medianPrediction(samples.map((s) => s.value), BASIS_MODEL, samples.length, "all", { factors: [] });
  });
  return out;
}

/** `{stepId: seconds}` for every step the lookup actually put a number on. */
function predictedSeconds(predictions) {
  const out = {};
  Object.keys(predictions || {}).forEach((sid) => {
    const p = predictions[sid];
    if (_isObj(p) && p.seconds !== null && p.seconds !== undefined && Number.isFinite(Number(p.seconds))) {
      out[sid] = Number(p.seconds);
    }
  });
  return out;
}

module.exports = {
  isUsableRun,
  stepReason,
  usableSteps,
  measuredSteps,
  stepDuration,
  plannedDuration,
  durationStats,
  percentile,
  predictDurations,
  predictedSeconds,
  declaredFactorKeys,
  programStepIds,
  recordUserId,
  pearson,
  olsFit,
  DEFAULT_MIN_IDENTICAL,
  DEFAULT_MIN_MODEL,
  DEFAULT_CORR_THRESHOLD,
  BASIS_IDENTICAL,
  BASIS_MODEL,
  BASIS_NONE,
  METHOD_OLS,
  METHOD_MEDIAN,
  EXECUTOR_CONTROLLED,
  OUTCOME_NOT_COMPLETED,
  CLOCK_NOT_WALL,
  SPEED_NOT_1,
  NO_ACTUAL,
  NOT_ENDED,
  PAUSED,
  FIXED_DURATION,
};
