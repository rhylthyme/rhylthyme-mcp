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
const SERIES_COUNTS = ["count", "timepoints"];
const SERIES_INTERVALS = ["interval_s"];
const RUN_LENGTHS = ["duration_s", "run_time_s"];
const SETTLE = ["equilibration_s"];
const TIMEOUTS = ["timeout_s"];

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

function serverEntry(pkg) {
  const entry = CATALOG.packages[pkg];
  return entry && !entry.error ? entry : null;
}

function _limitProblems(pkg, params) {
  const problems = [];
  const limits = (serverEntry(pkg) || {}).limits || {};
  for (const [name, limit] of Object.entries(limits)) {
    if (!_isNum(limit.default)) continue;
    const match = /^(max|min)_(.+)$/.exec(name);
    if (!match || !Object.prototype.hasOwnProperty.call(params, match[2])) continue;
    const value = params[match[2]];
    if (!_isNum(value)) continue;
    const kind = limit.kind || "max";
    const over = kind === "max" ? value > limit.default : value < limit.default;
    if (over) {
      const unit = limit.unit ? " " + limit.unit : "";
      problems.push(`${match[2]}=${fmtG(value)} is ${kind === "max" ? "above" : "below"} the server's default limit ${name}=${fmtG(limit.default)}${unit}`);
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
  if (_isObj(params)) _limitProblems(pkg, params).forEach((p) => problems.push(["instrument_over_limit", p]));
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
  const merged = Object.assign({}, params || {});
  const defaulted = new Set();
  const spec = ((serverEntry(pkg) || {}).tools || {})[command] || {};
  for (const [name, prop] of Object.entries(((spec.inputSchema || {}).properties) || {})) {
    if (!(name in merged) && _isObj(prop) && "default" in prop) {
      merged[name] = prop.default;
      defaulted.add(name);
    }
  }
  const detail = (...names) => {
    const used = names.map((n) => `params.${n}`);
    if (names.some((n) => defaulted.has(n))) used.push("tool defaults");
    return used.join(", ");
  };
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
  return { seconds: DEFAULT_SECONDS, source: "default", detail: "" };
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
        for (const [code, problem] of callProblems(inst.toolType, call.command, call.params)) {
          out.push({
            severity: "error", code, where, fix: null,
            message: `${prefix}: ${call.tool} (${inst.toolType}) ${call.command}: ${problem}`,
          });
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
  CATALOG, DEFAULT_SECONDS, callProblems, estimateCall, fmtG, instrumentFindings,
  isLabmcpStep, pyRepr, schemaProblems, serverEntry, stepEstimate, withEstimates,
};
