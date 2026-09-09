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
//   validateProgram(program)  -> { valid, errors[], warnings[], stats }
//       Structural + logic checks mirroring rhylthyme.validate_program
//       (duplicate ids, dangling refs, cycles, within-track overlaps,
//       tasks without resource constraints, choice references, bad
//       durations). Each finding carries a `fix` hint so the model can
//       repair the program without guessing.
//
//   analyzeSchedule(program, opts) -> { makespanSeconds, steps[], tracks[],
//       criticalPath[], resourceConflicts[], actorPeak, wallClock? }
//       Resolved timeline, critical path, resource over-subscription
//       windows, per-track idle time, and (when opts.startAt or
//       opts.finishAt is given) wall-clock start/end for every step.

"use strict";

const TimelineRender = require("../static/js/timeline-render.js");

const { computeStepTimings, parseSeconds, stepDurationSeconds, expandReplicates } = TimelineRender;

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
// validateProgram
// ---------------------------------------------------------------------

function validateProgram(program) {
  const errors = [];
  const warnings = [];
  const err = (code, message, where, fix) => errors.push({ code, message, where: where || null, fix: fix || null });
  const warn = (code, message, where, fix) => warnings.push({ code, message, where: where || null, fix: fix || null });

  if (!_isObj(program)) {
    err("not_an_object", "Program must be a JSON object.", null, "Pass the full program JSON, not a string or array.");
    return { valid: false, errors, warnings, stats: null };
  }
  // Expand replicates first, as the Python validator does, so ids,
  // overlaps and timings are checked on the program that will run.
  program = expandReplicates(program);

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
    warn("missing_schema_version", "schemaVersion is missing; viewer assumes \"0.1.0\".", "program", "Set schemaVersion to \"0.1.0\" (or \"0.2.0-alpha\" if you use choice branching).");
  }
  const tracks = Array.isArray(program.tracks) ? program.tracks : null;
  if (!tracks || !tracks.length) {
    err("no_tracks", "Program needs at least one track with steps.", "program.tracks", "Add tracks: one per parallel line of work (dish, station, instrument, performer).");
    return { valid: false, errors, warnings, stats: null };
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

      // Duration.
      const d = step.duration;
      if (d === undefined || d === null) {
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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
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

function analyzeSchedule(program, opts) {
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
          task, maxConcurrent: cap, demand: windowSteps.size,
          startSeconds: windowStart, endSeconds: time,
          steps: Array.from(windowSteps),
          fix: `Stagger these steps (afterStep chain or programStartOffset) or raise maxConcurrent for "${task}" to ${windowSteps.size}.`,
        });
        windowStart = null; windowSteps = null;
      }
    });
  });

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
    resourceConflicts,
    actorPeak: { concurrentSteps: peak, atSeconds: peakAt, declaredActors: program.actors === undefined ? null : program.actors },
    wallClock: anchorStart ? { startAt: anchorStart.toISOString(), finishAt: new Date(anchorStart.getTime() + makespan * 1000).toISOString(), anchoredBy: finishAt ? "finishAt" : "startAt" } : null,
  };
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
  if (a.actorPeak.concurrentSteps > 1) {
    const extra = a.actorPeak.declaredActors !== null && a.actorPeak.concurrentSteps > a.actorPeak.declaredActors
      ? ` — exceeds the ${a.actorPeak.declaredActors} declared actor(s)` : "";
    lines.push(`**Peak concurrency:** ${a.actorPeak.concurrentSteps} steps at ${_fmtClock(a.actorPeak.atSeconds)}${extra}.`);
  }
  if (a.resourceConflicts.length) {
    lines.push("", `**Resource conflicts (${a.resourceConflicts.length}):**`);
    a.resourceConflicts.slice(0, 10).forEach((c) => {
      lines.push(`- \`${c.task}\` needs ${c.demand} but max is ${c.maxConcurrent} from ${_fmtClock(c.startSeconds)} to ${_fmtClock(c.endSeconds)} (${c.steps.join(", ")})`);
    });
  } else if (Object.keys(a.tracks).length) {
    lines.push("**Resource conflicts:** none.");
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
  return lines.join("\n");
}

module.exports = {
  validateProgram,
  expandReplicates,
  analyzeSchedule,
  formatAnalysis,
  formatValidation,
  parseSeconds,
  stepDurationSeconds,
  computeStepTimings,
  _fmtClock,
  _fmtDur,
};
