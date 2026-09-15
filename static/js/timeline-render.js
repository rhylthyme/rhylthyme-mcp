/*!
 * Rhylthyme timeline-render v2.0.0-beta.4
 * (c) 2026 Rhylthyme contributors. Released under the Apache License 2.0.
 * Source: https://github.com/rhylthyme/rhylthyme-timeline
 *
 * Standalone Gantt-chart renderer for Rhylthyme program JSON. Zero
 * dependencies, ~8 KB unminified. UMD wrapper works in the browser
 * (window.Rhylthyme), Node.js (require), and ESM (import).
 *
 * Usage in an HTML artifact:
 *
 *   <script src="https://kitchen.rhylthyme.com/static/js/timeline-render.js"></script>
 *   <div id="timeline"></div>
 *   <script>
 *     Rhylthyme.renderTimeline(
 *       document.getElementById('timeline'),
 *       { name: 'Pancakes', tracks: [...] }
 *     );
 *   </script>
 *
 * API:
 *   Rhylthyme.renderTimeline(container, program)
 *       Inject SVG into a DOM element. Returns the SVG string.
 *
 *   Rhylthyme.renderTimelineSvg(program, opts?)
 *       Pure: returns the SVG string. No DOM, no side effects.
 *       opts: { arrows, marks, legend } (all default true) — cross-track
 *       dependency arrows (a fan-in over the instances of a replicated
 *       step is drawn as ONE arrowhead with a bar glyph: solid for an
 *       "all" barrier, dashed for "any"), indefinite/variable/manual step
 *       marks, legend.
 *       Planned-vs-actual: { baseline, deviationThreshold } or the
 *       shorthand { run } — see below.
 *
 *   Rhylthyme.computeStepTimings(program)
 *       Returns { stepId: { start, end, duration, trackId, resolved } }
 *       in seconds from program start. `resolved` is false when the
 *       step's trigger could not be satisfied (cycle / dangling ref).
 *
 *   Rhylthyme.actualFromRun(record, program?, opts?)
 *       { stepId: { start, end } } from a run record (rhylthyme-spec
 *       `runs` schema), keyed by expanded step id, ready to pass as
 *       computeStepTimings' `actual`. opts.endsOnly keeps only the ends,
 *       which is what a replay check feeds back into the resolver.
 *
 *   Rhylthyme.timingsFromRun(program, record, opts?)
 *       computeStepTimings(program, { actual: actualFromRun(record) }).
 *
 *   Rhylthyme.renderTimelineSvg(program, { run: record })
 *       Planned-vs-actual overlay: the actual bars with the plan drawn
 *       under each as a thin ghost bar (class "rt-baseline") and every
 *       bar tagged data-deviation="early|late|on-time".
 *
 *   Rhylthyme.expandReplicates(program)
 *       Expand track/step `replicates` (and legacy batch_size/stagger) into
 *       flat tracks; applied automatically by the functions above.
 *
 *   Rhylthyme.parseSeconds(value)
 *       Number | "90" | "5m" | "1h30m" | "-20m" -> seconds (number).
 *
 *   Rhylthyme.stepDurationSeconds(step)
 *       Planning duration for a step (fixed seconds, variable default,
 *       indefinite -> defaultSeconds or 0).
 *
 * Program JSON shape (subset — see rhylthyme-spec for the full schema):
 *   {
 *     name: "...",
 *     tracks: [{
 *       trackId: "...", name: "...",
 *       steps: [{
 *         stepId: "...", name: "...",
 *         duration: { type: "fixed", seconds: 300 }   // or "5m"; variable: { minSeconds, maxSeconds, defaultSeconds }
 *         startTrigger: { type: "programStart" | "programStartOffset" | "afterStep"
 *                               | "afterStepWithBuffer" | "manual" | "onAbort",
 *                          stepId: "...",       // for afterStep / afterStepWithBuffer / onAbort
 *                          event: "end"|"start",// afterStep anchor (default end)
 *                          offsetSeconds: 0,    // number or "5m"
 *                          bufferSeconds: 0 }   // afterStepWithBuffer
 *                       // or compound: { logic: "all"|"any", triggers: [ ...single triggers ] }
 *       }]
 *     }]
 *   }
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Rhylthyme = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Duration / offset parsing ----------------------------------
  //
  // Mirrors rhylthyme.validate_program.parse_duration_to_seconds: numbers
  // pass through, numeric strings parse, and unit strings like "1h30m",
  // "5m", "90s" sum their parts. A leading "-" negates (negative offsets
  // are legal on afterStep triggers).
  function parseSeconds(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;
    var s = value.trim();
    if (!s) return 0;
    var sign = 1;
    if (s.charAt(0) === '-') { sign = -1; s = s.slice(1); }
    else if (s.charAt(0) === '+') { s = s.slice(1); }
    if (/^\d+(\.\d+)?$/.test(s)) return sign * parseFloat(s);
    var total = 0, matched = false;
    var re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
    var m;
    while ((m = re.exec(s)) !== null) {
      matched = true;
      var n = parseFloat(m[1]);
      var u = m[2].toLowerCase().charAt(0);
      if (u === 'h') total += n * 3600;
      else if (u === 'm') total += n * 60;
      else total += n;
    }
    return matched ? sign * total : 0;
  }

  // Planning duration for a step. Fixed: seconds. Variable: default,
  // else max, else min. Indefinite: defaultSeconds if the author gave
  // one, otherwise a 60 s placeholder (matches the Python validator; the
  // live runner waits for the executor regardless).
  function stepDurationSeconds(step) {
    var d = (step && step.duration) || {};
    if (typeof d === 'string' || typeof d === 'number') return Math.max(0, parseSeconds(d));
    var v;
    if (d.type === 'indefinite' && (d.defaultSeconds === undefined || d.defaultSeconds === null)) return 60;
    if (d.seconds !== undefined && d.seconds !== null) v = parseSeconds(d.seconds);
    else if (d.defaultSeconds !== undefined && d.defaultSeconds !== null) v = parseSeconds(d.defaultSeconds);
    else if (d.maxSeconds !== undefined && d.maxSeconds !== null) v = parseSeconds(d.maxSeconds);
    else if (d.minSeconds !== undefined && d.minSeconds !== null) v = parseSeconds(d.minSeconds);
    else if (d.minutes !== undefined) v = parseSeconds(d.minutes) * 60;
    else if (d.hours !== undefined) v = parseSeconds(d.hours) * 3600;
    else v = 0;
    return Math.max(0, v || 0);
  }


  // ---------- Replicate expansion --------------------------------------
  //
  // Port of rhylthyme.expand_replicates (Python). Expands `replicates` on
  // tracks and steps, and legacy `batch_size`/`stagger` on tracks, into
  // flat tracks and steps BEFORE timing resolution, so this engine and the
  // Python validator see the same program. Pure: returns a deep copy.
  function _clone(x) { return JSON.parse(JSON.stringify(x)); }
  var _REF_TYPES = { afterStep: 1, afterStepWithBuffer: 1, onAbort: 1 };

  function _suffixTriggerRefs(trigger, suffix, originalIds) {
    if (!trigger) return;
    if (Array.isArray(trigger.triggers)) {
      trigger.triggers.forEach(function (sub) { _suffixTriggerRefs(sub, suffix, originalIds); });
    } else if (_REF_TYPES[trigger.type] && originalIds[trigger.stepId]) {
      trigger.stepId = trigger.stepId + suffix;
    }
  }

  function _remapTrigger(trigger, remap) {
    if (!trigger) return;
    if (Array.isArray(trigger.triggers)) {
      var out = [];
      trigger.triggers.forEach(function (sub) {
        var ref = sub && sub.stepId;
        if (sub && _REF_TYPES[sub.type] && Object.prototype.hasOwnProperty.call(remap, ref)) {
          var rep = remap[ref];
          if (rep && rep._join) rep.stepIds.forEach(function (sid) { out.push({ type: 'afterStep', stepId: sid }); });
          else { var c = _clone(sub); c.stepId = rep; out.push(c); }
        } else {
          var c2 = _clone(sub); _remapTrigger(c2, remap); out.push(c2);
        }
      });
      trigger.triggers = out;
      return;
    }
    if (_REF_TYPES[trigger.type] && Object.prototype.hasOwnProperty.call(remap, trigger.stepId)) {
      var r = remap[trigger.stepId];
      if (r && r._join) {
        var joins = r.stepIds.map(function (sid) { return { type: 'afterStep', stepId: sid }; });
        Object.keys(trigger).forEach(function (k) { delete trigger[k]; });
        trigger.logic = 'all'; trigger.triggers = joins;
      } else {
        trigger.stepId = r;
      }
    }
  }

  // ---- 0.3.0-alpha `instances` on step-referencing triggers ----------
  //
  // "each": the referencing step is replicated once per instance of the
  //         referenced step, paired i -> i (transitive through further
  //         "each" steps), placed in instance i's sub-track; offset/buffer/
  //         event preserved. Serial replicates get per-instance sub-tracks
  //         `<trackId>--<stepId>-r<i>` created on demand.
  // "all":  explicit barrier -> compound{all} over the instances (the same
  //         join a plain reference gets by default).
  // "any":  compound{any} over the instances.
  // Expanded copies carry instanceOf / instanceIndex; sub-tracks carry
  // parentTrackId. No `instances` key survives expansion.
  var _STEP_REF_TYPES = { afterStep: 1, afterStepWithBuffer: 1 };

  function _triggerAtoms(trigger) {
    if (!trigger || typeof trigger !== 'object') return [];
    if (Array.isArray(trigger.triggers)) return trigger.triggers.filter(function (t) { return t && typeof t === 'object'; });
    return [trigger];
  }
  function _hasInstances(trigger) {
    return _triggerAtoms(trigger).some(function (t) { return Object.prototype.hasOwnProperty.call(t, 'instances'); });
  }
  function _stripInstances(trigger) {
    _triggerAtoms(trigger).forEach(function (t) { delete t.instances; });
  }

  // Rewrite instances:"all"|"any" references into an explicit fan-in over
  // the group's instances. Single trigger -> compound; inside a compound of
  // the same logic -> flattened; different logic -> error (a nested
  // compound is not expressible in the 0.2.0 constructs we emit).
  function _rewriteBarrierTrigger(trigger, groups) {
    var isCompound = Array.isArray(trigger.triggers);
    var logic = trigger.logic;
    var atoms = isCompound ? trigger.triggers : [trigger];
    var out = [];
    for (var i = 0; i < atoms.length; i++) {
      var atom = atoms[i];
      if (!atom || typeof atom !== 'object') { out.push(atom); continue; }
      var inst = atom.instances;
      delete atom.instances;
      var group = null;
      if ((inst === 'all' || inst === 'any') && _STEP_REF_TYPES[atom.type] && Object.prototype.hasOwnProperty.call(groups, atom.stepId)) group = groups[atom.stepId];
      if (!group) { out.push(atom); continue; }
      var fan = group.instanceIds.map(function (iid) { var e = _clone(atom); e.stepId = iid; return e; });
      if (!isCompound) return { logic: inst, triggers: fan };
      if (inst === logic) fan.forEach(function (e) { out.push(e); });
      else throw new Error("instances: '" + inst + "' on '" + atom.stepId + "' inside a compound '" + logic + "' trigger is not supported (would require a nested compound)");
    }
    if (isCompound) { trigger.triggers = out; return trigger; }
    return out[0];
  }

  // Expand a step whose trigger references an instance group with
  // instances:"each": one copy per instance, paired i -> i, placed in
  // instance i's sub-track, registered as a group itself.
  function _expandEachStep(step, trackCopy, groups, remap, subTracksByParent, eachParents) {
    var stepId = step.stepId, stepName = step.name || stepId, trigger = step.startTrigger || {};
    var eachGroups = [], eachParentIds = [];
    _triggerAtoms(trigger).forEach(function (atom) {
      if (atom.instances !== 'each') return;
      var group = (_STEP_REF_TYPES[atom.type] && Object.prototype.hasOwnProperty.call(groups, atom.stepId)) ? groups[atom.stepId] : null;
      if (!group) { delete atom.instances; return; } // E_INSTANCES_ON_SINGLE: validator's job
      eachGroups.push(group); eachParentIds.push(atom.stepId);
    });
    if (!eachGroups.length) { step.startTrigger = _rewriteBarrierTrigger(trigger, groups); return; }
    var count = eachGroups[0].count;
    for (var g = 1; g < eachGroups.length; g++) {
      if (eachGroups[g].count !== count) {
        throw new Error("E_EACH_COUNT_MISMATCH: step '" + stepId + "' pairs instances of '" + eachGroups[0].root + "' (count " + count + ") with '" + eachGroups[g].root + "' (count " + eachGroups[g].count + ")");
      }
    }
    var place = eachGroups[0], parentTrack = place.parentTrack, parentId = parentTrack.trackId;
    trackCopy.steps = trackCopy.steps.filter(function (s) { return s !== step; });
    var instanceIds = [];
    for (var i = 0; i < count; i++) {
      var cs = _clone(step);
      cs.stepId = stepId + '-r' + (i + 1); cs.name = stepName + ' (' + (i + 1) + ' of ' + count + ')';
      cs.instanceOf = stepId; cs.instanceIndex = i + 1;
      var ct = cs.startTrigger || {};
      _triggerAtoms(ct).forEach(function (atom) {
        if (atom.instances === 'each' && Object.prototype.hasOwnProperty.call(groups, atom.stepId)) {
          atom.stepId = groups[atom.stepId].instanceIds[i];
          delete atom.instances;
        }
      });
      cs.startTrigger = _rewriteBarrierTrigger(ct, groups);
      var sub = place.subTracks[i];
      if (!sub) {
        sub = { trackId: parentId + '--' + place.root + '-r' + (i + 1), name: (parentTrack.name || parentId) + ' - ' + place.rootName + ' (' + (i + 1) + ' of ' + count + ')', parentTrackId: parentId, steps: [] };
        place.subTracks[i] = sub;
        (subTracksByParent[parentId] = subTracksByParent[parentId] || []).push(sub);
      }
      sub.steps.push(cs);
      instanceIds.push(cs.stepId);
    }
    groups[stepId] = { root: place.root, rootName: place.rootName, count: count, mode: place.mode, instanceIds: instanceIds, subTracks: place.subTracks, parentTrack: parentTrack };
    eachParents[stepId] = eachParentIds;
    remap[stepId] = { _join: true, stepIds: instanceIds };
  }

  // ---- 0.3.0-alpha `replicates.maxInFlight` --------------------------
  //
  // For a replicated step X with maxInFlight k and count n, instance i is
  // *in flight* from its own start until instance i has ended in every
  // instances:"each" descendant of X. Instance i + k may not start before
  // instance i leaves flight, so for every i > k one `afterStep L-r<i-k>`
  // per leaf chain is merged into X-r<i>'s trigger, L being the last
  // "each" descendant of that chain. X with no "each" descendants gates on
  // itself, turning a parallel fan-out into a rolling window of k.
  //
  // Each synthetic sub-trigger is tagged _synthetic:"inFlight" with
  // inFlightOf / inFlightLimit so the renderer and the analyzer can tell it
  // from an authored dependency; the timing resolver reads only
  // type/stepId/offsets, so the tag is inert there, and it keeps the
  // trigger from being re-expanded.
  function _mergeInFlight(own, synthetic) {
    // The step must satisfy its own trigger AND every gate, so the gates
    // join an `all` compound. An `any` compound is nested rather than
    // flattened, which would destroy its "first of these" meaning.
    if (Array.isArray(own.triggers) && (own.logic || 'all') === 'all') {
      own.triggers = own.triggers.concat(synthetic);
      return own;
    }
    return { logic: 'all', triggers: [own].concat(synthetic) };
  }

  function _applyInFlightGates(tracks, groups, eachParents, inFlight) {
    if (!inFlight.length) return;
    var byId = {};
    tracks.forEach(function (t) { (t.steps || []).forEach(function (s) { byId[s.stepId] = s; }); });
    inFlight.forEach(function (entry) {
      var root = entry[0], limit = entry[1], group = groups[root];
      if (!group) return;
      var count = group.count;
      // k >= count is E_INFLIGHT_GT_COUNT (or a no-op); the validators
      // report it and expansion stays a no-op rather than throwing.
      if (limit < 1 || limit >= count) return;
      var descendants = Object.keys(groups).filter(function (g) { return g !== root && groups[g].root === root; });
      var hasEachChild = {};
      descendants.forEach(function (child) {
        (eachParents[child] || []).forEach(function (parent) { hasEachChild[parent] = 1; });
      });
      var leaves = descendants.filter(function (d) { return !hasEachChild[d]; });
      if (!leaves.length) leaves = [root];
      for (var i = limit; i < count; i++) {
        var step = byId[group.instanceIds[i]];
        if (!step) continue;
        var synthetic = [];
        leaves.forEach(function (leaf) {
          var ids = groups[leaf].instanceIds;
          if (i - limit >= ids.length) return;
          synthetic.push({ type: 'afterStep', stepId: ids[i - limit], _synthetic: 'inFlight', inFlightOf: root, inFlightLimit: limit });
        });
        if (synthetic.length) step.startTrigger = _mergeInFlight(step.startTrigger || {}, synthetic);
      }
    });
  }

  function _needsExpansion(program) {
    return (program.tracks || []).some(function (t) {
      return t.replicates || t.batch_size > 1 || (t.steps || []).some(function (s) { return s && (s.replicates || _hasInstances(s.startTrigger)); });
    });
  }

  function expandReplicates(program) {
    if (!program || !_needsExpansion(program)) return program;
    program = _clone(program);
    // Phase 1: legacy batch_size / stagger -> replicates.
    (program.tracks || []).forEach(function (t) {
      if (t.replicates) return;
      var n = t.batch_size || 1;
      if (n <= 1) return;
      var stagger = parseSeconds(t.stagger !== undefined ? t.stagger : (t.stagger_seconds || 0));
      t.replicates = stagger > 0 ? { count: n, mode: 'stagger', delay: stagger } : { count: n, mode: 'parallel' };
      delete t.batch_size; delete t.stagger; delete t.stagger_seconds;
    });
    // Phase 2: track-level replicates.
    var tracks = [];
    (program.tracks || []).forEach(function (t) {
      var rep = t.replicates;
      if (!rep || (rep.count || 1) <= 1) { var tc = _clone(t); delete tc.replicates; tracks.push(tc); return; }
      var count = rep.count, mode = rep.mode || 'parallel', delay = parseSeconds(rep.delay || 0);
      var originalIds = {};
      (t.steps || []).forEach(function (s) { originalIds[s.stepId] = 1; });
      for (var i = 0; i < count; i++) {
        var suffix = '-r' + (i + 1);
        var rt = _clone(t); delete rt.replicates;
        rt.trackId = t.trackId + suffix;
        rt.name = t.name + ' (' + (i + 1) + ' of ' + count + ')';
        rt.steps = (t.steps || []).map(function (s) {
          var c = _clone(s); c.stepId = s.stepId + suffix; _suffixTriggerRefs(c.startTrigger, suffix, originalIds); return c;
        });
        if (mode === 'stagger' && i > 0 && delay > 0 && rt.steps.length) {
          var first = rt.steps[0], trig = first.startTrigger || {}, type = trig.type || 'programStart';
          if (type === 'programStart') first.startTrigger = { type: 'programStartOffset', offsetSeconds: delay * i };
          else if (type === 'programStartOffset') first.startTrigger = { type: 'programStartOffset', offsetSeconds: parseSeconds(trig.offsetSeconds || 0) + delay * i };
        } else if (mode === 'serial' && i > 0 && rt.steps.length) {
          rt.steps[0].startTrigger = { type: 'afterStep', stepId: t.steps[t.steps.length - 1].stepId + '-r' + i };
        }
        tracks.push(rt);
      }
    });
    program.tracks = tracks;
    // Phase 3: step-level replicates (+ 0.3.0 `instances` triggers).
    var newTracks = [], remap = {}, groups = {}, subTracksByParent = {}, deferred = [];
    var eachParents = {}, inFlight = [];
    program.tracks.forEach(function (t) {
      var tc = _clone(t), expanded = [];
      tc.steps = expanded;
      var subTracks = subTracksByParent[t.trackId] = subTracksByParent[t.trackId] || [];
      (t.steps || []).forEach(function (s) {
        var rep = s.replicates;
        if (!rep || (rep.count || 1) <= 1) {
          var sc = _clone(s); delete sc.replicates;
          // Leave `instances` triggers untouched until every group exists.
          if (_hasInstances(sc.startTrigger)) deferred.push({ track: tc, step: sc });
          else _remapTrigger(sc.startTrigger, remap);
          expanded.push(sc); return;
        }
        var count = rep.count, mode = rep.mode || 'parallel', delay = parseSeconds(rep.delay || 0);
        if (_hasInstances(s.startTrigger)) {
          _triggerAtoms(s.startTrigger).forEach(function (a) {
            if (a.instances === 'each') throw new Error("E_EACH_WITH_REPLICATES: step '" + s.stepId + "' has both `replicates` and an `instances: \"each\"` trigger");
          });
          s = _clone(s); s.startTrigger = _rewriteBarrierTrigger(s.startTrigger, groups);
        }
        var group = { root: s.stepId, rootName: s.name, count: count, mode: mode, instanceIds: [], subTracks: [], parentTrack: tc };
        for (var n = 0; n < count; n++) group.subTracks.push(null);
        if (mode === 'serial') {
          for (var j = 0; j < count; j++) {
            var cs = _clone(s); delete cs.replicates;
            cs.stepId = s.stepId + '-r' + (j + 1); cs.name = s.name + ' (' + (j + 1) + ' of ' + count + ')';
            cs.instanceOf = s.stepId; cs.instanceIndex = j + 1;
            if (j === 0) _remapTrigger(cs.startTrigger, remap);
            else cs.startTrigger = { type: 'afterStep', stepId: s.stepId + '-r' + j };
            expanded.push(cs);
            group.instanceIds.push(cs.stepId);
          }
          remap[s.stepId] = s.stepId + '-r' + count;
        } else {
          var lastIds = [];
          for (var k = 0; k < count; k++) {
            var cp = _clone(s); delete cp.replicates;
            cp.stepId = s.stepId + '-r' + (k + 1); cp.name = s.name + ' (' + (k + 1) + ' of ' + count + ')';
            cp.instanceOf = s.stepId; cp.instanceIndex = k + 1;
            _remapTrigger(cp.startTrigger, remap);
            if (mode === 'stagger' && k > 0 && delay > 0) {
              var tr = cp.startTrigger || {}; tr.offsetSeconds = parseSeconds(tr.offsetSeconds || 0) + delay * k; cp.startTrigger = tr;
            }
            var st = { trackId: t.trackId + '--' + s.stepId + '-r' + (k + 1), name: (t.name || t.trackId) + ' - ' + s.name + ' (' + (k + 1) + ' of ' + count + ')', parentTrackId: t.trackId, steps: [cp] };
            subTracks.push(st);
            group.subTracks[k] = st;
            lastIds.push(cp.stepId);
          }
          group.instanceIds = lastIds;
          remap[s.stepId] = { _join: true, stepIds: lastIds };
        }
        groups[s.stepId] = group;
        if (typeof rep.maxInFlight === 'number' && isFinite(rep.maxInFlight)) inFlight.push([s.stepId, rep.maxInFlight]);
      });
      newTracks.push(tc);
    });
    // Expand `instances` triggers now that every replicated step is a
    // group. A step chained "each" off another "each" step waits for that
    // step's own expansion, so iterate to a fixed point.
    var pendingEach = {};
    deferred.forEach(function (d) {
      if (_triggerAtoms(d.step.startTrigger).some(function (a) { return a.instances === 'each'; })) pendingEach[d.step.stepId] = 1;
    });
    while (deferred.length) {
      var remaining = [], progressed = false;
      deferred.forEach(function (d) {
        var waits = _triggerAtoms(d.step.startTrigger).some(function (a) { return a.instances === 'each' && pendingEach[a.stepId]; });
        if (waits) { remaining.push(d); return; }
        _expandEachStep(d.step, d.track, groups, remap, subTracksByParent, eachParents);
        delete pendingEach[d.step.stepId];
        progressed = true;
      });
      if (!progressed) throw new Error('cyclic instances: "each" references among steps: ' + remaining.map(function (d) { return d.step.stepId; }).sort().join(', '));
      deferred = remaining;
    }
    // Assemble: each top-level track followed by its sub-tracks, in
    // creation order; drop empty tracks.
    var ordered = [];
    newTracks.forEach(function (tc) {
      ordered.push(tc);
      (subTracksByParent[tc.trackId] || []).forEach(function (st) { ordered.push(st); });
    });
    ordered = ordered.filter(function (t) { return (t.steps || []).length > 0; });
    ordered.forEach(function (t) { t.steps.forEach(function (s) { _remapTrigger(s.startTrigger, remap); _stripInstances(s.startTrigger); }); });
    // `maxInFlight` gates last: they reference already-remapped instance
    // ids and must not be rewritten or stripped again.
    _applyInFlightGates(ordered, groups, eachParents, inFlight);
    program.tracks = ordered;
    return program;
  }

  // ---------- Step timing resolution -------------------------------------
  //
  // Walk the dependency graph and assign each step a start/end pair in
  // seconds from program start. Multi-pass to settle chains; bounded so a
  // malformed graph (cycle, dangling ref) can't loop forever. Semantics
  // follow rhylthyme.validate_program.calculate_step_start_time:
  //
  //   programStart              -> 0 (+ offsetSeconds if given)
  //   programStartOffset        -> offsetSeconds
  //   afterStep                 -> ref.end (or ref.start when event="start") + offsetSeconds
  //   afterStepWithBuffer       -> ref.end + bufferSeconds + offsetSeconds
  //   onAbort                   -> ref.end (placeholder: fires only on abort)
  //   manual / previousStepComplete -> end of the previous step in the same track
  //   { logic: "all"|"any", triggers: [...] } -> max / min of sub-trigger times
  //
  // A negative afterStep offset ("start 20m before the roast finishes")
  // is honored but never placed before the referenced step starts.
  //
  // opts (all optional; used by the player):
  //   actual: { [stepId]: { start?, end? } }  seconds the executor actually
  //           started / finished a step; overrides the plan for that step
  //           and everything downstream.
  //   now:    current program time in seconds. Steps that need the executor
  //           to start them (manual gates, negative-offset hand-offs) and
  //           have no actual start float forward to `now`; started steps
  //           that need the executor to finish them (indefinite, variable
  //           with a trigger) stretch to `now`.
  function stepNeedsStart(step) {
    return triggersOf(step).some(function (t) {
      if (!t) return false;
      if (t.type === 'manual') return true;
      return (t.type === 'afterStep' || t.type === 'afterStepWithBuffer') && parseSeconds(t.offsetSeconds) < 0;
    });
  }
  function stepNeedsFinish(step) {
    var d = (step && step.duration) || {};
    return d.type === 'indefinite' || (d.type === 'variable' && !!d.triggerName);
  }

  function computeStepTimings(program, opts) {
    opts = opts || {};
    var actual = opts.actual || {};
    var now = (typeof opts.now === 'number' && isFinite(opts.now)) ? opts.now : null;
    program = expandReplicates(program);
    var tracks = (program && program.tracks) || [];
    var allSteps = {};
    var trackOf = {};
    var prevInTrack = {};
    tracks.forEach(function (t) {
      var prev = null;
      (t.steps || []).forEach(function (s) {
        if (!s || !s.stepId) return;
        allSteps[s.stepId] = s;
        trackOf[s.stepId] = t.trackId;
        prevInTrack[s.stepId] = prev;
        prev = s.stepId;
      });
    });

    var out = {};

    // Resolve one single (non-compound) trigger to a start time, or null
    // if its dependency has not been placed yet.
    function resolveSingle(sid, trig) {
      var type = trig.type || 'programStart';
      var ref, off;
      switch (type) {
        case 'programStart':
          return Math.max(0, parseSeconds(trig.offsetSeconds));
        case 'programStartOffset':
          return Math.max(0, parseSeconds(trig.offsetSeconds));
        case 'afterStep':
        case 'afterStepWithBuffer':
        case 'onAbort':
          if (!trig.stepId) return 0;
          ref = out[trig.stepId];
          if (!ref) return null;
          off = parseSeconds(trig.offsetSeconds);
          if (type === 'afterStepWithBuffer') off += parseSeconds(trig.bufferSeconds);
          if (off < 0) return Math.max(ref.start, ref.end + off);
          var base = (trig.event === 'start') ? ref.start : ref.end;
          return Math.max(0, base + off);
        case 'manual':
        case 'previousStepComplete':
          var p = prevInTrack[sid];
          if (!p) return Math.max(0, parseSeconds(trig.offsetSeconds));
          if (!out[p]) return null;
          return Math.max(0, out[p].end + parseSeconds(trig.offsetSeconds));
        default:
          return 0;
      }
    }

    function resolve(sid, trig) {
      trig = trig || {};
      if (trig.logic && Array.isArray(trig.triggers)) {
        var times = [];
        for (var i = 0; i < trig.triggers.length; i++) {
          var t = resolve(sid, trig.triggers[i]);
          if (t === null) return null;
          times.push(t);
        }
        if (!times.length) return 0;
        return trig.logic === 'any'
          ? Math.min.apply(null, times)
          : Math.max.apply(null, times);
      }
      return resolveSingle(sid, trig);
    }

    var ids = Object.keys(allSteps);
    var progressed = true, passes = 0;
    var maxPasses = Math.max(20, ids.length + 2);
    while (progressed && passes < maxPasses) {
      progressed = false;
      passes++;
      for (var k = 0; k < ids.length; k++) {
        var sid = ids[k];
        if (out[sid] !== undefined) continue;
        var start = resolve(sid, allSteps[sid].startTrigger);
        if (start !== null && isFinite(start)) {
          var step = allSteps[sid];
          var a = actual[sid] || {};
          var dur = stepDurationSeconds(step);
          var started = typeof a.start === 'number';
          if (started) start = a.start;
          else if (now !== null && start < now && stepNeedsStart(step)) start = now;
          var end;
          if (typeof a.end === 'number') end = a.end;
          else {
            end = start + dur;
            if (now !== null && started && end < now && stepNeedsFinish(step)) {
              end = now;
              var dd = step.duration || {};
              if (dd.type === 'variable' && dd.maxSeconds !== undefined) end = Math.min(end, start + parseSeconds(dd.maxSeconds));
            }
          }
          out[sid] = { start: start, end: end, duration: end - start, trackId: trackOf[sid], resolved: true };
          progressed = true;
        }
      }
    }
    // Fallback for any unresolved steps (cycles, missing refs).
    for (var k2 = 0; k2 < ids.length; k2++) {
      var sid2 = ids[k2];
      if (!out[sid2]) {
        var dur2 = stepDurationSeconds(allSteps[sid2]);
        out[sid2] = { start: 0, end: dur2, duration: dur2, trackId: trackOf[sid2], resolved: false };
      }
    }
    return out;
  }

  // ---------- Run records (planned vs actual) ----------------------------
  //
  // A run record (rhylthyme-spec `runs` schema, 0.1.0-alpha) holds, per
  // step, the `planned` interval frozen at run start beside the `actual`
  // interval that happened, both in seconds from `startedAt` — the same
  // units computeStepTimings works in, so a record drops straight into
  // `opts.actual`.
  //
  // Records key steps by the AUTHORED stepId plus a 1-based `instance`;
  // the id the runtime used (and the id the expander produces) is
  // `<stepId>-r<instance>` for a replicated step and plain `<stepId>`
  // otherwise. Pass the program and the mapping is confirmed against its
  // expanded step ids; without it, `instance > 1` implies the suffix.
  // Python twin: rhylthyme_cli_runner.history.recorder.runtime_step_id.

  function _isRunRecord(x) {
    return !!x && typeof x === 'object' && !x.tracks && Array.isArray(x.steps);
  }

  function _expandedStepIds(program) {
    if (!program || !program.tracks) return null;
    var ids = {};
    (expandReplicates(program).tracks || []).forEach(function (t) {
      (t.steps || []).forEach(function (s) { if (s && s.stepId) ids[s.stepId] = 1; });
    });
    return ids;
  }

  function runtimeStepId(entry, ids) {
    var base = entry && entry.stepId, inst = (entry && entry.instance) || 1;
    var suffixed = base + '-r' + inst;
    if (ids) {
      if (ids[suffixed]) return suffixed;
      if (ids[base]) return base;
    }
    return inst > 1 ? suffixed : base;
  }

  // opts.endsOnly — omit `start`, so the resolver has to derive every start
  //                 from the triggers and the observed ends (replay check).
  function actualFromRun(record, program, opts) {
    if (!_isRunRecord(record) && _isRunRecord(program)) {
      var swap = record; record = program; program = swap;
    }
    opts = opts || {};
    var ids = _expandedStepIds(program);
    var out = {};
    if (!_isRunRecord(record)) return out;
    record.steps.forEach(function (entry) {
      if (!entry || !entry.stepId || !entry.actual) return;
      var a = {};
      if (!opts.endsOnly && typeof entry.actual.start === 'number') a.start = entry.actual.start;
      if (typeof entry.actual.end === 'number') a.end = entry.actual.end;
      if (a.start !== undefined || a.end !== undefined) out[runtimeStepId(entry, ids)] = a;
    });
    return out;
  }

  function timingsFromRun(program, record, opts) {
    if (_isRunRecord(program)) { var swap = program; program = record; record = swap; }
    opts = opts || {};
    var resolverOpts = { actual: actualFromRun(record, program, opts) };
    if (typeof opts.now === 'number' && isFinite(opts.now)) resolverOpts.now = opts.now;
    return computeStepTimings(program, resolverOpts);
  }

  // ---------- SVG rendering ----------------------------------------------

  var PALETTE = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtMin(s) {
    var m = Math.round((s || 0) / 60);
    if (!isFinite(m) || m < 0) m = 0;
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60), r = m % 60;
    return r === 0 ? h + 'h' : h + 'h' + r;
  }

  // Collect every single trigger of a step (compound triggers flattened).
  function triggersOf(step) {
    var t = (step && step.startTrigger) || {};
    if (t.logic && Array.isArray(t.triggers)) return t.triggers.filter(function (x) { return x; });
    return [t];
  }

  // opts: { arrows: true, marks: true, legend: true }
  //   arrows  — draw cross-track afterStep dependencies as elbow arrows
  //             (dashed when the offset is negative)
  //   marks   — hatch indefinite steps, fade variable steps from their
  //             default to their maximum, flag manual gates
  //   legend  — one-line key under the chart
  // Player options:
  //   timings — precomputed result of computeStepTimings (e.g. with actual
  //             times); default: computed here
  //   now     — current program time in seconds: draws a cursor line and
  //             extends the axis to cover it
  //   states  — { [stepId]: 'done' | 'active' | 'waiting' } for bar styling
  //   width   — SVG width in px (default 820); the chart also scales with
  //             CSS since it carries a viewBox
  // Planned-vs-actual options:
  //   baseline — a second timings map (normally computeStepTimings(program)
  //             with no actuals). Every step it covers gets a thin ghost bar
  //             (class "rt-baseline") under its bar at the planned position,
  //             and the bar itself is outlined by the SIGN of its end
  //             deviation (actual end - planned end) and tagged
  //             data-deviation="early" | "late" | "on-time". Rows grow to
  //             make room and the legend gains the four keys.
  //   deviationThreshold — seconds of end deviation inside which a step
  //             counts as on time (default 30)
  //   run     — a run record (rhylthyme-spec `runs` schema): shorthand for
  //             timings = timingsFromRun(program, run) and
  //             baseline = computeStepTimings(program). Either explicit
  //             option still wins.
  // Without `baseline`/`run` the output is unchanged, byte for byte.
  function renderTimelineSvg(program, opts) {
    program = expandReplicates(program || {});
    opts = opts || {};
    var arrows = opts.arrows !== false, marks = opts.marks !== false, legend = opts.legend !== false;
    var now = (typeof opts.now === 'number' && isFinite(opts.now)) ? opts.now : null;
    var states = opts.states || {};
    var tracks = (program.tracks || []).filter(function (t) {
      return (t.steps || []).length > 0;
    });
    if (!tracks.length) return '';

    var timings = opts.timings || null;
    var baseline = opts.baseline || null;
    if (opts.run) {
      if (!timings) timings = timingsFromRun(program, opts.run);
      if (!baseline) baseline = computeStepTimings(program);
    }
    if (!timings) timings = computeStepTimings(program);
    var devThreshold = (typeof opts.deviationThreshold === 'number' && isFinite(opts.deviationThreshold) && opts.deviationThreshold >= 0)
      ? opts.deviationThreshold : 30;
    var stepIndex = {}, trackOfStep = {}, rowOfTrack = {};
    tracks.forEach(function (t, ti) {
      rowOfTrack[t.trackId] = ti;
      (t.steps || []).forEach(function (s) { if (s && s.stepId) { stepIndex[s.stepId] = s; trackOfStep[s.stepId] = t.trackId; } });
    });
    var globalEnd = 0;
    for (var sid in timings) {
      var st = stepIndex[sid], d = st && st.duration;
      var maxEnd = timings[sid].end;
      if (marks && d && d.type === 'variable' && d.maxSeconds !== undefined) maxEnd = Math.max(maxEnd, timings[sid].start + parseSeconds(d.maxSeconds));
      if (baseline && baseline[sid]) maxEnd = Math.max(maxEnd, baseline[sid].end);
      globalEnd = Math.max(globalEnd, maxEnd);
    }
    if (now !== null) globalEnd = Math.max(globalEnd, now);
    if (globalEnd <= 0) globalEnd = 1;

    var W = (typeof opts.width === 'number' && opts.width > 300) ? opts.width : 820;
    var H_HEADER = 56;
    // A baseline overlay needs a second, thinner bar per row: the row grows
    // and the main bar shrinks so both fit. Without it every dimension is
    // exactly what it has always been (barMid stays rowY + H_TRACK / 2).
    var H_TRACK = baseline ? 58 : 46;
    var BAR_H = baseline ? 26 : H_TRACK - 14;
    var GHOST_H = 9;
    var H_FOOTER = legend ? (baseline ? 78 : 62) : 28;
    var PAD_LEFT = 150;
    var PAD_RIGHT = 18;
    var BAR_W = W - PAD_LEFT - PAD_RIGHT;
    var H = H_HEADER + tracks.length * H_TRACK + H_FOOTER;

    function xOf(t) { return PAD_LEFT + (t / globalEnd) * BAR_W; }
    function rowY(ti) { return H_HEADER + ti * H_TRACK; }
    function barTop(ti) { return rowY(ti) + 7; }
    function barMid(ti) { return barTop(ti) + BAR_H / 2; }
    function ghostTop(ti) { return barTop(ti) + BAR_H + 4; }

    // Sign of a step's end deviation against the baseline, with a dead band
    // (deviationThreshold) around zero so a few seconds of tick lag does not
    // read as a schedule slip.
    var DEV_STROKE = { late: '#dc2626', early: '#2563eb', 'on-time': '#16a34a' };
    function deviationOf(sid) {
      if (!baseline) return null;
      var plan = baseline[sid], real = timings[sid];
      if (!plan || !real || typeof plan.end !== 'number' || typeof real.end !== 'number') return null;
      var delta = real.end - plan.end;
      return {
        seconds: delta,
        sign: delta > devThreshold ? 'late' : (delta < -devThreshold ? 'early' : 'on-time'),
      };
    }

    var parts = [];
    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H
      + '" viewBox="0 0 ' + W + ' ' + H + '" class="rt-timeline" '
      + 'font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif">'
    );
    parts.push('<defs>'
      + '<marker id="rt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">'
      + '<path d="M0,0 L10,5 L0,10 z" fill="#6b7280"/></marker>'
      + '<filter id="rt-shadow" x="-5%" y="-20%" width="110%" height="150%">'
      + '<feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.18"/></filter>'
      + '<pattern id="rt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
      + '<rect width="6" height="6" fill="#ffffff" fill-opacity="0"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2"/></pattern>'
      + '</defs>');
    parts.push('<rect width="' + W + '" height="' + H + '" fill="#fafafa"/>');

    // Title + subtitle
    var title = program.name || 'Timeline';
    parts.push(
      '<text x="' + PAD_LEFT + '" y="22" font-size="14" font-weight="600" '
      + 'fill="#111827">'
      + esc(title.length > 60 ? title.slice(0, 57) + '…' : title)
      + '</text>'
    );
    parts.push(
      '<text x="' + (W - PAD_RIGHT) + '" y="22" font-size="11" fill="#6b7280" text-anchor="end">'
      + tracks.length + ' tracks · ' + fmtMin(globalEnd) + ' total</text>'
    );

    // Time axis line + tick labels
    var axisY = H_HEADER - 4;
    parts.push(
      '<line x1="' + PAD_LEFT + '" y1="' + axisY + '" x2="' + (PAD_LEFT + BAR_W)
      + '" y2="' + axisY + '" stroke="#d1d5db" stroke-width="1"/>'
    );
    var tickInterval;
    if (globalEnd <= 30 * 60) tickInterval = 5 * 60;
    else if (globalEnd <= 90 * 60) tickInterval = 15 * 60;
    else if (globalEnd <= 180 * 60) tickInterval = 30 * 60;
    else tickInterval = 60 * 60;
    var rowsBottom = H_HEADER + tracks.length * H_TRACK;
    for (var t = 0; t <= globalEnd; t += tickInterval) {
      var x = xOf(t);
      parts.push(
        '<line x1="' + x.toFixed(1) + '" y1="' + (axisY - 4) + '" x2="' + x.toFixed(1)
        + '" y2="' + axisY + '" stroke="#9ca3af" stroke-width="1"/>'
      );
      if (t > 0) {
        parts.push('<line x1="' + x.toFixed(1) + '" y1="' + (axisY + 1) + '" x2="' + x.toFixed(1)
          + '" y2="' + rowsBottom + '" stroke="#e5e7eb" stroke-width="1"/>');
      }
      parts.push(
        '<text x="' + x.toFixed(1) + '" y="' + (axisY - 8) + '" font-size="10" '
        + 'fill="#6b7280" text-anchor="middle">' + fmtMin(t) + '</text>'
      );
    }

    // Tracks + step bars
    tracks.forEach(function (track, ti) {
      var y = rowY(ti);
      var color = PALETTE[ti % PALETTE.length];
      var trackName = track.name || 'Track';
      var trackLabel = trackName.length > 18 ? trackName.slice(0, 16) + '…' : trackName;
      parts.push(
        '<text x="' + (PAD_LEFT - 8) + '" y="' + (barMid(ti) + 4)
        + '" font-size="12" font-weight="600" fill="#374151" text-anchor="end">' + esc(trackLabel) + '</text>'
      );
      parts.push(
        '<rect x="' + PAD_LEFT + '" y="' + (y + 4) + '" width="' + BAR_W
        + '" height="' + (H_TRACK - 8) + '" fill="#ffffff" fill-opacity="0.6" stroke="#e5e7eb"/>'
      );
      (track.steps || []).forEach(function (step, si) {
        var tim = timings[step.stepId];
        if (!tim || tim.duration <= 0) return;
        var d = step.duration || {};
        var x1 = xOf(tim.start);
        var x2 = xOf(tim.end);
        var w = Math.max(2, x2 - x1);
        var opacity = si % 2 === 0 ? 1 : 0.78;
        var state = states[step.stepId] || '';
        if (state === 'done') opacity = 0.35;
        var isIndef = marks && d.type === 'indefinite';
        var isVar = marks && d.type === 'variable' && d.maxSeconds !== undefined;
        var isManual = marks && triggersOf(step).some(function (x) { return x && x.type === 'manual'; });
        // Variable: faded extension from default end to max end.
        if (isVar) {
          var xMax = xOf(tim.start + parseSeconds(d.maxSeconds));
          if (xMax > x2 + 1) {
            parts.push('<rect x="' + x2.toFixed(1) + '" y="' + barTop(ti) + '" width="' + (xMax - x2).toFixed(1)
              + '" height="' + BAR_H + '" fill="' + color + '" opacity="0.3" rx="5" ry="5"/>');
          }
        }
        // The plan, as a thin ghost bar under the bar that actually happened.
        var plan = baseline ? baseline[step.stepId] : null;
        if (plan) {
          var gx1 = xOf(plan.start), gx2 = xOf(plan.end);
          parts.push(
            '<rect class="rt-baseline" data-step="' + esc(step.stepId) + '" x="' + gx1.toFixed(1)
            + '" y="' + ghostTop(ti) + '" width="' + Math.max(2, gx2 - gx1).toFixed(1)
            + '" height="' + GHOST_H + '" fill="' + color
            + '" opacity="0.35" stroke="#9ca3af" stroke-width="1" stroke-dasharray="3,2" rx="3" ry="3"/>'
          );
        }
        var dev = deviationOf(step.stepId);
        var stroke = ' stroke="#ffffff" stroke-width="1.5"';
        if (state === 'active') stroke = ' stroke="#111827" stroke-width="2.5"';
        else if (state === 'waiting') stroke = ' stroke="#b91c1c" stroke-width="2" stroke-dasharray="3,3"';
        else if (dev) stroke = ' stroke="' + DEV_STROKE[dev.sign] + '" stroke-width="2"';
        else if (isIndef) stroke = ' stroke="#111827" stroke-width="1.5" stroke-dasharray="5,3"';
        parts.push(
          '<rect class="rt-bar' + (state ? ' rt-' + state : '') + '" data-step="' + esc(step.stepId) + '"'
          + (dev ? ' data-deviation="' + dev.sign + '" data-deviation-seconds="' + Math.round(dev.seconds) + '"' : '')
          + ' x="' + x1.toFixed(1) + '" y="' + barTop(ti) + '" width="' + w.toFixed(1)
          + '" height="' + BAR_H + '" fill="' + color + '" opacity="' + opacity
          + '" rx="5" ry="5" filter="url(#rt-shadow)"' + stroke + '/>'
        );
        if (isIndef) {
          parts.push('<rect x="' + x1.toFixed(1) + '" y="' + barTop(ti) + '" width="' + w.toFixed(1)
            + '" height="' + BAR_H + '" fill="url(#rt-hatch)" rx="5" ry="5"/>');
        }
        if (isManual) {
          // Hand-off flag: a small white triangle at the left edge.
          var fx = x1 + 3, fy = barTop(ti) + 4;
          parts.push('<path d="M' + fx.toFixed(1) + ',' + fy.toFixed(1) + ' l9,' + ((BAR_H - 8) / 2).toFixed(1)
            + ' l-9,' + ((BAR_H - 8) / 2).toFixed(1) + ' z" fill="#ffffff" stroke="#111827" stroke-width="1"/>');
        }
        if (w > 38) {
          var text = step.name || step.stepId || '';
          var avail = w - 10 - (isManual ? 12 : 0);
          var maxChars = Math.max(3, Math.floor(avail / 6.6));
          var display = text.length > maxChars
            ? text.slice(0, Math.max(2, maxChars - 1)) + '…'
            : text;
          parts.push(
            '<text x="' + (x1 + w / 2 + (isManual ? 6 : 0)).toFixed(1) + '" y="' + (barMid(ti) + 4)
            + '" font-size="11" fill="#ffffff" text-anchor="middle" '
            + 'font-weight="600">' + esc(display) + '</text>'
          );
        }
      });
    });

    // A barrier (schema 0.3.0 instances:"all" / "any", or the implicit
    // join the expander emits for a plain reference to a replicated step)
    // is a compound trigger whose step references all point at instances
    // of ONE authored step (same `instanceOf`, at least two of them).
    // Returns 'all' | 'any' | null.
    function barrierOf(step) {
      var t = (step && step.startTrigger) || {};
      if (!t.logic || !Array.isArray(t.triggers)) return null;
      // A maxInFlight gate is not part of the barrier it sits beside.
      var real = t.triggers.filter(function (tr) { return !(tr && tr._synthetic); });
      if (real.length < 2) return null;
      var group = null;
      for (var i = 0; i < real.length; i++) {
        var tr = real[i];
        if (!tr || !tr.stepId || (tr.type !== 'afterStep' && tr.type !== 'afterStepWithBuffer')) return null;
        var ref = stepIndex[tr.stepId];
        if (!ref || !ref.instanceOf) return null;
        if (group === null) group = ref.instanceOf;
        else if (group !== ref.instanceOf) return null;
      }
      return t.logic === 'any' ? 'any' : 'all';
    }
    var BARRIER_GAP = 18;   // lines converge this far left of the target bar
    var BARRIER_BAR_X = 11; // the bar glyph sits this far left of the target bar

    // Cross-track dependency arrows (plus maxInFlight gates, which are
    // drawn wherever they land), above the bars.
    if (arrows) {
      var arrowCount = 0, barrierCount = 0, inflightCount = 0;
      tracks.forEach(function (track, ti) {
        (track.steps || []).forEach(function (step) {
          var tim = timings[step.stepId];
          if (!tim) return;
          var barrier = barrierOf(step);
          var converging = 0;
          triggersOf(step).forEach(function (tr) {
            if (!tr || !tr.stepId) return;
            if (tr.type !== 'afterStep' && tr.type !== 'afterStepWithBuffer') return;
            var refTrack = trackOfStep[tr.stepId];
            if (refTrack === undefined) return;
            var ref = timings[tr.stepId];
            if (!ref) return;
            // A maxInFlight gate (expander-synthesised, tagged
            // _synthetic:"inFlight") is a capacity hold, not an authored
            // dependency: draw it dotted and labelled with the limit, from
            // the leaf instance that frees the slot to the instance it
            // holds back, whether or not the two share a track.
            if (tr._synthetic === 'inFlight') {
              var leaf = stepIndex[tr.stepId] || {};
              var limitLabel = (leaf.task || leaf.instanceOf || tr.stepId) + ' \u2264 ' + tr.inFlightLimit;
              var ix1 = xOf(ref.end), ix2 = xOf(tim.start);
              var iy1 = barMid(rowOfTrack[refTrack]), iy2 = barMid(ti);
              var ireach = Math.max(24, Math.min(110, Math.abs(ix2 - ix1) * 0.6));
              var ipath = 'M' + ix1.toFixed(1) + ',' + iy1.toFixed(1)
                + ' C' + (ix1 + ireach).toFixed(1) + ',' + iy1.toFixed(1)
                + ' ' + (ix2 - 3 - ireach).toFixed(1) + ',' + iy2.toFixed(1)
                + ' ' + (ix2 - 3).toFixed(1) + ',' + iy2.toFixed(1);
              inflightCount++;
              parts.push('<g class="rt-inflight" data-inflight-of="' + esc(tr.inFlightOf)
                + '" data-limit="' + esc(tr.inFlightLimit) + '" data-from="' + esc(tr.stepId)
                + '" data-step="' + esc(step.stepId) + '">'
                + '<path class="rt-inflight-edge" d="' + ipath + '" fill="none" stroke="#6b7280" stroke-width="1.5"'
                + ' stroke-linecap="round" stroke-dasharray="1.5,3" marker-end="url(#rt-arrow)"/>'
                + '<text x="' + ((ix1 + ix2) / 2).toFixed(1) + '" y="' + (Math.min(iy1, iy2) - 6).toFixed(1)
                + '" font-size="9" fill="#6b7280" text-anchor="middle">' + esc(limitLabel) + '</text>'
                + '</g>');
              return;
            }
            if (refTrack === track.trackId) return;
            var fromT = (tr.event === 'start') ? ref.start : ref.end;
            var neg = parseSeconds(tr.offsetSeconds) < 0;
            var xFrom = xOf(fromT), xTo = xOf(tim.start);
            var yFrom = barMid(rowOfTrack[refTrack]), yTo = barMid(ti);
            // Leave the referenced bar at its anchor edge, arrive at the left
            // edge of the dependent bar, as a smooth S-curve (cubic Bezier)
            // in the style of the web player. The horizontal reach of the
            // control points grows with the distance so short hops stay
            // tight and long ones sweep. Fan-in lines of a barrier stop at
            // a common point left of the bar; one arrowhead + bar glyph is
            // drawn there afterwards instead of N arrowheads.
            var dx = xTo - xFrom;
            var xEnd = barrier ? xTo - BARRIER_GAP : xTo - 3;
            var path;
            if (dx >= 40) {
              // Forward hop: leave to the right, arrive from the left.
              var reach = Math.max(28, Math.min(120, dx * 0.6));
              path = 'M' + xFrom.toFixed(1) + ',' + yFrom.toFixed(1)
                + ' C' + (xFrom + reach).toFixed(1) + ',' + yFrom.toFixed(1)
                + ' ' + (xEnd - reach).toFixed(1) + ',' + yTo.toFixed(1)
                + ' ' + xEnd.toFixed(1) + ',' + yTo.toFixed(1);
            } else {
              // Near-vertical or backward hop (a negative offset): leave the
              // bar's bottom or top edge and drop into the target's edge
              // (or into the barrier's convergence point).
              var dir = yTo > yFrom ? 1 : -1;
              var y0 = yFrom + dir * (BAR_H / 2 + 1), y1 = barrier ? yTo : yTo - dir * (BAR_H / 2 + 1);
              var xArr = barrier ? xEnd : xTo;
              var reachY = Math.max(12, Math.abs(y1 - y0) * 0.5);
              path = 'M' + xFrom.toFixed(1) + ',' + y0.toFixed(1)
                + ' C' + xFrom.toFixed(1) + ',' + (y0 + dir * reachY).toFixed(1)
                + ' ' + xArr.toFixed(1) + ',' + (y1 - dir * reachY).toFixed(1)
                + ' ' + xArr.toFixed(1) + ',' + y1.toFixed(1);
            }
            arrowCount++;
            converging++;
            parts.push('<path class="rt-edge' + (barrier ? ' rt-fanin' : '') + '" d="' + path + '" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-linecap="round"'
              + (neg ? ' stroke-dasharray="5,4"' : '') + (barrier ? '' : ' marker-end="url(#rt-arrow)"') + '/>');
          });
          if (barrier && converging > 0) {
            // McKeever-style barrier: a short bar across the single fan-in
            // arrow — solid for "all" (every instance), dashed for "any".
            var bx = xOf(tim.start), by = barMid(ti);
            var xc = bx - BARRIER_GAP, xb = bx - BARRIER_BAR_X;
            barrierCount++;
            parts.push('<g class="rt-barrier" data-barrier="' + barrier + '" data-step="' + esc(step.stepId) + '">'
              + '<path d="M' + xc.toFixed(1) + ',' + by.toFixed(1) + ' L' + (bx - 3).toFixed(1) + ',' + by.toFixed(1)
              + '" fill="none" stroke="#6b7280" stroke-width="1.5" marker-end="url(#rt-arrow)"/>'
              + '<line x1="' + xb.toFixed(1) + '" y1="' + (by - 9).toFixed(1) + '" x2="' + xb.toFixed(1) + '" y2="' + (by + 9).toFixed(1)
              + '" stroke="#374151" stroke-width="2.5" stroke-linecap="round"' + (barrier === 'any' ? ' stroke-dasharray="3,2.5"' : '') + '/>'
              + '</g>');
          }
        });
      });
    }

    // Current-time cursor (player).
    if (now !== null) {
      var cx = xOf(now);
      var topY = H_HEADER - 4, botY = H_HEADER + tracks.length * H_TRACK;
      parts.push('<line class="rt-cursor" x1="' + cx.toFixed(1) + '" y1="' + topY + '" x2="' + cx.toFixed(1) + '" y2="' + botY
        + '" stroke="#dc2626" stroke-width="2"/>');
      parts.push('<path d="M' + (cx - 6).toFixed(1) + ',' + (topY - 8) + ' h12 l-6,8 z" fill="#dc2626"/>');
    }

    if (legend) {
      var ly = H - (baseline ? 46 : 30);
      var lx = 16;
      function key(x, drawer, label) {
        // Baseline mode adds four keys, enough to overflow one line: wrap.
        if (baseline && x > 16 && x + 20 + label.length * 5.2 > W - PAD_RIGHT) { ly += 16; x = 16; }
        parts.push(drawer(x, ly));
        parts.push('<text x="' + (x + 20) + '" y="' + (ly + 4) + '" font-size="10" fill="#4b5563">' + esc(label) + '</text>');
        return x + 20 + label.length * 5.2 + 16;
      }
      lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + (y + 4) + ' C' + (x + 8) + ',' + (y + 4) + ' ' + (x + 6) + ',' + (y - 4) + ' ' + (x + 14) + ',' + (y - 4) + '" fill="none" stroke="#6b7280" stroke-width="1.5" marker-end="url(#rt-arrow)"/>'; }, 'dependency');
      lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + (y + 4) + ' C' + (x + 8) + ',' + (y + 4) + ' ' + (x + 6) + ',' + (y - 4) + ' ' + (x + 14) + ',' + (y - 4) + '" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#rt-arrow)"/>'; }, 'negative offset');
      lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="14" height="12" fill="#9ca3af" stroke="#111827" stroke-width="1.2" stroke-dasharray="4,2" rx="2"/>'; }, 'indefinite');
      lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="7" height="12" fill="#9ca3af" rx="2"/><rect x="' + (x + 7) + '" y="' + (y - 6) + '" width="7" height="12" fill="#9ca3af" opacity="0.3" rx="2"/>'; }, 'variable');
      lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + (y - 6) + ' l9,6 l-9,6 z" fill="#ffffff" stroke="#111827" stroke-width="1"/>'; }, 'manual');
      if (arrows && barrierCount > 0) {
        lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + (y - 5) + ' L' + (x + 7) + ',' + y + ' M' + x + ',' + (y + 5) + ' L' + (x + 7) + ',' + y + ' M' + (x + 7) + ',' + y + ' L' + (x + 14) + ',' + y + '" fill="none" stroke="#6b7280" stroke-width="1.5" marker-end="url(#rt-arrow)"/><line x1="' + (x + 9) + '" y1="' + (y - 6) + '" x2="' + (x + 9) + '" y2="' + (y + 6) + '" stroke="#374151" stroke-width="2.5"/>'; }, 'barrier (all instances)');
      }
      if (arrows && inflightCount > 0) {
        lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + (y + 4) + ' C' + (x + 8) + ',' + (y + 4) + ' ' + (x + 6) + ',' + (y - 4) + ' ' + (x + 14) + ',' + (y - 4) + '" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="1.5,3" marker-end="url(#rt-arrow)"/>'; }, 'in-flight limit');
      }
      if (baseline) {
        lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 3) + '" width="14" height="7" fill="#9ca3af" opacity="0.35" stroke="#9ca3af" stroke-width="1" stroke-dasharray="3,2" rx="2"/>'; }, 'planned');
        lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="14" height="12" fill="#9ca3af" stroke="' + DEV_STROKE.late + '" stroke-width="2" rx="2"/>'; }, 'late (>' + Math.round(devThreshold) + 's)');
        lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="14" height="12" fill="#9ca3af" stroke="' + DEV_STROKE.early + '" stroke-width="2" rx="2"/>'; }, 'early');
        lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="14" height="12" fill="#9ca3af" stroke="' + DEV_STROKE['on-time'] + '" stroke-width="2" rx="2"/>'; }, 'on time');
      }
    }

    // Footer brand mark
    parts.push(
      '<text x="' + (W - PAD_RIGHT) + '" y="' + (H - 10) + '" font-size="10" '
      + 'fill="#9ca3af" text-anchor="end">rhylthyme.com timeline preview</text>'
    );
    parts.push('</svg>');
    return parts.join('');
  }

  // ---------- DOM convenience --------------------------------------------

  function renderTimeline(container, program, opts) {
    var svg = renderTimelineSvg(program, opts);
    if (container && typeof container.innerHTML === 'string') {
      container.innerHTML = svg;
    }
    return svg;
  }

  return {
    version: '2.0.0-beta.4',
    // Program schema versions this engine understands; bumped in step
    // with the package's minor version when new trigger/duration forms
    // are added.
    supportedSchemaVersions: ['0.1.0', '0.2.0-alpha', '0.3.0-alpha'],
    renderTimeline: renderTimeline,
    renderTimelineSvg: renderTimelineSvg,
    computeStepTimings: computeStepTimings,
    actualFromRun: actualFromRun,
    timingsFromRun: timingsFromRun,
    runtimeStepId: runtimeStepId,
    stepNeedsStart: stepNeedsStart,
    stepNeedsFinish: stepNeedsFinish,
    expandReplicates: expandReplicates,
    parseSeconds: parseSeconds,
    stepDurationSeconds: stepDurationSeconds
  };
}));
