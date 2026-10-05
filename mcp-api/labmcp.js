// LabMCP instrument steps: call checks and planning estimates for the MCP
// validator and analyze_schedule.
//
// A step whose `instrument.toolType` names a LabMCP server package
// ("labmcp-ika") has its calls on that tool checked against the LabMCP
// catalogue: the server must have the tool, the params must fit its input
// schema (unknown or missing params, types, bounds, enums, lengths) and the
// server's default safety limits (a limit named max_<param> or min_<param>
// bounds that param). A step with no duration that ends on a reply gets a
// planning estimate from its params.
//
// labmcp-catalog.json is exported from every LabMCP server run with
// --simulate by rhylthyme-labmcp/scripts/export_catalog.py (attribution in its
// `source`), and every message and estimate here matches rhylthyme_labmcp's
// word for word: labmcp.test.js checks them against labmcp-check-cases.json,
// exported by rhylthyme-labmcp/scripts/export_check_cases.py. Both files are
// mirrored byte for byte (tools/check_mirrors.sh).
//
// Workcells (addresses, the lab's own limits) never reach this server; a
// workcell check is `rhylthyme validate --workcell` on the lab machine.
"use strict";

const CATALOG = require("./labmcp-catalog.json");

const PREFIX = "labmcp-";
const DEFAULT_SECONDS = 10;
// [volume, rate, seconds per rate unit of time]: volume / rate * factor
const DOSES = [["volume_ml", "rate_ml_min", 60], ["volume_ul", "flow_ul_s", 1]];
const SERIES_COUNTS = ["count", "timepoints"];
// Tools that reply as soon as they start acting, before the work is done
const RETURNS_EARLY_TOOLS = new Set(["labmcp-new-era infuse", "labmcp-new-era withdraw"]);
const SERIES_INTERVALS = ["interval_s"];
const RUN_LENGTHS = ["duration_s", "run_time_s"];
const SETTLE = ["equilibration_s"];
const TIMEOUTS = ["timeout_s", "wait_s"];

function _isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function _isNum(v) { return typeof v === "number" && Number.isFinite(v); }

// --- Python's repr and format(x, "g"), as rhylthyme_labmcp prints them ---

function _exp(text) {
  // JS "1e-5" / "1.5e+20" -> Python "1e-05" / "1.5e+20"
  const [m, e] = text.split("e");
  const sign = e[0] === "-" ? "-" : "+";
  const digits = e.replace(/^[+-]/, "");
  return `${m}e${sign}${digits.length < 2 ? "0" + digits : digits}`;
}

function pyNum(x) {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  if (x !== 0 && (Math.abs(x) < 1e-4 || Math.abs(x) >= 1e16)) return _exp(x.toExponential());
  return String(x);
}

function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return pyNum(v);
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) return `"${v}"`;
    return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}'`;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
}

function fmtG(x) {
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    return _exp(`${m.includes(".") ? m.replace(/\.?0+$/, "") : m}e${e}`);
  }
  return String(Number(x.toPrecision(6)));
}

// --- A JSON Schema validator for what LabMCP's input schemas use ---------
// (jsonschema's Draft 2020-12 messages, keyword order and path sort)

const TYPE_CHECKS = {
  object: _isObj,
  array: Array.isArray,
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

function _deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function _errors(schema, value, path) {
  const out = [];
  const add = (message) => out.push({ path, message });
  for (const [kw, arg] of Object.entries(schema || {})) {
    switch (kw) {
      case "type": {
        const types = Array.isArray(arg) ? arg : [arg];
        if (!types.some((t) => (TYPE_CHECKS[t] || (() => true))(value))) {
          add(`${pyRepr(value)} is not of type ${types.map(pyRepr).join(", ")}`);
        }
        break;
      }
      case "enum":
        if (!arg.some((e) => _deepEqual(e, value))) add(`${pyRepr(value)} is not one of ${pyRepr(arg)}`);
        break;
      case "minimum":
        if (_isNum(value) && value < arg) add(`${pyRepr(value)} is less than the minimum of ${pyRepr(arg)}`);
        break;
      case "maximum":
        if (_isNum(value) && value > arg) add(`${pyRepr(value)} is greater than the maximum of ${pyRepr(arg)}`);
        break;
      case "exclusiveMinimum":
        if (_isNum(value) && value <= arg) add(`${pyRepr(value)} is less than or equal to the minimum of ${pyRepr(arg)}`);
        break;
      case "exclusiveMaximum":
        if (_isNum(value) && value >= arg) add(`${pyRepr(value)} is greater than or equal to the maximum of ${pyRepr(arg)}`);
        break;
      case "minLength":
        if (typeof value === "string" && [...value].length < arg) add(`${pyRepr(value)} ${arg === 1 ? "should be non-empty" : "is too short"}`);
        break;
      case "maxLength":
        if (typeof value === "string" && [...value].length > arg) add(`${pyRepr(value)} ${arg === 0 ? "is expected to be empty" : "is too long"}`);
        break;
      case "pattern":
        if (typeof value === "string" && !new RegExp(arg, "u").test(value)) add(`${pyRepr(value)} does not match ${pyRepr(arg)}`);
        break;
      case "minItems":
        if (Array.isArray(value) && value.length < arg) add(`${pyRepr(value)} ${arg === 1 ? "should be non-empty" : "is too short"}`);
        break;
      case "maxItems":
        if (Array.isArray(value) && value.length > arg) add(`${pyRepr(value)} ${arg === 0 ? "is expected to be empty" : "is too long"}`);
        break;
      case "items":
        if (Array.isArray(value) && _isObj(arg)) value.forEach((item, i) => out.push(..._errors(arg, item, path.concat([i]))));
        break;
      case "maxProperties":
        if (_isObj(value) && Object.keys(value).length > arg) add(`${pyRepr(value)} ${arg === 0 ? "is expected to be empty" : "has too many properties"}`);
        break;
      case "properties":
        if (_isObj(value)) {
          for (const [name, sub] of Object.entries(arg)) {
            if (Object.prototype.hasOwnProperty.call(value, name)) out.push(..._errors(sub, value[name], path.concat([name])));
          }
        }
        break;
      case "additionalProperties": {
        if (!_isObj(value)) break;
        const known = new Set(Object.keys(schema.properties || {}));
        const extras = Object.keys(value).filter((k) => !known.has(k)).sort();
        if (_isObj(arg)) extras.forEach((k) => out.push(..._errors(arg, value[k], path.concat([k]))));
        else if (arg === false && extras.length) {
          add(`Additional properties are not allowed (${extras.map(pyRepr).join(", ")} ${extras.length === 1 ? "was" : "were"} unexpected)`);
        }
        break;
      }
      case "required":
        if (_isObj(value)) {
          for (const name of arg) if (!Object.prototype.hasOwnProperty.call(value, name)) add(`${pyRepr(name)} is a required property`);
        }
        break;
      case "anyOf":
        if (!arg.some((sub) => _errors(sub, value, path).length === 0)) {
          add(`${pyRepr(value)} is not valid under any of the given schemas`);
        }
        break;
      default:
        break; // description, default, title, ...
    }
  }
  return out;
}

function _comparePaths(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function schemaProblems(schema, params) {
  const errors = _errors(schema, params, []);
  // Python's sorted(..., key=path) is stable: keep keyword order within a path
  return errors
    .map((e, i) => Object.assign(e, { i }))
    .sort((a, b) => _comparePaths(a.path, b.path) || a.i - b.i)
    .map((e) => (e.path.length ? `${e.path.join(".")}: ${e.message}` : e.message));
}

// --- The catalogue -------------------------------------------------------

// A catalogued server, with the galago commands it can stand in for
// (catalogue `compat`, from rhylthyme_labmcp/compat.py) among its tools.
function serverEntry(pkg) {
  const entry = CATALOG.packages[pkg];
  if (!entry || entry.error) return null;
  const extra = (CATALOG.compat || {})[pkg];
  if (!extra) return entry;
  const tools = Object.assign({}, entry.tools || {});
  for (const [command, spec] of Object.entries(extra)) {
    const tool = {};
    for (const k of ["kind", "description", "inputSchema"]) if (k in spec) tool[k] = spec[k];
    tools[command] = Object.assign(tool, { compat: true });
  }
  return Object.assign({}, entry, { tools });
}

// Params with the tool's schema defaults filled in, and which were defaulted.
function _withDefaults(pkg, command, params) {
  const merged = Object.assign({}, params || {});
  const defaulted = new Set();
  const spec = ((serverEntry(pkg) || {}).tools || {})[command] || {};
  for (const [name, prop] of Object.entries(((spec.inputSchema || {}).properties) || {})) {
    if (!(name in merged) && _isObj(prop) && "default" in prop) {
      merged[name] = prop.default;
      defaulted.add(name);
    }
  }
  return [merged, defaulted];
}

const _isNumber = (v) => typeof v === "number";

// [limit, what, value] for every limit this call's params meet, as
// rhylthyme_labmcp.checks._limited_values (catalogue limitTargets).
function _limitedValues(pkg, command, params) {
  const out = [];
  for (const name of Object.keys((serverEntry(pkg) || {}).limits || {})) {
    const match = /^(max|min)_(.+)$/.exec(name);
    if (match && Object.prototype.hasOwnProperty.call(params, match[2]) && _isNumber(params[match[2]])) {
      out.push([name, match[2], params[match[2]]]);
    }
  }
  const targets = (CATALOG.limitTargets || {})[pkg] || {};
  if (Object.values(targets).some((byTool) => command in byTool)) {
    const [merged] = _withDefaults(pkg, command, params);
    for (const [name, byTool] of Object.entries(targets)) {
      const target = byTool[command];
      if (target === "@series") {
        if (_isNumber(merged.count) && _isNumber(merged.interval_s)) {
          out.push([name, "series (count - 1) × interval_s", (merged.count - 1) * merged.interval_s]);
        }
      } else if (target !== undefined && _isNumber(merged[target])) {
        out.push([name, target, merged[target]]);
      }
    }
  }
  return out;
}

function _limitProblems(pkg, command, params) {
  const problems = [];
  const limits = (serverEntry(pkg) || {}).limits || {};
  for (const [name, what, value] of _limitedValues(pkg, command, params)) {
    const limit = limits[name];
    if (!limit || !_isNum(limit.default)) continue;
    const kind = limit.kind || "max";
    const over = kind === "max" ? value > limit.default : value < limit.default;
    if (over) {
      const unit = limit.unit ? " " + limit.unit : "";
      problems.push(`${what}=${fmtG(value)} is ${kind === "max" ? "above" : "below"} the server's default limit ${name}=${fmtG(limit.default)}${unit}`);
    }
  }
  return problems;
}

// [[code, problem]] for one call, as rhylthyme_labmcp.checks.call_problems
// with the server's default limits.
function callProblems(pkg, command, params) {
  const entry = serverEntry(pkg) || { tools: {} };
  const spec = entry.tools[command];
  if (!spec) {
    const known = Object.keys(entry.tools).sort().join(", ");
    return [["instrument_invalid_command", `${pkg} has no tool ${pyRepr(command)} (tools: ${known})`]];
  }
  const problems = schemaProblems(spec.inputSchema || {}, params).map((p) => ["instrument_invalid_command", p]);
  if (_isObj(params)) _limitProblems(pkg, command, params).forEach((p) => problems.push(["instrument_over_limit", p]));
  return problems;
}

// --- Planning estimates (rhylthyme_labmcp.estimates.estimate_call) ---------

function _first(params, names) {
  for (const name of names) {
    const v = params[name];
    if (typeof v === "number" && v >= 0) return [name, v];
  }
  return null;
}

function estimateCall(pkg, command, params) {
  const [merged, defaulted] = _withDefaults(pkg, command, params);
  const detail = (...names) => {
    const used = names.map((n) => `params.${n}`);
    if (names.some((n) => defaulted.has(n))) used.push("tool defaults");
    return used.join(", ");
  };
  for (const [volumeKey, rateKey, factor] of DOSES) {
    const volume = merged[volumeKey];
    const rate = merged[rateKey];
    if (typeof volume === "number" && volume >= 0 && typeof rate === "number" && rate > 0) {
      return { seconds: (volume / rate) * factor, source: "params", detail: detail(volumeKey, rateKey) };
    }
  }
  const count = _first(merged, SERIES_COUNTS);
  const interval = _first(merged, SERIES_INTERVALS);
  if (count && interval && count[1] >= 1) {
    return { seconds: Math.max(0, count[1] - 1) * interval[1], source: "params", detail: detail(count[0], interval[0]) };
  }
  const length = _first(merged, RUN_LENGTHS);
  if (length) {
    const settle = _first(merged, SETTLE);
    const names = settle ? [length[0], settle[0]] : [length[0]];
    return { seconds: length[1] + (settle ? settle[1] : 0), source: "params", detail: detail(...names) };
  }
  const timeout = _first(merged, TIMEOUTS);
  if (timeout && timeout[1] > 0) {
    return { seconds: timeout[1], source: "params", detail: detail(timeout[0]) + " (an upper bound)" };
  }
  const typical = (((CATALOG.compat || {})[pkg] || {})[command] || {}).estimateSeconds;
  if (typical) return { seconds: typical, source: "default", detail: "" };
  return { seconds: DEFAULT_SECONDS, source: "default", detail: "" };
}

// How long a dose call pumps (volume / rate), or null if it is not one.
function doseSeconds(pkg, command, params) {
  const found = estimateCall(pkg, command, params);
  const first = found.detail.split(",")[0];
  return found.source === "params" && DOSES.some(([v]) => first === `params.${v}`) ? found.seconds : null;
}

// [[code, problem, severity]] about when a call's work ends, as
// rhylthyme_labmcp.checks.timing_problems.
function timingProblems(pkg, command, params, phase, stepSeconds) {
  if (!_isObj(params)) return [];
  const dose = doseSeconds(pkg, command, params);
  const takes = dose !== null ? ` (it takes ${fmtG(dose)} s)` : "";
  if (RETURNS_EARLY_TOOLS.has(`${pkg} ${command}`) && (phase === "call" || phase === "until")) {
    return [["instrument_returns_early",
      `replies as soon as it starts, so the step would end before the work is done${takes}; send it as a start action and give the step a duration`,
      "error"]];
  }
  if (phase === "start" && dose !== null && stepSeconds !== null && stepSeconds < dose) {
    return [["instrument_dose_outlasts_step",
      `the dose takes ${fmtG(dose)} s but the step lasts ${fmtG(stepSeconds)} s; its end actions and next steps would start while the pump still runs`,
      "warning"]];
  }
  return [];
}

// The longest a step can run on its own clock, or null if open-ended.
function _stepSeconds(step) {
  const { parseSeconds } = require("../static/js/timeline-render.js");
  const d = step.duration;
  if (d === undefined || d === null) return null;
  if (_isObj(d)) {
    if (d.type === "indefinite") return null;
    const v = d.maxSeconds !== undefined ? d.maxSeconds : d.seconds;
    return v === undefined ? null : Math.floor(parseSeconds(v));
  }
  return Math.floor(parseSeconds(d));
}

// --- Programs ----------------------------------------------------------------

function isLabmcpStep(step) {
  return _isObj(step) && _isObj(step.instrument) &&
    typeof step.instrument.toolType === "string" && step.instrument.toolType.startsWith(PREFIX);
}

function _ownCalls(inst) {
  // Every call on the step's own tool (the one toolType describes)
  const Galago = require("./galago.js");
  return Galago.instrumentCalls(inst).filter((c) => c.tool === inst.tool);
}

// Findings for LabMCP steps (those naming their server as toolType):
// [{code, message, where, fix, severity}], as rhylthyme_labmcp.check_calls.
function instrumentFindings(program) {
  const out = [];
  const version = CATALOG.source.labmcp || "";
  for (const track of (program && program.tracks) || []) {
    for (const step of (track && track.steps) || []) {
      if (!isLabmcpStep(step)) continue;
      const id = step.stepId;
      const where = `step:${id}`;
      const prefix = `Step ${pyRepr(String(id))}`;
      const inst = step.instrument;
      for (const call of _ownCalls(inst)) {
        if (!serverEntry(inst.toolType)) {
          out.push({
            severity: "warning", code: "instrument_unknown_tool_type", where, fix: null,
            message: `${prefix}: ${pyRepr(inst.toolType)} is not in the LabMCP catalogue (LabMCP ${version}); ${call.tool}.${call.command} not checked`,
          });
          continue;
        }
        const about = `${prefix}: ${call.tool} (${inst.toolType}) ${call.command}`;
        for (const [code, problem] of callProblems(inst.toolType, call.command, call.params)) {
          out.push({ severity: "error", code, where, fix: null, message: `${about}: ${problem}` });
        }
        for (const [code, problem, severity] of timingProblems(inst.toolType, call.command, call.params, call.phase, _stepSeconds(step))) {
          out.push({ severity, code, where, fix: null, message: `${about}: ${problem}` });
        }
      }
    }
  }
  return out;
}

// The estimate for a LabMCP step that ends on a reply and has no duration.
function stepEstimate(step) {
  if (!isLabmcpStep(step) || step.duration !== undefined) return null;
  const Galago = require("./galago.js");
  const call = Galago.blockingCall(step.instrument);
  if (!call || call.tool !== step.instrument.tool) return null;
  return estimateCall(step.instrument.toolType, call.command, call.params);
}

// A copy of the program whose LabMCP steps that end on a reply and have no
// duration carry their estimate as a fixed duration, flagged in
// metadata.durationEstimate (as `rhylthyme plan` writes it).
function withEstimates(program) {
  if (!_isObj(program) || !Array.isArray(program.tracks)) return program;
  let changed = false;
  const tracks = program.tracks.map((track) => {
    if (!_isObj(track) || !Array.isArray(track.steps)) return track;
    return Object.assign({}, track, {
      steps: track.steps.map((step) => {
        const estimate = stepEstimate(step);
        if (!estimate) return step;
        changed = true;
        const metadata = Object.assign({}, step.metadata || {}, {
          durationEstimate: { source: estimate.source, seconds: estimate.seconds },
        });
        return Object.assign({}, step, { duration: { type: "fixed", seconds: estimate.seconds }, metadata });
      }),
    });
  });
  return changed ? Object.assign({}, program, { tracks }) : program;
}

module.exports = {
  CATALOG, DEFAULT_SECONDS, callProblems, doseSeconds, estimateCall, fmtG, instrumentFindings, timingProblems,
  isLabmcpStep, pyRepr, schemaProblems, serverEntry, stepEstimate, withEstimates,
};
