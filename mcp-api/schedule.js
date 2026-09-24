// Schedule validation + analysis for the Rhylthyme MCP server.
//
// Pure, dependency-free (apart from the open-source timeline renderer,
// which owns the timing engine). Runs inside the Vercel function so the
// model gets a round-trip-free answer to "is this program well-formed,
// and what does it actually look like on the clock?" before anything
// is shared or persisted.
//
// Two entry points:
//
//   validateProgram(program)  -> { valid, errors[], warnings[], info[], stats }
//       Structural + logic checks mirroring rhylthyme.validate_program
//       (duplicate ids, dangling refs, cycles, within-track overlaps,
//       tasks without resource constraints, choice references, bad
//       durations, schema 0.3.0 `instances` codes, galago instrument
//       commands via galago.js). Each finding carries
//       a `fix` hint so the model can repair the program without
//       guessing. `valid` depends on errors only; `info` holds advisory
//       notes such as I_IMPLICIT_BARRIER.
//
//   analyzeSchedule(program, opts) -> { makespanSeconds, steps[], tracks[],
//       criticalPath[], resourceConflicts[], actorPeak, wallClock? }
//       Resolved timeline, critical path, resource over-subscription
//       windows, per-track idle time, and (when opts.startAt or
//       opts.finishAt is given) wall-clock start/end for every step.
//       Pass `opts.history` (run records) and it also reports what the
//       program's own execution history predicts each step will take
//       (`predicted` per step, `predictedMakespan`,
//       `predictedCriticalPath`); `opts.useDurations: "predicted"` plans
//       on those numbers instead of the authored ones. Without history
//       the output is exactly what it was before prediction existed.

"use strict";

const TimelineRender = require("../static/js/timeline-render.js");
const History = require("./history.js");
const Galago = require("./galago.js");

const { computeStepTimings, parseSeconds, stepDurationSeconds, expandReplicates, instrumentEstimate } = TimelineRender;

const SINGLE_TRIGGER_TYPES = new Set([
  "programStart", "programStartOffset", "afterStep", "afterStepWithBuffer",
  "manual", "onAbort", "previousStepComplete",
]);
const DURATION_TYPES = new Set(["fixed", "variable", "indefinite"]);

function _isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function _flattenTriggers(trig) {
  if (!_isObj(trig)) return [];
  if (trig.logic && Array.isArray(trig.triggers)) {
    return trig.triggers.reduce((acc, t) => acc.concat(_flattenTriggers(t)), []);
  }
  return [trig];
}

function _stepTasks(step) {
  const tasks = [];
  if (step.task) tasks.push(step.task);
  if (Array.isArray(step.tasks)) step.tasks.forEach((t) => { if (t) tasks.push(t); });
  if (Array.isArray(step.taskResources)) {
    step.taskResources.forEach((tr) => { if (tr && tr.name) tasks.push(tr.name); });
  }
  ["preBuffer", "postBuffer"].forEach((k) => {
    const b = step[k];
    if (_isObj(b) && Array.isArray(b.taskResources)) {
      b.taskResources.forEach((tr) => { if (tr && tr.name) tasks.push(tr.name); });
    }
  });
  return tasks;
}

// ---------------------------------------------------------------------
// Schema 0.3.0-alpha `instances` / step-level `replicates` checks
// (PRD prd-per-instance-triggers-barriers §6.1). These run on the
// UNEXPANDED program, before expandReplicates, so a malformed program
// gets its proper code rather than `expansion_failed`. Mirrors the
// Python module rhylthyme/instance_checks.py; keep the two in step.
//
//   E_INSTANCES_ON_SINGLE   `instances` on a reference to a step that is
//                           neither replicated nor "each"-derived
//   E_EACH_WITH_REPLICATES  step has both instances:"each" and replicates
//   E_EACH_COUNT_MISMATCH   compound "each" over groups of different size
//   E_INFLIGHT_GT_COUNT     `replicates.maxInFlight` greater than `count`
//   E_INFLIGHT_NO_CHAIN     `maxInFlight` on a serial replicate with no
//                           "each" descendants, where it can have no effect
//   W_UNBARRIERED_CHAIN     "each" chain with no "all" barrier while later
//                           steps reference nothing in it (warning)
//   I_IMPLICIT_BARRIER      0.3.0 program referencing a replicated step
//                           without `instances` (info; JS only, PRD §9 Q5)
// ---------------------------------------------------------------------

const STEP_REF_TYPES = new Set(["afterStep", "afterStepWithBuffer"]);

function _atoms(trig) {
  if (!_isObj(trig)) return [];
  if (Array.isArray(trig.triggers)) return trig.triggers.filter(_isObj);
  return [trig];
}
function _stepRefs(trig) {
  return _atoms(trig).filter((a) => STEP_REF_TYPES.has(a.type) && a.stepId);
}
function _replicateCount(step) {
  if (!_isObj(step.replicates)) return null;
  const n = Number(step.replicates.count === undefined ? 1 : step.replicates.count);
  return Number.isFinite(n) ? n : null;
}
function _maxInFlight(step) {
  if (!_isObj(step.replicates) || step.replicates.maxInFlight === undefined) return null;
  const n = Number(step.replicates.maxInFlight);
  return Number.isFinite(n) ? n : null;
}

function instanceFindings(program) {
  const out = [];
  const push = (severity, code, message, where, fix) => out.push({ severity, code, message, where, fix });
  const tracks = Array.isArray(program.tracks) ? program.tracks : [];
  const steps = {}, order = [];
  tracks.forEach((t) => {
    if (!_isObj(t)) return;
    (Array.isArray(t.steps) ? t.steps : []).forEach((s) => {
      if (!_isObj(s) || !s.stepId) return;
      if (!steps[s.stepId]) order.push(s.stepId);
      steps[s.stepId] = s;
    });
  });
  const touched = order.some((id) => _replicateCount(steps[id]) !== null
    || _atoms(steps[id].startTrigger).some((a) => Object.prototype.hasOwnProperty.call(a, "instances")));
  if (!touched) return out;

  // Instance groups: replicated steps, then (to a fixed point) steps that
  // inherit a count through instances:"each". groups[id] = { count, upstream }.
  const groups = {};
  order.forEach((id) => { const n = _replicateCount(steps[id]); if (n !== null) groups[id] = { count: n, upstream: id }; });
  const eachOf = {};
  order.forEach((id) => { eachOf[id] = _stepRefs(steps[id].startTrigger).filter((a) => a.instances === "each").map((a) => a.stepId); });
  let changed = true;
  while (changed) {
    changed = false;
    order.forEach((id) => {
      if (groups[id] || !eachOf[id].length) return;
      const resolved = eachOf[id].filter((u) => groups[u]);
      if (!resolved.length) return;
      groups[id] = { count: groups[resolved[0]].count, upstream: resolved[0] };
      changed = true;
    });
  }

  // The instances:"each" descendants of a replicated step, in program
  // order: the per-instance chain hanging off it. Used by the maxInFlight
  // checks and by W_UNBARRIERED_CHAIN below.
  const eachChain = (root) => {
    const chain = [], frontier = [root];
    while (frontier.length) {
      const cur = frontier.shift();
      order.forEach((id) => {
        if (id === root || chain.includes(id)) return;
        if (eachOf[id].includes(cur) && groups[id]) { chain.push(id); frontier.push(id); }
      });
    }
    return chain;
  };

  const is030 = typeof program.schemaVersion === "string" && /^0\.3\./.test(program.schemaVersion);
  order.forEach((id) => {
    const step = steps[id], where = `step:${id}`;
    const refs = _stepRefs(step.startTrigger);
    const own = _replicateCount(step);
    refs.forEach((a) => {
      const target = a.stepId;
      if (!steps[target]) return; // dangling_step_ref handles it
      if (Object.prototype.hasOwnProperty.call(a, "instances")) {
        if (!groups[target]) {
          push("error", "E_INSTANCES_ON_SINGLE",
            `Step "${id}" uses instances: "${a.instances}" on "${target}", which is not replicated.`, where,
            `remove \`instances\`, or add \`replicates\` to \`${target}\``);
        }
      } else if (is030 && groups[target]) {
        push("info", "I_IMPLICIT_BARRIER",
          `Step "${id}" waits for replicated step "${target}" without \`instances\`; this is an implicit instances: "all" barrier.`, where,
          `add \`instances: "all"\` to make the barrier explicit, or \`"each"\` to run per instance`);
      }
    });
    const eachRefs = refs.filter((a) => a.instances === "each" && groups[a.stepId]);
    if (own !== null && eachRefs.length) {
      const up = eachRefs[0].stepId;
      push("error", "E_EACH_WITH_REPLICATES",
        `Step "${id}" has both an instances: "each" trigger (on "${up}") and its own \`replicates\`.`, where,
        `drop \`replicates\` on \`${id}\`; it inherits \`${groups[up].count}\` instances from \`${up}\``);
    }
    if (eachRefs.length > 1) {
      const first = eachRefs[0].stepId, n = groups[first].count;
      eachRefs.slice(1).forEach((a) => {
        const m = groups[a.stepId].count;
        if (m !== n) {
          push("error", "E_EACH_COUNT_MISMATCH",
            `Step "${id}" pairs instances of "${first}" (count ${n}) with "${a.stepId}" (count ${m}).`, where,
            `both upstream steps must have \`count: ${n}\``);
        }
      });
    }
    // ---- replicates.maxInFlight ----
    const limit = _maxInFlight(step);
    if (limit !== null) {
      const n = own === null ? 1 : own;
      // E_INFLIGHT_GT_COUNT: more instances in flight than exist.
      if (limit > n) {
        push("error", "E_INFLIGHT_GT_COUNT",
          `Step "${id}" has maxInFlight ${limit} but only ${n} instance${n === 1 ? "" : "s"}.`, where,
          `set \`maxInFlight\` <= \`${n}\` or omit it`);
      }
      // E_INFLIGHT_NO_CHAIN: serial instances already cannot overlap, so
      // with no "each" descendants the limit can never bite.
      const mode = step.replicates.mode === undefined ? "parallel" : step.replicates.mode;
      if (mode === "serial" && !eachChain(id).length) {
        push("error", "E_INFLIGHT_NO_CHAIN",
          `Step "${id}" sets maxInFlight but has mode "serial" and no instances: "each" descendants, so no instance is ever held back.`, where,
          "`maxInFlight` has no effect here; remove it or chain a per-instance step");
      }
    }
  });

  // W_UNBARRIERED_CHAIN: for each replicated root with "each" descendants,
  // the chain is those descendants; barriered when some step references a
  // chain member with instances "all" or with no `instances` (implicit
  // join). "Later steps" are steps outside the chain that are not upstream
  // of the root or of any chain member (so the other root of a compound
  // "each" is not "later") and reference nothing in the chain.
  const upstreamOf = (ids) => {
    const seen = new Set(), stack = ids.slice();
    while (stack.length) {
      const cur = stack.pop();
      _stepRefs((steps[cur] || {}).startTrigger).forEach((a) => {
        if (steps[a.stepId] && !seen.has(a.stepId)) { seen.add(a.stepId); stack.push(a.stepId); }
      });
    }
    return seen;
  };
  order.filter((id) => _replicateCount(steps[id]) !== null).forEach((root) => {
    const chain = eachChain(root);
    if (!chain.length) return;
    const inChain = new Set(chain), upstream = upstreamOf([root].concat(chain));
    let barriered = false;
    const later = [];
    for (const id of order) {
      if (id === root || inChain.has(id)) continue;
      const touches = _stepRefs(steps[id].startTrigger).filter((a) => inChain.has(a.stepId));
      if (touches.some((a) => (a.instances === undefined ? "all" : a.instances) === "all")) { barriered = true; break; }
      if (!touches.length && !upstream.has(id)) later.push(id);
    }
    if (barriered || !later.length) return;
    push("warning", "W_UNBARRIERED_CHAIN",
      `The instances: "each" chain from "${root}" (${chain.join(", ")}) has no instances: "all" barrier, but later steps (${later.join(", ")}) do not wait for it.`,
      `step:${root}`, 'add a step with `instances:"all"` if later work should wait for every instance');
  });
  return out;
}

// ---------------------------------------------------------------------
// validateProgram
// ---------------------------------------------------------------------

function validateProgram(program) {
  const errors = [];
  const warnings = [];
  const info = [];
  const err = (code, message, where, fix) => errors.push({ code, message, where: where || null, fix: fix || null });
  const warn = (code, message, where, fix) => warnings.push({ code, message, where: where || null, fix: fix || null });
  const note = (code, message, where, fix) => info.push({ code, message, where: where || null, fix: fix || null });

  if (!_isObj(program)) {
    err("not_an_object", "Program must be a JSON object.", null, "Pass the full program JSON, not a string or array.");
    return { valid: false, errors, warnings, info, stats: null };
  }
  // Schema 0.3.0-alpha `instances` / `replicates` checks run on the
  // unexpanded program: expansion strips those keys, and a malformed
  // program should get its code (E_EACH_WITH_REPLICATES, ...) rather
  // than an expansion failure.
  let instanceErrors = 0;
  instanceFindings(program).forEach((f) => {
    if (f.severity === "error") { instanceErrors++; err(f.code, f.message, f.where, f.fix); }
    else if (f.severity === "warning") warn(f.code, f.message, f.where, f.fix);
    else note(f.code, f.message, f.where, f.fix);
  });
  // Expand replicates next, as the Python validator does, so ids,
  // overlaps and timings are checked on the program that will run. An
  // expansion the expander cannot express is reported, not thrown; the
  // expander's own raises are only a backstop behind the checks above.
  try {
    program = expandReplicates(program);
  } catch (e) {
    if (!instanceErrors) {
      err("expansion_failed", `Could not expand replicates: ${e && e.message ? e.message : e}`, "program",
        "Check `replicates` and `instances` on the steps named in the message.");
    }
    return { valid: false, errors, warnings, info, stats: null };
  }

  // Top-level fields.
  if (!program.programId || typeof program.programId !== "string") {
    err("missing_program_id", "programId is required.", "program", "Add a kebab-case programId, e.g. \"thanksgiving-dinner\".");
  } else if (!/^[a-z0-9][a-z0-9-_]*$/i.test(program.programId)) {
    warn("program_id_format", `programId "${program.programId}" is not kebab-case.`, "program.programId", "Use lowercase letters, digits and dashes.");
  }
  if (!program.name || typeof program.name !== "string") {
    err("missing_name", "name is required.", "program", "Add a human-readable name.");
  }
  if (!program.schemaVersion) {
    warn("missing_schema_version", "schemaVersion is missing; viewer assumes \"0.1.0\".", "program", "Set schemaVersion to \"0.1.0\" (\"0.2.0-alpha\" if you use choice branching, \"0.3.0-alpha\" if you use `instances` on triggers).");
  }
  const tracks = Array.isArray(program.tracks) ? program.tracks : null;
  if (!tracks || !tracks.length) {
    err("no_tracks", "Program needs at least one track with steps.", "program.tracks", "Add tracks: one per parallel line of work (dish, station, instrument, performer).");
    return { valid: false, errors, warnings, info, stats: null };
  }

  // Collect ids.
  const stepById = {};
  const stepTrack = {};
  const trackIds = {};
  const idCount = {};
  let stepCount = 0;
  tracks.forEach((track, ti) => {
    const tWhere = `tracks[${ti}]`;
    if (!_isObj(track)) { err("bad_track", "Track is not an object.", tWhere); return; }
    if (!track.trackId) err("missing_track_id", "trackId is required.", tWhere, "Add a unique trackId.");
    else if (trackIds[track.trackId]) err("duplicate_track_id", `Duplicate trackId "${track.trackId}".`, tWhere, "Make every trackId unique.");
    else trackIds[track.trackId] = true;
    if (!track.name) warn("missing_track_name", "Track has no name; the viewer will show a generic label.", tWhere, "Add a short display name.");
    const steps = Array.isArray(track.steps) ? track.steps : [];
    if (!steps.length && !track.templateId) {
      warn("empty_track", `Track "${track.name || track.trackId || ti}" has no steps.`, tWhere, "Remove the track or add steps.");
    }
    steps.forEach((step, si) => {
      const sWhere = `${tWhere}.steps[${si}]`;
      stepCount++;
      if (!_isObj(step)) { err("bad_step", "Step is not an object.", sWhere); return; }
      if (!step.stepId) { err("missing_step_id", "stepId is required.", sWhere, "Add a unique stepId."); return; }
      idCount[step.stepId] = (idCount[step.stepId] || 0) + 1;
      stepById[step.stepId] = step;
      stepTrack[step.stepId] = track.trackId;
    });
  });
  Object.keys(idCount).forEach((id) => {
    if (idCount[id] > 1) err("duplicate_step_id", `Duplicate stepId "${id}" (${idCount[id]} times).`, `step:${id}`, "stepIds must be unique across ALL tracks, not just within one track.");
  });

  // Per-step checks.
  const choiceOptions = {};
  Object.keys(stepById).forEach((id) => {
    const s = stepById[id];
    if (_isObj(s.choice) && Array.isArray(s.choice.options)) {
      choiceOptions[id] = new Set(s.choice.options.map((o) => o && o.choiceId).filter(Boolean));
      if (s.choice.options.length < 2) err("choice_too_few_options", `Choice on step "${id}" needs at least 2 options.`, `step:${id}`);
    }
  });

  const tasksUsed = new Set();
  const hasVariable = [];
  tracks.forEach((track, ti) => {
    const steps = Array.isArray(track.steps) ? track.steps : [];
    steps.forEach((step, si) => {
      if (!_isObj(step) || !step.stepId) return;
      const where = `step:${step.stepId}`;
      if (!step.name) warn("missing_step_name", `Step "${step.stepId}" has no name.`, where, "Add a short imperative name (\"Sear the chicken\").");

      // Duration. An instrument step may leave it to the instrument.
      const d = step.duration;
      const estimate = instrumentEstimate(step);
      if (estimate) {
        const inst = step.instrument;
        note("I_INSTRUMENT_DURATION", `Step "${step.stepId}" has no duration; it ends when ${inst.tool} replies. Timings use ${estimate.seconds} s (${estimate.source === "params" ? "from its params" : "a default"}).`,
          where, "`rhylthyme plan --workcell` fills it from the tool's own estimate.");
      } else if (d === undefined || d === null) {
        err("missing_duration", `Step "${step.stepId}" has no duration.`, where, "Add duration: {type:\"fixed\", seconds:N} (or \"5m\").");
      } else if (_isObj(d)) {
        if (d.type && !DURATION_TYPES.has(d.type)) {
          err("bad_duration_type", `Step "${step.stepId}" duration.type "${d.type}" is not fixed|variable|indefinite.`, where);
        }
        const type = d.type || (d.seconds !== undefined ? "fixed" : (d.maxSeconds !== undefined ? "variable" : "indefinite"));
        if (type === "fixed") {
          if (d.seconds === undefined || d.seconds === null) {
            err("fixed_without_seconds", `Step "${step.stepId}" is fixed but has no seconds.`, where, "Add seconds (number or \"5m\").");
          } else if (!(parseSeconds(d.seconds) > 0) && String(d.seconds).trim() !== "0") {
            err("unparseable_duration", `Step "${step.stepId}" duration.seconds "${d.seconds}" is not a positive number or time string.`, where, "Use a number of seconds or a string like \"5m\", \"1h30m\".");
          }
        } else if (type === "variable") {
          const min = parseSeconds(d.minSeconds), max = parseSeconds(d.maxSeconds);
          if (d.minSeconds === undefined || d.maxSeconds === undefined) {
            err("variable_without_bounds", `Step "${step.stepId}" is variable but lacks minSeconds/maxSeconds.`, where, "Add minSeconds, maxSeconds and (recommended) defaultSeconds.");
          } else if (min > max) {
            err("variable_min_gt_max", `Step "${step.stepId}" minSeconds (${min}) > maxSeconds (${max}).`, where);
          }
          if (d.defaultSeconds === undefined) {
            warn("variable_without_default", `Step "${step.stepId}" is variable with no defaultSeconds; planning uses maxSeconds.`, where, "Add defaultSeconds so previews reflect the expected time.");
          }
          hasVariable.push(step.stepId);
        } else if (type === "indefinite" && d.defaultSeconds === undefined) {
          warn("indefinite_without_default", `Step "${step.stepId}" is indefinite with no defaultSeconds; it renders as zero-length.`, where, "Add defaultSeconds for a realistic preview.");
        }
      } else if (!(parseSeconds(d) > 0)) {
        err("unparseable_duration", `Step "${step.stepId}" duration "${d}" could not be parsed.`, where, "Use {type:\"fixed\", seconds:N}.");
      }

      // Trigger.
      const trig = step.startTrigger;
      if (!_isObj(trig)) {
        err("missing_start_trigger", `Step "${step.stepId}" has no startTrigger.`, where,
          si === 0 ? "First step of a track usually uses {type:\"programStart\"}."
                   : "Chain it with {type:\"afterStep\", stepId:\"<previous step in this track>\"}.");
      } else {
        if (trig.logic && !Array.isArray(trig.triggers)) {
          err("compound_without_triggers", `Step "${step.stepId}" compound trigger has logic but no triggers[].`, where);
        }
        if (trig.logic && trig.logic !== "all" && trig.logic !== "any") {
          err("bad_trigger_logic", `Step "${step.stepId}" trigger logic must be "all" or "any".`, where);
        }
        _flattenTriggers(trig).forEach((t) => {
          if (!_isObj(t)) { err("bad_trigger", `Step "${step.stepId}" has a malformed trigger.`, where); return; }
          const type = t.type || "programStart";
          if (!SINGLE_TRIGGER_TYPES.has(type)) {
            err("unknown_trigger_type", `Step "${step.stepId}" trigger type "${type}" is unknown.`, where,
              "Use programStart, programStartOffset, afterStep, afterStepWithBuffer, manual or onAbort.");
          }
          if (type === "afterStep" || type === "afterStepWithBuffer" || type === "onAbort") {
            if (!t.stepId) err("trigger_without_step_id", `Step "${step.stepId}" ${type} trigger has no stepId.`, where, "Point it at the step it waits for.");
            else if (!stepById[t.stepId]) err("dangling_step_ref", `Step "${step.stepId}" waits for "${t.stepId}", which does not exist.`, where, "Fix the stepId to match an existing step (ids are case-sensitive).");
            else if (t.stepId === step.stepId) err("self_reference", `Step "${step.stepId}" waits for itself.`, where);
            if (type === "afterStepWithBuffer" && t.bufferSeconds === undefined) {
              err("buffer_without_seconds", `Step "${step.stepId}" afterStepWithBuffer needs bufferSeconds.`, where);
            }
            if (t.event && t.event !== "start" && t.event !== "end") {
              err("bad_trigger_event", `Step "${step.stepId}" trigger event must be "start" or "end".`, where);
            }
            const off = parseSeconds(t.offsetSeconds);
            if (off < 0) {
              const ref = stepById[t.stepId];
              const refType = ref && _isObj(ref.duration) ? ref.duration.type : null;
              if (refType !== "indefinite") {
                warn("negative_offset_on_fixed", `Step "${step.stepId}" starts ${-off}s before "${t.stepId}" ends, but "${t.stepId}" is not indefinite. The live runner cannot honor a countdown into a fixed step.`, where, "Give the referenced step duration.type=\"indefinite\", or use a positive offset from event=\"start\".");
              }
            }
            if (t.choiceId) {
              const opts = choiceOptions[t.stepId];
              if (!opts) err("choice_ref_no_choice", `Step "${step.stepId}" references choiceId "${t.choiceId}" on "${t.stepId}", which has no choice.`, where);
              else if (!opts.has(t.choiceId)) err("choice_ref_unknown", `Step "${step.stepId}" references choiceId "${t.choiceId}" but "${t.stepId}" only offers: ${Array.from(opts).join(", ")}.`, where);
            }
          }
          if (type === "programStartOffset" && t.offsetSeconds === undefined) {
            err("offset_without_seconds", `Step "${step.stepId}" programStartOffset needs offsetSeconds.`, where);
          }
        });
      }

      _stepTasks(step).forEach((t) => tasksUsed.add(t));
    });
  });

  // Resource constraints.
  const constraints = Array.isArray(program.resourceConstraints) ? program.resourceConstraints : [];
  const constraintTasks = new Set();
  constraints.forEach((rc, i) => {
    const where = `resourceConstraints[${i}]`;
    if (!_isObj(rc) || !rc.task) { err("bad_resource_constraint", "Resource constraint needs a task name.", where); return; }
    if (constraintTasks.has(rc.task)) warn("duplicate_constraint", `Resource constraint for "${rc.task}" is listed twice.`, where);
    constraintTasks.add(rc.task);
    if (!(Number(rc.maxConcurrent) >= 1)) err("bad_max_concurrent", `Resource "${rc.task}" maxConcurrent must be an integer >= 1.`, where);
  });
  const usesEnvironment = !!program.environment;
  tasksUsed.forEach((t) => {
    if (!constraintTasks.has(t)) {
      if (usesEnvironment || program.actors !== undefined) {
        warn("task_not_constrained", `Task "${t}" has no resourceConstraint (environment/actors may supply one).`, "resourceConstraints");
      } else {
        err("task_not_constrained", `Task "${t}" is used by steps but has no resourceConstraint.`, "resourceConstraints", `Add {task:"${t}", maxConcurrent:N}. Every task used in a step needs a matching constraint.`);
      }
    }
  });
  constraintTasks.forEach((t) => {
    if (!tasksUsed.has(t)) warn("unused_constraint", `Resource constraint "${t}" is not used by any step.`, "resourceConstraints", "Remove it, or set task on the steps that use it.");
  });

  // Timing-based checks: cycles / unresolved and within-track overlaps.
  const timings = computeStepTimings(program);
  Object.keys(timings).forEach((id) => {
    if (timings[id].resolved) return;
    // Dangling refs were already reported above; only surface the
    // cycle case here so the model sees one actionable error per cause.
    const refs = _flattenTriggers(stepById[id] && stepById[id].startTrigger).map((t) => t && t.stepId).filter(Boolean);
    if (refs.length && refs.every((r) => stepById[r])) {
      err("dependency_cycle", `Step "${id}" could not be scheduled — its dependencies form a cycle.`, `step:${id}`, "Break the cycle: a step cannot (transitively) wait on itself.");
    }
  });
  tracks.forEach((track) => {
    const steps = (Array.isArray(track.steps) ? track.steps : []).filter((s) => _isObj(s) && s.stepId && timings[s.stepId] && timings[s.stepId].resolved);
    const placed = steps.map((s) => {
      const t = timings[s.stepId];
      const trig = s.startTrigger || {};
      let choiceId = trig.choiceId;
      if (!choiceId) {
        const sub = _flattenTriggers(trig).find((x) => x && x.choiceId);
        if (sub) choiceId = sub.choiceId;
      }
      return { id: s.stepId, name: s.name || s.stepId, start: t.start, end: t.end, choiceId: choiceId || null };
    }).sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < placed.length; i++) {
      const a = placed[i], b = placed[i + 1];
      // Different choice branches never run together; a branch and a
      // convergence step are also exempt (mirrors the Python validator).
      if (a.choiceId || b.choiceId) {
        if (!(a.choiceId && b.choiceId && a.choiceId === b.choiceId)) continue;
      }
      if (a.end > b.start) {
        err("track_overlap",
          `Track "${track.name || track.trackId}": "${a.name}" (ends ${a.end}s) overlaps "${b.name}" (starts ${b.start}s) by ${a.end - b.start}s.`,
          `step:${b.id}`,
          `Steps in one track run sequentially. Chain "${b.id}" with {type:"afterStep", stepId:"${a.id}"} or move it to its own track if it truly runs in parallel.`);
      }
    }
  });

  // Advisory: a step with no dependants and a fixed duration that ends
  // long before the makespan is probably fine; but a program whose
  // tracks all finish far apart is worth flagging for "finish together".
  const ends = tracks.map((t) => (t.steps || []).reduce((m, s) => Math.max(m, (timings[s && s.stepId] || { end: 0 }).end), 0));
  const makespan = Math.max(0, ...ends);
  const laggards = tracks.filter((t, i) => (t.steps || []).length && makespan - ends[i] > Math.max(1800, makespan * 0.5));
  if (laggards.length && tracks.length > 1) {
    warn("tracks_finish_far_apart",
      `${laggards.length} track(s) finish more than ${Math.round(Math.max(1800, makespan * 0.5) / 60)} min before the last one (${laggards.map((t) => `"${t.name || t.trackId}"`).join(", ")}).`,
      "program.tracks",
      "If everything should be ready together, delay those tracks with programStartOffset or afterStep so they converge at the end.");
  }

  // galago-tools instrument commands, checked against the tool type.
  Galago.instrumentFindings(program).forEach((f) => {
    if (f.severity === "error") err(f.code, f.message, f.where, f.fix);
    else warn(f.code, f.message, f.where, f.fix);
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
    stats: {
      tracks: tracks.length,
      steps: stepCount,
      makespanSeconds: makespan,
      resourceConstraints: constraints.length,
      variableSteps: hasVariable.length,
    },
  };
}

// ---------------------------------------------------------------------
// analyzeSchedule
// ---------------------------------------------------------------------

function _fmtClock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function _fmtDur(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m <= 0) return `${Math.round(sec || 0)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function _parseIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------
// In-flight windows (schema 0.3.0-alpha `replicates.maxInFlight`)
//
// After expansion, the cap survives only as synthetic gate atoms:
// instance i of the authored step X carries, for i > k, an
// `afterStep L-r<i-k>` atom tagged `_synthetic: "inFlight"` with
// `inFlightOf: X` and `inFlightLimit: k` (PRD §5 step 4). Instances
// 1..k carry no gate, so the leaf chains are derived from the gated
// instances and the instance set from `instanceOf` / `instanceIndex`.
//
// Instance i is *in flight* from the start of X-r<i> until it has ended
// in every "each" descendant, i.e. until the last of its leaves ends.
// These helpers are exported so the planners (Phase 6) can pack against
// the same windows the analyzer reports.
// ---------------------------------------------------------------------

const SYNTHETIC_IN_FLIGHT = "inFlight";

// Synthetic in-flight atoms sit at the top level of the outer compound,
// never nested deeper, so a non-recursive scan is exact.
function _inFlightAtoms(step) {
  const trig = step && step.startTrigger;
  if (!_isObj(trig)) return [];
  const atoms = Array.isArray(trig.triggers) ? trig.triggers : [trig];
  return atoms.filter((a) => _isObj(a) && a._synthetic === SYNTHETIC_IN_FLIGHT && a.stepId);
}

function _instanceIndexOf(step) {
  const n = Number(step && step.instanceIndex);
  return Number.isFinite(n) ? n : null;
}

// Group the synthetic gates of an EXPANDED program by the authored step
// whose instances they cap.
//   [{ inFlightOf, maxInFlight, count, task, leafTasks[], leafSteps[],
//      gatedSteps[], instances: [{ instanceIndex, stepId, leafStepIds[] }] }]
function inFlightGroups(program) {
  const tracks = Array.isArray(program && program.tracks) ? program.tracks : [];
  const all = [];
  tracks.forEach((t) => (t.steps || []).forEach((s) => { if (_isObj(s) && s.stepId) all.push(s); }));
  const byId = {};
  all.forEach((s) => { byId[s.stepId] = s; });

  // authored stepId -> instanceIndex -> expanded stepId
  const instances = {};
  all.forEach((s) => {
    const i = _instanceIndexOf(s);
    if (s.instanceOf && i !== null) (instances[s.instanceOf] = instances[s.instanceOf] || {})[i] = s.stepId;
  });

  const groups = {};
  all.forEach((s) => {
    _inFlightAtoms(s).forEach((a) => {
      const root = a.inFlightOf || s.instanceOf;
      if (!root) return;
      const g = groups[root] || (groups[root] = { inFlightOf: root, maxInFlight: null, leafSteps: [], gatedSteps: [] });
      const k = Number(a.inFlightLimit);
      if (g.maxInFlight === null && Number.isFinite(k)) g.maxInFlight = k;
      const leaf = byId[a.stepId];
      const leafRoot = (leaf && leaf.instanceOf) || a.stepId;
      if (g.leafSteps.indexOf(leafRoot) === -1) g.leafSteps.push(leafRoot);
      if (g.gatedSteps.indexOf(s.stepId) === -1) g.gatedSteps.push(s.stepId);
    });
  });

  return Object.keys(groups).sort().map((root) => {
    const g = groups[root];
    const idx = instances[root] || {};
    const order = Object.keys(idx).map(Number).sort((a, b) => a - b);
    const leafTasks = [];
    g.leafSteps.forEach((L) => {
      const first = byId[(instances[L] || {})[order[0]]];
      const task = first && first.task;
      if (task && leafTasks.indexOf(task) === -1) leafTasks.push(task);
    });
    return {
      inFlightOf: root,
      maxInFlight: g.maxInFlight,
      count: order.length,
      task: leafTasks[0] || root,
      leafTasks,
      leafSteps: g.leafSteps.slice(),
      gatedSteps: g.gatedSteps.slice(),
      instances: order.map((i) => ({
        instanceIndex: i,
        stepId: idx[i],
        leafStepIds: g.leafSteps.map((L) => (instances[L] || {})[i]).filter(Boolean),
      })),
    };
  });
}

// Same groups, with each instance's in-flight interval resolved against
// `timings` (which must come from the same expanded program).
function inFlightWindows(program, timings) {
  timings = timings || {};
  return inFlightGroups(program).map((g) => {
    const windows = g.instances.map((inst) => {
      const rt = timings[inst.stepId];
      if (!rt) return null;
      let end = rt.end;
      inst.leafStepIds.forEach((L) => { const lt = timings[L]; if (lt && lt.end > end) end = lt.end; });
      return {
        instanceIndex: inst.instanceIndex, stepId: inst.stepId,
        leafStepIds: inst.leafStepIds.slice(),
        startSeconds: rt.start, endSeconds: end,
      };
    }).filter(Boolean);
    let load = 0, peak = 0, peakAt = 0;
    _sweep(windows).forEach(([time, delta]) => {
      load += delta;
      if (load > peak) { peak = load; peakAt = time; }
    });
    return Object.assign({}, g, { windows, peakInFlight: peak, peakAtSeconds: peakAt });
  });
}

// Sorted start/end events; an end at time t precedes a start at time t,
// so instance i+k starting exactly as instance i leaves flight is not
// counted as an overlap.
function _sweep(items) {
  const ev = [];
  items.forEach((w) => { ev.push([w.startSeconds, 1, w]); ev.push([w.endSeconds, -1, w]); });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return ev;
}

// Over-subscription of an in-flight cap, in the resourceConflicts shape.
function inFlightConflicts(program, timings) {
  const out = [];
  inFlightWindows(program, timings).forEach((g) => {
    const cap = g.maxInFlight;
    if (!cap) return;
    let load = 0;
    const active = new Set();
    let windowStart = null, windowSteps = null;
    _sweep(g.windows).forEach(([time, delta, w]) => {
      if (delta > 0) active.add(w); else active.delete(w);
      load += delta;
      if (load > cap && windowStart === null) { windowStart = time; windowSteps = new Set(active); }
      else if (load > cap) { active.forEach((x) => windowSteps.add(x)); }
      else if (windowStart !== null) {
        const ws = Array.from(windowSteps).sort((a, b) => a.instanceIndex - b.instanceIndex);
        out.push({
          kind: SYNTHETIC_IN_FLIGHT,
          task: g.task,
          inFlightOf: g.inFlightOf,
          maxInFlight: cap,
          demand: ws.length,
          startSeconds: windowStart,
          endSeconds: time,
          steps: ws.map((x) => x.stepId),
          fix: `${ws.length} instances of "${g.inFlightOf}" are in flight at once (started but not yet through "${g.task}") where maxInFlight is ${cap}. Raise replicates.maxInFlight on "${g.inFlightOf}" to ${ws.length}, or hold the later instances until an earlier one clears.`,
        });
        windowStart = null; windowSteps = null;
      }
    });
  });
  return out;
}

// The whole analysis for ONE set of durations. `analyzeSchedule` calls it
// once for the authored program and, when history is supplied, a second time
// for a copy whose durations are the predicted ones — so the predicted
// makespan, itinerary, critical path, conflicts and binding constraints come
// from exactly the same code as the planned ones.
function _analyzeCore(program, opts) {
  opts = opts || {};
  program = expandReplicates(program || {});
  const tracks = Array.isArray(program && program.tracks) ? program.tracks : [];
  const timings = computeStepTimings(program || {});
  const stepMeta = {};
  tracks.forEach((t) => {
    (t.steps || []).forEach((s) => {
      if (_isObj(s) && s.stepId) stepMeta[s.stepId] = { step: s, track: t };
    });
  });

  let makespan = 0;
  Object.keys(timings).forEach((id) => { makespan = Math.max(makespan, timings[id].end); });

  // Wall-clock anchoring: finishAt wins (work backwards); else startAt.
  let anchorStart = null;
  const finishAt = _parseIso(opts.finishAt);
  const startAt = _parseIso(opts.startAt);
  if (finishAt) anchorStart = new Date(finishAt.getTime() - makespan * 1000);
  else if (startAt) anchorStart = startAt;
  const wall = (sec) => (anchorStart ? new Date(anchorStart.getTime() + sec * 1000).toISOString() : undefined);

  // Predecessors (for the critical path) — every step a trigger waits on.
  const preds = {};
  Object.keys(stepMeta).forEach((id) => {
    const trig = stepMeta[id].step.startTrigger;
    preds[id] = [];
    _flattenTriggers(trig).forEach((t) => {
      if (t && t.stepId && timings[t.stepId] && (t.type === "afterStep" || t.type === "afterStepWithBuffer")) preds[id].push(t.stepId);
    });
    if (_isObj(trig) && (trig.type === "manual" || trig.type === "previousStepComplete")) {
      const steps = stepMeta[id].track.steps || [];
      const idx = steps.findIndex((s) => s && s.stepId === id);
      if (idx > 0 && steps[idx - 1] && steps[idx - 1].stepId) preds[id].push(steps[idx - 1].stepId);
    }
  });

  // Critical path: walk back from the step that ends last, choosing at
  // each hop the predecessor whose end is closest to this step's start.
  const criticalPath = [];
  let cur = null;
  Object.keys(timings).forEach((id) => {
    if (cur === null || timings[id].end > timings[cur].end) cur = id;
  });
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    criticalPath.unshift(cur);
    const ps = preds[cur] || [];
    let best = null;
    ps.forEach((p) => {
      if (best === null || Math.abs(timings[p].end - timings[cur].start) < Math.abs(timings[best].end - timings[cur].start)) best = p;
    });
    cur = best;
  }

  // Resource conflicts: sweep-line per task.
  const constraints = Array.isArray(program.resourceConstraints) ? program.resourceConstraints : [];
  const capacity = {};
  constraints.forEach((rc) => { if (_isObj(rc) && rc.task) capacity[rc.task] = Number(rc.maxConcurrent) || 1; });
  const usageByTask = {};
  Object.keys(stepMeta).forEach((id) => {
    const t = timings[id];
    if (!t || t.duration <= 0) return;
    _stepTasks(stepMeta[id].step).forEach((task) => {
      (usageByTask[task] = usageByTask[task] || []).push({ id, start: t.start, end: t.end });
    });
  });
  const resourceConflicts = [];
  Object.keys(usageByTask).forEach((task) => {
    const cap = capacity[task];
    if (!cap) return;
    const events = [];
    usageByTask[task].forEach((u) => { events.push([u.start, 1, u.id]); events.push([u.end, -1, u.id]); });
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let load = 0, active = new Set(), windowStart = null, windowSteps = null;
    events.forEach(([time, delta, id]) => {
      if (delta > 0) active.add(id); else active.delete(id);
      load += delta;
      if (load > cap && windowStart === null) { windowStart = time; windowSteps = new Set(active); }
      else if (load > cap && windowStart !== null) { active.forEach((x) => windowSteps.add(x)); }
      else if (load <= cap && windowStart !== null) {
        resourceConflicts.push({
          kind: "maxConcurrent",
          task, maxConcurrent: cap, demand: windowSteps.size,
          startSeconds: windowStart, endSeconds: time,
          steps: Array.from(windowSteps),
          fix: `Stagger these steps (afterStep chain or programStartOffset) or raise maxConcurrent for "${task}" to ${windowSteps.size}.`,
        });
        windowStart = null; windowSteps = null;
      }
    });
  });

  // Second sweep: in-flight over-subscription (more instances between a
  // replicated step and its barrier than `maxInFlight` allows). With a
  // correct expansion this is empty — it fires on hand-edited schedules
  // and on planner output that ignored the gates.
  const inFlight = inFlightWindows(program, timings);
  inFlightConflicts(program, timings).forEach((c) => resourceConflicts.push(c));

  // Binding constraints: for each critical-path edge, what actually
  // gates it — an in-flight cap, a saturated maxConcurrent task, an
  // explicit offset/buffer, or the plain step dependency.
  const bindingConstraints = [];
  for (let i = 1; i < criticalPath.length; i++) {
    const from = criticalPath[i - 1], to = criticalPath[i];
    const tf = timings[from], tt = timings[to];
    if (!tf || !tt || !stepMeta[to]) continue;
    const atoms = _flattenTriggers(stepMeta[to].step.startTrigger)
      .filter((t) => _isObj(t) && t.stepId === from && (t.type === "afterStep" || t.type === "afterStepWithBuffer"));
    const synth = atoms.find((a) => a._synthetic === SYNTHETIC_IN_FLIGHT);
    if (synth) {
      bindingConstraints.push({
        from, to, kind: SYNTHETIC_IN_FLIGHT,
        task: (stepMeta[from] && stepMeta[from].step.task) || synth.inFlightOf || from,
        limit: Number(synth.inFlightLimit) || null,
        inFlightOf: synth.inFlightOf || null,
      });
      continue;
    }
    let explained = null;
    atoms.forEach((a) => {
      const ref = a.event === "start" ? tf.start : tf.end;
      const gap = parseSeconds(a.offsetSeconds) + parseSeconds(a.bufferSeconds);
      if (Math.abs(ref + gap - tt.start) < 1e-6 && (explained === null || Math.abs(gap) > Math.abs(explained))) explained = gap;
    });
    if (explained) { bindingConstraints.push({ from, to, kind: "offset", task: null, limit: null, offsetSeconds: explained }); continue; }
    if (explained === 0) { bindingConstraints.push({ from, to, kind: "dependency", task: null, limit: null }); continue; }
    // Unexplained slack before `to`: did a saturated task free up exactly then?
    let bindingTask = null;
    _stepTasks(stepMeta[to].step).forEach((task) => {
      if (bindingTask || !capacity[task]) return;
      const others = (usageByTask[task] || []).filter((u) => u.id !== to);
      const busy = others.filter((u) => u.start < tt.start && u.end >= tt.start).length;
      if (busy >= capacity[task] && others.some((u) => u.end === tt.start)) bindingTask = task;
    });
    bindingConstraints.push(bindingTask
      ? { from, to, kind: "maxConcurrent", task: bindingTask, limit: capacity[bindingTask] }
      : { from, to, kind: "dependency", task: null, limit: null });
  }

  // Actor load: concurrent steps at any instant (upper bound on people needed).
  const ev = [];
  Object.keys(timings).forEach((id) => { const t = timings[id]; if (t.duration > 0) { ev.push([t.start, 1]); ev.push([t.end, -1]); } });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let load = 0, peak = 0, peakAt = 0;
  ev.forEach(([time, d]) => { load += d; if (load > peak) { peak = load; peakAt = time; } });

  // Per-track summary.
  const trackSummaries = tracks.map((t) => {
    const ids = (t.steps || []).filter((s) => _isObj(s) && s.stepId && timings[s.stepId]).map((s) => s.stepId);
    const ts = ids.map((id) => timings[id]).sort((a, b) => a.start - b.start);
    const start = ts.length ? ts[0].start : 0;
    const end = ts.reduce((m, x) => Math.max(m, x.end), 0);
    const busy = ts.reduce((m, x) => m + x.duration, 0);
    return {
      trackId: t.trackId, name: t.name || t.trackId,
      parentTrackId: t.parentTrackId || null,
      startSeconds: start, endSeconds: end,
      busySeconds: busy, idleSeconds: Math.max(0, (end - start) - busy),
      slackBeforeFinishSeconds: Math.max(0, makespan - end),
      steps: ids.length,
    };
  });

  const steps = Object.keys(stepMeta).map((id) => {
    const t = timings[id];
    const s = stepMeta[id].step;
    return {
      stepId: id, name: s.name || id, trackId: stepMeta[id].track.trackId,
      parentTrackId: stepMeta[id].track.parentTrackId || null,
      instanceOf: s.instanceOf || null,
      instanceIndex: _instanceIndexOf(s),
      task: s.task || null,
      startSeconds: t.start, endSeconds: t.end, durationSeconds: t.duration,
      startClock: _fmtClock(t.start),
      startAt: wall(t.start), endAt: wall(t.end),
      critical: criticalPath.indexOf(id) !== -1,
      resolved: t.resolved !== false,
    };
  }).sort((a, b) => a.startSeconds - b.startSeconds || a.name.localeCompare(b.name));

  return {
    programId: program.programId || null,
    name: program.name || null,
    makespanSeconds: makespan,
    makespan: _fmtDur(makespan),
    tracks: trackSummaries,
    steps,
    criticalPath,
    bindingConstraints,
    resourceConflicts,
    inFlight,
    actorPeak: { concurrentSteps: peak, atSeconds: peakAt, declaredActors: program.actors === undefined ? null : program.actors },
    wallClock: anchorStart ? { startAt: anchorStart.toISOString(), finishAt: new Date(anchorStart.getTime() + makespan * 1000).toISOString(), anchoredBy: finishAt ? "finishAt" : "startAt" } : null,
  };
}

// ============================================================ prediction
//
// `computeStepTimings` reads every duration out of the program, so the way to
// plan against predicted durations is to plan a *copy of the program* whose
// durations are the predicted ones. Nothing in the timing engine or the
// critical-path walk has to know that prediction exists.

/**
 * A deep copy of `program` with `{stepId: seconds}` substituted into the
 * matching steps' durations. A fixed step becomes a fixed step of that
 * length; a variable or indefinite step keeps its kind and gets the number as
 * `defaultSeconds`, with min/max widened if the prediction falls outside the
 * author's range (never narrowed — the same rule calibration follows).
 * Instances match on `instanceOf`, so a prediction for an authored step
 * applies to every one of its replicates.
 */
function withDurations(program, secondsByStep) {
  if (!_isObj(program) || !_isObj(secondsByStep) || !Object.keys(secondsByStep).length) return program;
  const copy = JSON.parse(JSON.stringify(program));
  (Array.isArray(copy.tracks) ? copy.tracks : []).forEach((track) => {
    if (!_isObj(track)) return;
    (Array.isArray(track.steps) ? track.steps : []).forEach((step) => {
      if (!_isObj(step)) return;
      let key = null;
      if (step.stepId !== undefined && secondsByStep[step.stepId] !== undefined) key = step.stepId;
      else if (step.instanceOf !== undefined && secondsByStep[step.instanceOf] !== undefined) key = step.instanceOf;
      if (key === null) return;
      const seconds = Number(secondsByStep[key]);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      const d = _isObj(step.duration) ? step.duration : {};
      const kind = d.type === "variable" || d.type === "indefinite" ? d.type : "fixed";
      if (kind === "fixed") {
        step.duration = { type: "fixed", seconds };
        return;
      }
      const next = Object.assign({}, d, { type: kind, defaultSeconds: seconds });
      delete next.seconds;
      if (next.minSeconds !== undefined && parseSeconds(next.minSeconds) > seconds) next.minSeconds = seconds;
      if (next.maxSeconds !== undefined && parseSeconds(next.maxSeconds) < seconds) next.maxSeconds = seconds;
      step.duration = next;
    });
  });
  return copy;
}

/**
 * Resolve `program` onto the clock, optionally against its own history.
 *
 * @param {object} program
 * @param {object} [opts]
 *   finishAt / startAt   ISO anchors, as before.
 *   history              run records (the `runs` schema). Supplying them adds
 *                        `predicted` to the steps that have history,
 *                        `plannedDurationSeconds` to every step, and the
 *                        top-level `predictedMakespanSeconds`,
 *                        `predictedMakespan`, `predictedCriticalPath` and
 *                        `durationsUsed`. With no history the output is
 *                        byte-for-byte what it was before prediction existed.
 *   predictionContext    { environmentId, userTags, userId, programVersion,
 *                        minIdentical, minModel, corrThreshold, verdicts } —
 *                        passed straight to history.predictDurations.
 *   useDurations         "planned" (default) or "predicted": which set of
 *                        durations the makespan, itinerary, critical path,
 *                        conflicts and binding constraints are computed from.
 *                        The planned duration of each step is reported either
 *                        way, as `plannedDurationSeconds`.
 */
function analyzeSchedule(program, opts) {
  opts = opts || {};
  const anchors = { finishAt: opts.finishAt, startAt: opts.startAt };
  // An empty array is no history: nothing to predict from, so nothing to add.
  const history = Array.isArray(opts.history) && opts.history.length ? opts.history : null;
  if (!history) return _analyzeCore(program, anchors);

  const expanded = expandReplicates(program || {});
  const predictions = History.predictDurations(
    expanded, history, _isObj(opts.predictionContext) ? opts.predictionContext : {}
  );
  const seconds = History.predictedSeconds(predictions);

  const planned = _analyzeCore(expanded, anchors);
  const predicted = Object.keys(seconds).length
    ? _analyzeCore(withDurations(expanded, seconds), anchors)
    : planned;

  const usePredicted = opts.useDurations === "predicted";
  const out = usePredicted ? predicted : planned;
  const plannedById = {};
  planned.steps.forEach((s) => { plannedById[s.stepId] = s; });
  out.steps.forEach((s) => {
    const p = plannedById[s.stepId];
    s.plannedDurationSeconds = p ? p.durationSeconds : null;
    const authored = s.instanceOf || s.stepId;
    if (predictions[authored]) s.predicted = predictions[authored];
  });
  out.durationsUsed = usePredicted ? "predicted" : "planned";
  out.plannedMakespanSeconds = planned.makespanSeconds;
  out.plannedMakespan = planned.makespan;
  out.predictedMakespanSeconds = predicted.makespanSeconds;
  out.predictedMakespan = predicted.makespan;
  out.predictedCriticalPath = predicted.criticalPath;
  return out;
}

// Human-readable digest of an analysis, for the text half of a tool result.
function formatAnalysis(a) {
  const lines = [];
  lines.push(`**Makespan:** ${a.makespan} across ${a.tracks.length} track${a.tracks.length === 1 ? "" : "s"}, ${a.steps.length} steps.`);
  if (a.wallClock) {
    lines.push(`**Wall clock:** start ${a.wallClock.startAt} → finish ${a.wallClock.finishAt} (anchored by ${a.wallClock.anchoredBy}).`);
  }
  if (a.criticalPath.length) {
    const names = a.criticalPath.map((id) => { const s = a.steps.find((x) => x.stepId === id); return s ? s.name : id; });
    lines.push(`**Critical path:** ${names.join(" → ")}`);
  }
  const binding = a.bindingConstraints || [];
  if (binding.length) {
    const gates = binding.filter((b) => b.kind === "inFlight" || b.kind === "maxConcurrent").map((b) => {
      const limit = b.kind === "inFlight" ? `in-flight ≤ ${b.limit}` : `maxConcurrent ${b.limit}`;
      return `\`${b.task}\` (${limit}) gates \`${b.to}\``;
    });
    lines.push(`**Binding constraints:** ${gates.length ? gates.join("; ") : "step dependencies only — no resource or in-flight limit gates the critical path"}.`);
  }
  if (a.durationsUsed) {
    lines.push(
      `**Durations used:** ${a.durationsUsed} \u2014 planned makespan ${a.plannedMakespan}, ` +
      `**predicted makespan ${a.predictedMakespan}**.`
    );
    if (a.predictedCriticalPath && a.predictedCriticalPath.join(">") !== a.criticalPath.join(">")) {
      const names = a.predictedCriticalPath.map((id) => { const s = a.steps.find((x) => x.stepId === id); return s ? s.name : id; });
      lines.push(`**Predicted critical path:** ${names.join(" \u2192 ")}`);
    }
    const predictedSteps = a.steps.filter((s) => s.predicted && s.predicted.seconds !== null && s.predicted.seconds !== undefined);
    if (predictedSteps.length) {
      lines.push("", `**Predicted durations (${predictedSteps.length} of ${a.steps.length} steps have history):**`);
      predictedSteps.forEach((s) => {
        const p = s.predicted;
        const how = p.basis === "identical"
          ? `identical context, n=${p.n}${p.source === "user" ? ", your own runs" : ""}`
          : (p.method === "ols"
            ? `model on ${(p.factors || []).map((f) => f.key).join(", ")}, n=${p.n}`
            : `median, n=${p.n}`);
        lines.push(`- ${s.name}: **${_fmtDur(p.seconds)}** predicted vs ${_fmtDur(s.plannedDurationSeconds)} planned (${_fmtDur(p.low)}\u2013${_fmtDur(p.high)}) \u2014 ${how}`);
      });
    }
    const unpredicted = a.steps.filter((s) => s.predicted && s.predicted.basis === "none");
    if (unpredicted.length) {
      lines.push(`- not predicted: ${unpredicted.map((s) => `${s.name} (${s.predicted.reason || "no history"})`).join(", ")}`);
    }
  }
  if (a.actorPeak.concurrentSteps > 1) {
    const extra = a.actorPeak.declaredActors !== null && a.actorPeak.concurrentSteps > a.actorPeak.declaredActors
      ? ` — exceeds the ${a.actorPeak.declaredActors} declared actor(s)` : "";
    lines.push(`**Peak concurrency:** ${a.actorPeak.concurrentSteps} steps at ${_fmtClock(a.actorPeak.atSeconds)}${extra}.`);
  }
  if (a.resourceConflicts.length) {
    lines.push("", `**Resource conflicts (${a.resourceConflicts.length}):**`);
    a.resourceConflicts.slice(0, 10).forEach((c) => {
      const when = `from ${_fmtClock(c.startSeconds)} to ${_fmtClock(c.endSeconds)} (${c.steps.join(", ")})`;
      if (c.kind === "inFlight") {
        lines.push(`- [inFlight] \`${c.task}\` holds ${c.demand} instances of \`${c.inFlightOf}\` but maxInFlight is ${c.maxInFlight} ${when}`);
      } else {
        lines.push(`- [maxConcurrent] \`${c.task}\` needs ${c.demand} but max is ${c.maxConcurrent} ${when}`);
      }
    });
  } else if (Object.keys(a.tracks).length) {
    lines.push("**Resource conflicts:** none.");
  }
  const inFlight = (a.inFlight || []).filter((g) => g.maxInFlight);
  if (inFlight.length) {
    lines.push("", `**In-flight windows (${inFlight.length}):**`);
    inFlight.forEach((g) => {
      const w = g.windows.map((x) => `#${x.instanceIndex} ${_fmtClock(x.startSeconds)}–${_fmtClock(x.endSeconds)}`).join(", ");
      lines.push(`- \`${g.inFlightOf}\` ×${g.count} through \`${g.task}\`: maxInFlight ${g.maxInFlight}, peak ${g.peakInFlight} at ${_fmtClock(g.peakAtSeconds)} — ${w}`);
    });
  }
  const slack = a.tracks.filter((t) => t.steps && t.slackBeforeFinishSeconds >= 600);
  if (slack.length) {
    lines.push("", "**Tracks that finish early:** " + slack.map((t) => `${t.name} (${_fmtDur(t.slackBeforeFinishSeconds)} early)`).join(", "));
  }
  return lines.join("\n");
}

function formatValidation(v) {
  const lines = [];
  if (v.valid) {
    lines.push(`✅ Program is valid${v.stats ? ` — ${v.stats.tracks} tracks, ${v.stats.steps} steps, ${_fmtDur(v.stats.makespanSeconds)} makespan` : ""}.`);
  } else {
    lines.push(`❌ Program has ${v.errors.length} error${v.errors.length === 1 ? "" : "s"}:`);
    v.errors.forEach((e) => lines.push(`- **${e.code}** ${e.message}${e.fix ? `\n  ↳ ${e.fix}` : ""}`));
  }
  if (v.warnings.length) {
    lines.push("", `⚠️ ${v.warnings.length} warning${v.warnings.length === 1 ? "" : "s"}:`);
    v.warnings.slice(0, 15).forEach((w) => lines.push(`- **${w.code}** ${w.message}${w.fix ? `\n  ↳ ${w.fix}` : ""}`));
    if (v.warnings.length > 15) lines.push(`- …and ${v.warnings.length - 15} more`);
  }
  if (v.info && v.info.length) {
    lines.push("", `ℹ️ ${v.info.length} note${v.info.length === 1 ? "" : "s"}:`);
    v.info.slice(0, 15).forEach((n) => lines.push(`- **${n.code}** ${n.message}${n.fix ? `\n  ↳ ${n.fix}` : ""}`));
  }
  return lines.join("\n");
}

module.exports = {
  validateProgram,
  instanceFindings,
  expandReplicates,
  analyzeSchedule,
  withDurations,
  predictDurations: History.predictDurations,
  predictedSeconds: History.predictedSeconds,
  inFlightGroups,
  inFlightWindows,
  inFlightConflicts,
  formatAnalysis,
  formatValidation,
  parseSeconds,
  stepDurationSeconds,
  computeStepTimings,
  _fmtClock,
  _fmtDur,
};
