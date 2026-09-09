/*!
 * Rhylthyme timeline-render v1.2.0
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
 *       dependency arrows, indefinite/variable/manual step marks, legend.
 *
 *   Rhylthyme.computeStepTimings(program)
 *       Returns { stepId: { start, end, duration, trackId, resolved } }
 *       in seconds from program start. `resolved` is false when the
 *       step's trigger could not be satisfied (cycle / dangling ref).
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
  // one, otherwise 0 (the live runner waits for a manual trigger).
  function stepDurationSeconds(step) {
    var d = (step && step.duration) || {};
    if (typeof d === 'string' || typeof d === 'number') return Math.max(0, parseSeconds(d));
    var v;
    if (d.seconds !== undefined && d.seconds !== null) v = parseSeconds(d.seconds);
    else if (d.defaultSeconds !== undefined && d.defaultSeconds !== null) v = parseSeconds(d.defaultSeconds);
    else if (d.maxSeconds !== undefined && d.maxSeconds !== null) v = parseSeconds(d.maxSeconds);
    else if (d.minSeconds !== undefined && d.minSeconds !== null) v = parseSeconds(d.minSeconds);
    else if (d.minutes !== undefined) v = parseSeconds(d.minutes) * 60;
    else if (d.hours !== undefined) v = parseSeconds(d.hours) * 3600;
    else v = 0;
    return Math.max(0, v || 0);
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
  function computeStepTimings(program) {
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
          var dur = stepDurationSeconds(allSteps[sid]);
          out[sid] = { start: start, end: start + dur, duration: dur, trackId: trackOf[sid], resolved: true };
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
  function renderTimelineSvg(program, opts) {
    program = program || {};
    opts = opts || {};
    var arrows = opts.arrows !== false, marks = opts.marks !== false, legend = opts.legend !== false;
    var tracks = (program.tracks || []).filter(function (t) {
      return (t.steps || []).length > 0;
    });
    if (!tracks.length) return '';

    var timings = computeStepTimings(program);
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
      globalEnd = Math.max(globalEnd, maxEnd);
    }
    if (globalEnd <= 0) globalEnd = 1;

    var W = 820;
    var H_HEADER = 56;
    var H_TRACK = 46;
    var H_FOOTER = legend ? 62 : 28;
    var PAD_LEFT = 150;
    var PAD_RIGHT = 18;
    var BAR_W = W - PAD_LEFT - PAD_RIGHT;
    var H = H_HEADER + tracks.length * H_TRACK + H_FOOTER;

    function xOf(t) { return PAD_LEFT + (t / globalEnd) * BAR_W; }
    function rowY(ti) { return H_HEADER + ti * H_TRACK; }
    function barTop(ti) { return rowY(ti) + 7; }
    function barMid(ti) { return rowY(ti) + H_TRACK / 2; }
    var BAR_H = H_TRACK - 14;

    var parts = [];
    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H
      + '" viewBox="0 0 ' + W + ' ' + H + '" '
      + 'font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif">'
    );
    parts.push('<defs>'
      + '<marker id="rt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
      + '<path d="M0,0 L10,5 L0,10 z" fill="#374151"/></marker>'
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
    for (var t = 0; t <= globalEnd; t += tickInterval) {
      var x = xOf(t);
      parts.push(
        '<line x1="' + x.toFixed(1) + '" y1="' + (axisY - 4) + '" x2="' + x.toFixed(1)
        + '" y2="' + axisY + '" stroke="#9ca3af" stroke-width="1"/>'
      );
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
        + '" font-size="12" fill="#374151" text-anchor="end">' + esc(trackLabel) + '</text>'
      );
      parts.push(
        '<rect x="' + PAD_LEFT + '" y="' + (y + 4) + '" width="' + BAR_W
        + '" height="' + (H_TRACK - 8) + '" fill="#ffffff" stroke="#e5e7eb"/>'
      );
      (track.steps || []).forEach(function (step, si) {
        var tim = timings[step.stepId];
        if (!tim || tim.duration <= 0) return;
        var d = step.duration || {};
        var x1 = xOf(tim.start);
        var x2 = xOf(tim.end);
        var w = Math.max(2, x2 - x1);
        var opacity = si % 2 === 0 ? 1 : 0.78;
        var isIndef = marks && d.type === 'indefinite';
        var isVar = marks && d.type === 'variable' && d.maxSeconds !== undefined;
        var isManual = marks && triggersOf(step).some(function (x) { return x && x.type === 'manual'; });
        // Variable: faded extension from default end to max end.
        if (isVar) {
          var xMax = xOf(tim.start + parseSeconds(d.maxSeconds));
          if (xMax > x2 + 1) {
            parts.push('<rect x="' + x2.toFixed(1) + '" y="' + barTop(ti) + '" width="' + (xMax - x2).toFixed(1)
              + '" height="' + BAR_H + '" fill="' + color + '" opacity="0.3" rx="3" ry="3"/>');
          }
        }
        parts.push(
          '<rect x="' + x1.toFixed(1) + '" y="' + barTop(ti) + '" width="' + w.toFixed(1)
          + '" height="' + BAR_H + '" fill="' + color + '" opacity="' + opacity
          + '" rx="3" ry="3"' + (isIndef ? ' stroke="#111827" stroke-width="1.5" stroke-dasharray="5,3"' : '') + '/>'
        );
        if (isIndef) {
          parts.push('<rect x="' + x1.toFixed(1) + '" y="' + barTop(ti) + '" width="' + w.toFixed(1)
            + '" height="' + BAR_H + '" fill="url(#rt-hatch)" rx="3" ry="3"/>');
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
            + 'font-weight="500">' + esc(display) + '</text>'
          );
        }
      });
    });

    // Cross-track dependency arrows, drawn above the bars.
    if (arrows) {
      var arrowCount = 0;
      tracks.forEach(function (track, ti) {
        (track.steps || []).forEach(function (step) {
          var tim = timings[step.stepId];
          if (!tim) return;
          triggersOf(step).forEach(function (tr) {
            if (!tr || !tr.stepId) return;
            if (tr.type !== 'afterStep' && tr.type !== 'afterStepWithBuffer') return;
            var refTrack = trackOfStep[tr.stepId];
            if (refTrack === undefined || refTrack === track.trackId) return;
            var ref = timings[tr.stepId];
            if (!ref) return;
            var fromT = (tr.event === 'start') ? ref.start : ref.end;
            var neg = parseSeconds(tr.offsetSeconds) < 0;
            var xFrom = xOf(fromT), xTo = xOf(tim.start);
            var yFrom = barMid(rowOfTrack[refTrack]), yTo = barMid(ti);
            var dir = yTo > yFrom ? 1 : -1;
            var yLeave = yFrom + dir * (BAR_H / 2 + 1);
            var yEnter = yTo - dir * (BAR_H / 2 + 1);
            // Vertical drop from the anchor, horizontal run, vertical arrival.
            // Stagger the horizontal run so arrows into the same row do not overprint.
            var yMid = yEnter - dir * (5 + 4 * (arrowCount++ % 3));
            var path = 'M' + xFrom.toFixed(1) + ',' + yLeave.toFixed(1)
              + ' L' + xFrom.toFixed(1) + ',' + yMid.toFixed(1)
              + ' L' + xTo.toFixed(1) + ',' + yMid.toFixed(1)
              + ' L' + xTo.toFixed(1) + ',' + yEnter.toFixed(1);
            parts.push('<path d="' + path + '" fill="none" stroke="#374151" stroke-width="1.3"'
              + (neg ? ' stroke-dasharray="4,3"' : '') + ' marker-end="url(#rt-arrow)"/>');
          });
        });
      });
    }

    if (legend) {
      var ly = H - 30;
      var lx = 16;
      function key(x, drawer, label) {
        parts.push(drawer(x, ly));
        parts.push('<text x="' + (x + 20) + '" y="' + (ly + 4) + '" font-size="10" fill="#4b5563">' + esc(label) + '</text>');
        return x + 20 + label.length * 5.2 + 16;
      }
      lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + y + ' h14" stroke="#374151" stroke-width="1.3" marker-end="url(#rt-arrow)"/>'; }, 'dependency');
      lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + y + ' h14" stroke="#374151" stroke-width="1.3" stroke-dasharray="4,3" marker-end="url(#rt-arrow)"/>'; }, 'negative offset');
      lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="14" height="12" fill="#9ca3af" stroke="#111827" stroke-width="1.2" stroke-dasharray="4,2" rx="2"/>'; }, 'indefinite (ends when the executor says)');
      lx = key(lx, function (x, y) { return '<rect x="' + x + '" y="' + (y - 6) + '" width="7" height="12" fill="#9ca3af" rx="2"/><rect x="' + (x + 7) + '" y="' + (y - 6) + '" width="7" height="12" fill="#9ca3af" opacity="0.3" rx="2"/>'; }, 'variable (default → max)');
      lx = key(lx, function (x, y) { return '<path d="M' + x + ',' + (y - 6) + ' l9,6 l-9,6 z" fill="#ffffff" stroke="#111827" stroke-width="1"/>'; }, 'manual gate');
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
    version: '1.2.0',
    // Program schema versions this engine understands; bumped in step
    // with the package's minor version when new trigger/duration forms
    // are added.
    supportedSchemaVersions: ['0.1.0', '0.2.0-alpha'],
    renderTimeline: renderTimeline,
    renderTimelineSvg: renderTimelineSvg,
    computeStepTimings: computeStepTimings,
    parseSeconds: parseSeconds,
    stepDurationSeconds: stepDurationSeconds
  };
}));
