// galago-tools instrument steps: command checks for the MCP validator.
//
// A step may carry `instrument: {tool, command, params?, toolType?,
// timeoutSeconds?}`, a command the Rhylthyme runner sends when the step
// starts, and/or phase actions: `start` (sent in order at step start),
// `until` (one blocking call instead of command), `end` (sent when the step
// ends) and `onAbort`, each `{command, params?, tool?}`. Tools resolve
// through the lab's workcell to galago-tools or LabMCP. This module
// checks those commands against galago's own definitions without protobuf:
// galago-commands.json is exported from the vendored protos by
// rhylthyme-galago/scripts/export_catalog.py, and every message matches
// rhylthyme_galago.validate_command word for word (schedule.test.js checks it
// against galago-command-cases.json, exported by the same script).
//
// Tool addresses live in a lab's local workcell file and never reach this
// server, so tool types come only from each step's `toolType`.

"use strict";

const CATALOG = require("./galago-commands.json");

const TOOL_TYPES = Object.keys(CATALOG.tools);

function _isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

// Python's repr(), so messages read exactly as the CLI's.
function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) return `"${v}"`;
    return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
}

function _typeName(field) {
  switch (field.type) {
    case "int": return "an integer";
    case "number": return "a number";
    case "bool": return "true or false";
    case "string": return "a string";
    case "enum": return "one of " + Object.keys(field.values).join(", ");
    default: return "an object";
  }
}

function _scalarOk(field, v) {
  switch (field.type) {
    case "int": return typeof v === "number" && Number.isInteger(v) && v >= field.min && v <= field.max;
    case "number": return typeof v === "number";
    case "bool": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "enum": return (typeof v === "string" && v in field.values) ||
      (typeof v === "number" && Number.isInteger(v) && Object.values(field.values).includes(v));
    default: return true; // bytes: left to the tool
  }
}

function _checkMessage(fields, values, path, problems) {
  if (!_isObj(values)) {
    problems.push(`'${path}' must be an object, got ${pyRepr(values)}`);
    return;
  }
  const names = Object.keys(fields);
  for (const [key, value] of Object.entries(values)) {
    const name = key in fields ? key : names.find((n) => fields[n].jsonName === key);
    const where = path ? `${path}.${key}` : key;
    if (!name) {
      problems.push(`unknown param '${where}' (takes ${names.join(", ") || "no params"})`);
      continue;
    }
    const field = fields[name];
    if (field.repeated && !Array.isArray(value)) {
      problems.push(`param '${where}' must be a list, got ${pyRepr(value)}`);
      continue;
    }
    for (const item of field.repeated ? value : [value]) {
      if (field.type === "any") continue;
      if (field.type === "message") _checkMessage(field.fields, item, where, problems);
      else if (!_scalarOk(field, item)) {
        problems.push(`param '${where}' must be ${_typeName(field)}, got ${pyRepr(item)}`);
      }
    }
  }
}

// Problems with a command for a tool type, as rhylthyme_galago.validate_command.
function validateCommand(toolType, command, params) {
  if (!TOOL_TYPES.includes(toolType)) {
    return [`unknown galago tool type ${pyRepr(toolType)} (expected one of: ${[...TOOL_TYPES].sort().join(", ")})`];
  }
  const commands = CATALOG.tools[toolType];
  if (!Object.prototype.hasOwnProperty.call(commands, command)) {
    return [`${toolType} has no command ${pyRepr(command)} (expected one of: ${Object.keys(commands).join(", ")})`];
  }
  const problems = [];
  _checkMessage(commands[command], params || {}, "", problems);
  return problems;
}

const ACTION_KEYS = new Set(["command", "params", "tool", "timeoutSeconds"]);
const INSTRUMENT_KEYS = new Set(["tool", "command", "params", "toolType", "timeoutSeconds", "start", "until", "end", "onAbort"]);
const PHASE_LISTS = ["start", "end", "onAbort"];

// Shape problems of one action ({command, params?, tool?, timeoutSeconds?}).
function _actionProblems(action, where) {
  if (!_isObj(action)) return [`${where} must be an object`];
  const problems = [];
  if (typeof action.command !== "string" || !action.command) problems.push(`${where} needs a command`);
  if (action.tool !== undefined && (typeof action.tool !== "string" || !action.tool)) problems.push(`${where}.tool must be a tool name`);
  if (action.params !== undefined && !_isObj(action.params)) problems.push(`${where}.params must be an object`);
  if (action.timeoutSeconds !== undefined && !(typeof action.timeoutSeconds === "number" && action.timeoutSeconds > 0)) {
    problems.push(`${where}.timeoutSeconds must be a positive number`);
  }
  const extra = Object.keys(action).filter((k) => !ACTION_KEYS.has(k));
  if (extra.length) problems.push(`${where} has unknown field(s) ${extra.join(", ")}`);
  return problems;
}

// Every call a step may send, tools resolved: start actions, then command
// or until, then end and onAbort actions (as the runner's step_calls).
function instrumentCalls(inst) {
  const calls = [];
  const action = (raw, phase) => ({ phase, tool: raw.tool || inst.tool, command: raw.command, params: raw.params || {} });
  for (const a of Array.isArray(inst.start) ? inst.start : []) if (_isObj(a)) calls.push(action(a, "start"));
  if (inst.command) calls.push({ phase: "call", tool: inst.tool, command: inst.command, params: inst.params || {} });
  else if (_isObj(inst.until) && inst.until.command) calls.push(action(inst.until, "until"));
  for (const phase of ["end", "onAbort"]) {
    for (const a of Array.isArray(inst[phase]) ? inst[phase] : []) if (_isObj(a)) calls.push(action(a, phase));
  }
  return calls;
}

// The call whose reply ends the step (command or until), or null.
function blockingCall(inst) {
  if (!_isObj(inst)) return null;
  return instrumentCalls(inst).find((c) => c.phase === "call" || c.phase === "until") || null;
}

// Shape problems of a step's instrument, as the program schema checks them.
function _shapeProblems(inst) {
  if (!_isObj(inst)) return ["instrument must be an object"];
  const problems = [];
  if (typeof inst.tool !== "string" || !inst.tool) problems.push("instrument needs a tool");
  if (inst.command !== undefined && (typeof inst.command !== "string" || !inst.command)) problems.push("instrument.command must be a command name");
  if (inst.command !== undefined && inst.until !== undefined) problems.push("instrument has both command and until; use one");
  if (inst.command === undefined && inst.until === undefined && inst.start === undefined && inst.end === undefined) {
    problems.push("instrument needs a command, an until, or start/end actions");
  }
  if (inst.params !== undefined && !_isObj(inst.params)) problems.push("instrument.params must be an object");
  if (inst.timeoutSeconds !== undefined && !(typeof inst.timeoutSeconds === "number" && inst.timeoutSeconds > 0)) {
    problems.push("instrument.timeoutSeconds must be a positive number");
  }
  if (inst.until !== undefined) problems.push(..._actionProblems(inst.until, "instrument.until"));
  for (const phase of PHASE_LISTS) {
    if (inst[phase] === undefined) continue;
    if (!Array.isArray(inst[phase]) || !inst[phase].length) {
      problems.push(`instrument.${phase} must be a non-empty list of actions`);
      continue;
    }
    inst[phase].forEach((a, i) => problems.push(..._actionProblems(a, `instrument.${phase}[${i}]`)));
  }
  const extra = Object.keys(inst).filter((k) => !INSTRUMENT_KEYS.has(k));
  if (extra.length) problems.push(`instrument has unknown field(s) ${extra.join(", ")}`);
  return problems;
}

// Findings for a program's instrument steps, as rhylthyme_galago.check_program
// without a workcell (plus shape checks the JSON schema makes in Python):
// [{code, message, where, fix, severity}]. Every call on the step's own tool
// is checked against its toolType; calls on other tools need a workcell.
function instrumentFindings(program) {
  const out = [];
  const add = (severity, code, stepId, message, fix) =>
    out.push({ severity, code, message, where: `step:${stepId}`, fix: fix || null });
  for (const track of (program && program.tracks) || []) {
    for (const step of (track && track.steps) || []) {
      if (!_isObj(step) || step.instrument === undefined) continue;
      const id = step.stepId;
      const prefix = `Step ${pyRepr(String(id))}`;
      const inst = step.instrument;
      const shape = _shapeProblems(inst);
      if (shape.length) {
        for (const problem of shape) {
          add("error", "instrument_bad_shape", id, `${prefix}: ${problem}`,
            "Use {\"tool\": \"shaker\", \"command\": \"start_shake\", \"params\": {...}}, or start/until/end actions: {\"command\", \"params\", \"tool\"}.");
        }
        continue;
      }
      if (!blockingCall(inst) && step.duration === undefined) {
        add("warning", "instrument_no_end", id,
          `${prefix} has no command, no until and no duration: it ends only when the operator ends it`,
          "Add a duration, or an until action whose reply ends it");
      }
      const calls = instrumentCalls(inst);
      const own = calls.filter((c) => c.tool === inst.tool);
      const other = calls.filter((c) => c.tool !== inst.tool);
      if (typeof inst.toolType === "string" && inst.toolType.startsWith("labmcp-")) {
        // A LabMCP server: its calls are checked by labmcp.js
      } else if (!inst.toolType) {
        const named = own.map((c) => `${c.tool}.${c.command}`).join(", ") || `${inst.tool} actions`;
        add("warning", "instrument_unchecked", id,
          `${prefix}: ${named} not checked; add toolType or validate with --workcell`,
          "Add toolType (the galago tool type, e.g. \"bioshake\") or run `rhylthyme validate --workcell`.");
      } else if (!TOOL_TYPES.includes(inst.toolType)) {
        add("error", "instrument_unknown_tool_type", id, `${prefix}: unknown galago toolType ${pyRepr(inst.toolType)}`,
          `Use one of: ${[...TOOL_TYPES].sort().join(", ")}.`);
        continue;
      } else {
        for (const call of own) {
          for (const problem of validateCommand(inst.toolType, call.command, call.params)) {
            add("error", "instrument_invalid_command", id,
              `${prefix}: ${call.tool} (${inst.toolType}) ${call.command}: ${problem}`);
          }
        }
      }
      for (const tool of [...new Set(other.map((c) => c.tool))]) {
        add("warning", "instrument_unchecked", id,
          `${prefix}: actions on ${tool} not checked; validate with --workcell`,
          "Run `rhylthyme validate --workcell` to check them against the lab's tools.");
      }
    }
  }
  return out;
}

module.exports = { validateCommand, instrumentFindings, instrumentCalls, blockingCall, pyRepr, TOOL_TYPES, CATALOG };
