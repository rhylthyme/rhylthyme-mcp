// galago-tools instrument steps: command checks for the MCP validator.
//
// A step may carry `instrument: {tool, command, params?, toolType?,
// timeoutSeconds?}`, a command for a galago-tools lab instrument that the
// Rhylthyme runner sends when the step starts (rhylthyme-galago). This module
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

// Findings for a program's instrument steps, as rhylthyme_galago.check_program
// without a workcell (plus shape checks the JSON schema makes in Python):
// [{code, message, where, fix, severity}].
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
      if (!_isObj(inst) || typeof inst.tool !== "string" || !inst.tool ||
          typeof inst.command !== "string" || !inst.command) {
        add("error", "instrument_bad_shape", id, `${prefix}: instrument needs a tool and a command`,
          "Use {\"tool\": \"shaker\", \"command\": \"start_shake\", \"params\": {...}}.");
        continue;
      }
      if (inst.params !== undefined && !_isObj(inst.params)) {
        add("error", "instrument_bad_shape", id, `${prefix}: instrument.params must be an object`);
        continue;
      }
      if (inst.timeoutSeconds !== undefined && !(typeof inst.timeoutSeconds === "number" && inst.timeoutSeconds > 0)) {
        add("error", "instrument_bad_shape", id, `${prefix}: instrument.timeoutSeconds must be a positive number`);
      }
      if (!inst.toolType) {
        add("warning", "instrument_unchecked", id,
          `${prefix}: ${inst.tool}.${inst.command} not checked; add toolType or validate with --workcell`,
          "Add toolType (the galago tool type, e.g. \"bioshake\") or run `rhylthyme validate --workcell`.");
        continue;
      }
      if (!TOOL_TYPES.includes(inst.toolType)) {
        add("error", "instrument_unknown_tool_type", id, `${prefix}: unknown galago toolType ${pyRepr(inst.toolType)}`,
          `Use one of: ${[...TOOL_TYPES].sort().join(", ")}.`);
        continue;
      }
      for (const problem of validateCommand(inst.toolType, inst.command, inst.params)) {
        add("error", "instrument_invalid_command", id,
          `${prefix}: ${inst.tool} (${inst.toolType}) ${inst.command}: ${problem}`);
      }
    }
  }
  return out;
}

module.exports = { validateCommand, instrumentFindings, pyRepr, TOOL_TYPES, CATALOG };
