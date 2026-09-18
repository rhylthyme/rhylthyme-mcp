// Vercel Serverless Function for Rhylthyme MCP Server (Streamable HTTP).
//
// Cohabitates FIVE MCP endpoints inside one Vercel function:
//
//   - /mcp           — generic Rhylthyme scheduler (anything). Lists as
//                      "rhylthyme" in the MCP directory.
//   - /kitchen/mcp   — cooking. Adds cook_recipe + whats_for_dinner;
//                      URLs land on kitchen.rhylthyme.com.
//                      Lists as "rhylthyme-kitchen".
//   - /lab/mcp       — laboratory protocols. Adds run_protocol +
//                      random_protocol; URLs land on lab.rhylthyme.com.
//                      Lists as "rhylthyme-lab".
//   - /events/mcp    — event run-of-show. Adds plan_event +
//                      random_event_template; URLs land on
//                      events.rhylthyme.com. Lists as "rhylthyme-events".
//   - /gym/mcp       — workouts and training. Adds start_workout +
//                      surprise_workout; URLs land on gym.rhylthyme.com.
//                      Lists as "rhylthyme-gym".
//
// All routes are wired in vercel.json. Each /<vertical>/mcp rewrites to
// /mcp-api; we recover the vertical from the original `req.url` path.
//
// Every endpoint exposes the same core surface:
//
//   Tools      validate_program, analyze_schedule, visualize_schedule,
//              preview_timeline, search_public_recipes, load_public_recipe,
//              import_from_source, create_environment, login,
//              list_my_programs, load_program, save_program,
//              get_renderer_source (+ two vertical-specific one-shots)
//   Resources  rhylthyme://schema/program, rhylthyme://guide/authoring,
//              rhylthyme://examples/<name>
//   Prompts    plan_schedule (+ a vertical-specific variant)
//
// Tools carry MCP annotations (readOnlyHint / destructiveHint /
// idempotentHint / openWorldHint) and, where the payload is structured,
// an outputSchema so agent frameworks can consume `structuredContent`
// without parsing markdown. Failures set `isError: true`.
//
// Uses @vercel/node with builds — must use module.exports default export.

"use strict";

const { z } = require("zod");
// Renderer lives in static/ so it doubles as a public CDN asset
// (kitchen.rhylthyme.com/static/js/timeline-render.js) — clients
// that render HTML artifacts can pull it from there and call
// Rhylthyme.renderTimeline(container, program) themselves.
const TimelineRender = require("../static/js/timeline-render.js");
const Schedule = require("./schedule.js");
const Prompts = require("./prompts.js");
const Analytics = require("./analytics.js");
// Bundled copies of the spec + a few example programs, exposed as MCP
// resources. Kept under static/ so the same files are also fetchable
// over HTTPS (www.rhylthyme.com/static/schema/…, /static/examples/…).
const PROGRAM_SCHEMA = require("../static/schema/program_schema_0.3.0-alpha.json");
const EXAMPLE_PROGRAMS = {
  breakfast_schedule: require("../static/examples/breakfast_schedule.json"),
  lab_experiment: require("../static/examples/lab_experiment.json"),
  stir_fry_with_choice: require("../static/examples/stir_fry_with_choice.json"),
  hiit_cardio_workout: require("../static/examples/hiit_cardio_workout.json"),
  corporate_presentation: require("../static/examples/corporate_presentation.json"),
  // 0.3.0-alpha constructs: instances "each"/"all" + replicates.maxInFlight.
  cookies_three_trays: require("../static/examples/cookies_three_trays.json"),
};

const SERVER_VERSION = "1.3.0";
const SCHEMA_VERSION_LABEL = "0.3.0-alpha";

const API_BASE = "https://www.rhylthyme.com";
const KITCHEN_BASE = "https://kitchen.rhylthyme.com";
const LAB_BASE = "https://lab.rhylthyme.com";
const EVENTS_BASE = "https://events.rhylthyme.com";
const GYM_BASE = "https://gym.rhylthyme.com";

const FETCH_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------
// Vertical configuration. One row per MCP endpoint; the generic row
// is the catch-all for /mcp. ``envFilter`` is what we send to
// /api/public/search and /api/programs/random; ``hostBase`` is the
// subdomain we want users to land on when they click a viewer link.
// ---------------------------------------------------------------------

const VERTICALS = {
  generic: {
    serverName: "rhylthyme-mcp",
    title: "Rhylthyme",
    hostBase: API_BASE,
    envFilter: null,
    oneShot: null,
    random: null,
  },
  kitchen: {
    serverName: "rhylthyme-kitchen-mcp",
    title: "Rhylthyme Kitchen",
    hostBase: KITCHEN_BASE,
    envFilter: "kitchen",
    oneShot: {
      name: "cook_recipe",
      title: "Cook a recipe now",
      argLabel: "Recipe name, cuisine, or short description — e.g. 'pad thai', 'chicken tikka masala', 'lemon chicken'.",
      missingQuery: "Need a recipe name or keyword to cook.",
      headingFor: (q) => `_Top match for "${q}":_`,
      noMatch: (q) =>
        `No public recipe matches "${q}". **Next step:** build the program yourself, run **validate_program**, then call **visualize_schedule** to deliver a live timeline to the user — do NOT describe the schedule in prose; the user explicitly wants a visual timeline. Use parallel tracks for stations that happen at the same time (e.g. Eggs, Vegetables, Toast, Assembly) and set realistic durations. Skeleton:\n\n` +
        '```json\n' +
        '{\n' +
        '  "schemaVersion": "0.1.0",\n' +
        `  "programId": "your-kebab-case-slug",\n` +
        `  "name": "Your title (matching '${q}')",\n` +
        '  "environmentType": "kitchen",\n' +
        '  "tracks": [\n' +
        '    {\n' +
        '      "trackId": "track1",\n' +
        '      "name": "Station name",\n' +
        '      "steps": [\n' +
        '        {\n' +
        '          "stepId": "s1",\n' +
        '          "name": "Step",\n' +
        '          "task": "prep",\n' +
        '          "duration": {"type":"fixed","seconds":300},\n' +
        '          "startTrigger": {"type":"programStart"}\n' +
        '        }\n' +
        '      ]\n' +
        '    }\n' +
        '  ],\n' +
        '  "resourceConstraints": [{"task":"prep","maxConcurrent":1}],\n' +
        '  "metadata": { "ingredients": [{"name":"…","measure":"…"}], "serves": "4" }\n' +
        '}\n' +
        '```\n\nThen call **visualize_schedule** with the full program.',
      description:
        "One-shot: find the best-matching public recipe by name or keyword and return a live cooking timeline URL ready to follow. Use this when the user wants to cook something specific ('let's make pad thai', 'cook me carbonara', 'I want chicken tikka tonight') and there's no need to compare options — it picks the top match and goes straight to a cookable URL with markdown summary. For when the user wants to browse options first, use **search_public_recipes** instead. If no match is found, this tool tells you exactly how to build a custom program and visualize it — follow that path rather than describing the schedule in prose.",
    },
    random: {
      name: "whats_for_dinner",
      title: "What's for dinner?",
      headingFor: () => "_Tonight's pick:_",
      noResult:
        "Couldn't pull a random recipe. Try again, or use **search_public_recipes** to pick one.",
      description:
        "Surprise the user with a random recipe from the Rhylthyme kitchen catalog. Use when the user says 'what should I cook tonight', 'surprise me', 'I can't decide what to make', or asks for a recommendation without specifics. Returns a markdown summary plus the live-timeline URL.",
    },
  },
  lab: {
    serverName: "rhylthyme-lab-mcp",
    title: "Rhylthyme Lab",
    hostBase: LAB_BASE,
    envFilter: "laboratory",
    oneShot: {
      name: "run_protocol",
      title: "Run a protocol now",
      argLabel:
        "Protocol name, technique, or short description — e.g. 'Western blot', 'ELISA', 'cell culture passage', 'PCR + gel'.",
      missingQuery: "Need a protocol name or keyword to run.",
      headingFor: (q) => `_Top match for "${q}":_`,
      noMatch: (q) =>
        `No public protocol matches "${q}". **Three ways forward:**\n\n` +
        `1. **Search the user's Benchling library** — if they've connected one at ` +
        `lab.rhylthyme.com → Settings → Benchling, call ` +
        `\`import_from_source({source: "benchling", action: "search", query: "${q}", token})\` ` +
        `with the user's Rhylthyme access token. Most working labs already have ` +
        `their canonical protocols there, and Benchling-imported timelines get all the ` +
        `equipment scheduling automatically. If you don't have a token yet, call ` +
        `**login** first.\n\n` +
        `2. **Pull from protocols.io / Opentrons** via ` +
        `\`import_from_source({source: "protocolsio" | "opentrons", action: "import", query: "<URL>", token})\`.\n\n` +
        `3. **Build it yourself**, check it with **validate_program** / **analyze_schedule**, then call **visualize_schedule** — never describe stages ` +
        `in prose; the user wants a runnable timeline at the bench. Use parallel tracks ` +
        `for incubations/processing that overlap, with realistic durations and equipment ` +
        `constraints.`,
      description:
        "One-shot: find the best-matching public lab protocol by name/keyword and return a live timeline URL ready to follow at the bench. Use this when the user says things like 'run a Western blot', 'do an ELISA assay', 'PCR setup with gel electrophoresis', 'cell culture passage' and wants to start the experiment without browsing alternatives. Returns a markdown summary (steps, durations, equipment) plus the live URL with stage timers and shared-equipment scheduling. For browsing first, use **search_public_recipes**.",
    },
    random: {
      name: "random_protocol",
      title: "Random protocol",
      headingFor: () => "_Today's protocol pick:_",
      noResult:
        "Couldn't pull a random protocol. Try again, or use **search_public_recipes** to pick one.",
      description:
        "Pick a random lab protocol from the catalog. Use when the user wants inspiration, a teaching example, or to browse what's possible without a specific technique in mind. Returns a markdown summary plus the live-timeline URL.",
    },
  },
  events: {
    serverName: "rhylthyme-events-mcp",
    title: "Rhylthyme Events",
    hostBase: EVENTS_BASE,
    envFilter: "event",
    oneShot: {
      name: "plan_event",
      title: "Plan an event now",
      argLabel:
        "Event type or short description — e.g. 'wedding at 2pm', 'product launch', 'birthday party for 20', 'awards ceremony', 'conference morning'.",
      missingQuery: "Need an event type or keyword to plan.",
      headingFor: (q) => `_Top match for "${q}":_`,
      noMatch: (q) =>
        `No public event template matches "${q}". **Next step:** build the run-of-show yourself, check it with **validate_program** (and **analyze_schedule** with finishAt for wall-clock cues), then call **visualize_schedule** to deliver it — do NOT describe cues in prose; the user wants a usable timeline. Lay out parallel tracks for ceremony/A-V/catering/music/photo with realistic cue offsets.`,
      description:
        "One-shot: find the best-matching public event run-of-show by name/keyword and return a live timeline URL the MC/coordinator can follow during the event. Use this when the user says things like 'plan a wedding starting at 2pm ceremony', 'product launch with demos and Q&A', 'awards ceremony rundown' and wants a usable timeline immediately. Returns markdown summary (parallel tracks for ceremony/A-V/catering/music, total run-of-show) plus the live URL with real-time clock and cue list. For browsing first, use **search_public_recipes**.",
    },
    random: {
      name: "random_event_template",
      title: "Random event template",
      headingFor: () => "_Event template pick:_",
      noResult:
        "Couldn't pull a random event template. Try again, or use **search_public_recipes** to pick one.",
      description:
        "Pick a random event template from the catalog (wedding, conference, ceremony, launch, party, etc.). Use when the user wants inspiration or an example of how a multi-track event timeline is structured. Returns a markdown summary plus the live-timeline URL.",
    },
  },
  gym: {
    serverName: "rhylthyme-gym-mcp",
    title: "Rhylthyme Gym",
    hostBase: GYM_BASE,
    envFilter: "gym",
    oneShot: {
      name: "start_workout",
      title: "Start a workout now",
      argLabel:
        "Workout name, style, or short description — e.g. '45min HIIT', 'push day chest shoulders triceps', 'yoga flow', '5x5 strength', 'circuit training'.",
      missingQuery: "Need a workout name or keyword to start.",
      headingFor: (q) => `_Top match for "${q}":_`,
      noMatch: (q) =>
        `No public workout matches "${q}". **Next step:** build the workout yourself, run **validate_program**, then call **visualize_schedule** to deliver it — do NOT describe sets in prose; the user wants a runnable training timeline. Lay out parallel tracks for supersets and rest, with realistic set/rep/rest durations.`,
      description:
        "One-shot: find the best-matching public workout by name/keyword and return a live training timeline URL ready to follow at the gym. Use this when the user says things like 'let's do HIIT', 'push day workout', 'yoga flow with warm-up', '5x5 strength session', 'circuit training' and wants to start training without browsing alternatives. Returns a markdown summary (exercises, sets/reps, rest intervals, total time) plus the live URL with interval timers and superset coordination. For browsing first, use **search_public_recipes**.",
    },
    random: {
      name: "surprise_workout",
      title: "Surprise workout",
      headingFor: () => "_Today's workout pick:_",
      noResult:
        "Couldn't pull a random workout. Try again, or use **search_public_recipes** to pick one.",
      description:
        "Surprise the user with a random workout from the Rhylthyme catalog. Use when the user says 'pick something for me', 'what should I do today', 'surprise me with a workout', or wants variety from their usual routine. Returns a markdown summary plus the live-timeline URL.",
    },
  },
};

// ---------------------------------------------------------------------
// Server-level instructions, surfaced to the client at `initialize`.
// Claude reads these once per session, so they carry the workflow
// (search → load → visualize / build → validate → analyze → visualize)
// rather than repeating it in every tool description.
// ---------------------------------------------------------------------

function serverInstructions(vertical) {
  const cfg = VERTICALS[vertical] || VERTICALS.generic;
  const domain = {
    generic: "any real-time, multi-track process — cooking, lab protocols, event run-of-shows, workouts, manufacturing, turnarounds",
    kitchen: "cooking and meal coordination",
    lab: "laboratory protocols and bench work",
    events: "event run-of-shows and cue sheets",
    gym: "workouts and training sessions",
  }[vertical] || "real-time scheduling";
  const oneShot = cfg.oneShot ? `- Fast path: **${cfg.oneShot.name}** takes a keyword and returns the top catalog match as a live timeline in one call.\n` : "";
  return [
    `${cfg.title} schedules ${domain}. A "program" is JSON: parallel **tracks** of sequential **steps**, each with a duration and a startTrigger (programStart / afterStep / programStartOffset / afterStepWithBuffer / manual), plus **resourceConstraints** (e.g. one oven) that the live runner enforces.`,
    "",
    "Workflow:",
    "- Existing content: **search_public_recipes** → **load_public_recipe** (or the one-shot tool). The result already includes the live URL.",
    oneShot.trimEnd(),
    "- New content: build the program → **validate_program** (fix every error it reports) → optionally **analyze_schedule** (makespan, critical path, conflicts, wall clock when you pass finishAt/startAt) → **visualize_schedule** for the shareable live timeline. visualize_schedule validates too and refuses invalid programs.",
    "- Never describe a schedule in prose when a timeline is possible; the URL is the deliverable. Quote the Gantt / itinerary from the result when summarizing.",
    "- **login** is only needed for the private library (list_my_programs, load_program, save_program) and for imports. Public catalog tools need no token.",
    "",
    "Authoring rules: stepIds unique across the whole program; steps in one track never overlap (chain with afterStep); every `task` used by a step has a matching resourceConstraint; durations in seconds (numbers) or time strings (\"5m\", \"1h30m\"); repeated work is `replicates` on ONE step with `instances: \"each\"`/`\"all\"` and `maxInFlight`, never copied steps; to make everything finish together, delay short tracks with programStartOffset or afterStep, and pass finishAt to analyze_schedule for wall-clock start times.",
    "",
    "Authoring from a goal or a source text: run the **plan_schedule** prompt — four turns (read the source back → confirm the program model → extract the steps with the words they came from → assign tracks and triggers). Without multi-message prompt support, read `rhylthyme://guide/extraction` for the same four turns. `rhylthyme://guide/authoring` is the cheat-sheet, `rhylthyme://schema/program` the full JSON schema, `rhylthyme://examples/*` complete valid programs.",
  ].filter((l) => l !== "").join("\n");
}

// ---------------------------------------------------------------------
// Per-tool descriptions, keyed by vertical. Keeping them in one map
// makes it easy to compare/edit across verticals.
// ---------------------------------------------------------------------

const DESC = {
  visualize_schedule: {
    generic:
      "Render a multi-step parallel schedule as a live timeline (cooking, lab protocols, event run-of-show, training). **Call this for ANY schedule you produce — imported, catalog match, or built freehand.** A schedule belongs in a visualization, never in prose. The program is validated first (same checks as validate_program); invalid programs are refused with fix hints instead of being published. Returns a markdown preview (cover photo if any, equipment list, ingredient list, ASCII Gantt timeline, chronological itinerary, schedule check) and a shareable rhylthyme.com URL with the interactive view.",
    kitchen:
      "Render a cooking schedule as a live timeline the user can follow on their phone. **Call this for ANY cooking schedule — imported recipe, catalog match, or composed freehand.** Recipes belong in a visualization, never in prose. Takes a Rhylthyme program (parallel tracks of timed steps with shared-equipment constraints), validates it, and returns a markdown preview (cover photo if any, equipment list, ingredient list, ASCII Gantt, chronological itinerary, schedule check, source attribution) plus a shareable kitchen.rhylthyme.com URL with interactive timeline, ingredient checklist, real-time play/pause, and audio step cues. For assembly meals with no catalog match (bagel & lox, charcuterie, breakfast spreads), still call this — the Gantt and itinerary are structural orchestration (not protected content) and they're the whole point.",
    lab:
      "Render a lab protocol as a live timeline the researcher follows at the bench. **Call this for ANY protocol — imported, catalog match, or built freehand.** Protocols belong in a visualization, never in prose. Validates the program, then returns a markdown preview (instruments, materials, ASCII Gantt, chronological itinerary, schedule check, lab.rhylthyme.com URL). Indispensable for protocols where parallel incubations have to converge at the same point.",
    events:
      "Render an event run-of-show as a live timeline the planner/MC follows during the event. **Call this for ANY event timeline — imported, catalog match, or freehand.** Run-of-shows belong in a visualization, never in prose. Validates the program, then returns a markdown preview (resources, ASCII Gantt across tracks, chronological cue list, schedule check, events.rhylthyme.com URL).",
    gym:
      "Render a workout as a live timeline the lifter follows during training. **Call this for ANY workout — imported, catalog match, or freehand.** Workouts belong in a visualization, never in prose. Validates the program, then returns a markdown preview (stations/equipment, ASCII Gantt across tracks, chronological itinerary, schedule check, gym.rhylthyme.com URL).",
  },
  import_from_source: {
    generic:
      "Import a recipe or lab protocol from an external source into a Rhylthyme program. Sources: spoonacular (recipes, preferred), themealdb (recipes, fallback), protocolsio (lab protocols), cooklang (.cook recipe URL — action must be 'import', query is the URL; GitHub blob URLs are auto-converted), opentrons (Opentrons Protocol API v2 .py — pass URL as query, or paste source via text; action must be 'import'), benchling (the user's connected library). Actions: search (no login needed), import and random (need the user's Rhylthyme token from **login**). After import, run the returned program through **visualize_schedule**. Pass `enrich: true` with action='import' to split the import into parallel tracks with cross-track triggers (one model call, capped per day; inferred steps are marked `metadata.inferred`).",
    kitchen:
      "Import a recipe from a URL or recipe source into a cookable Rhylthyme program. Use when the user shares a recipe link, says 'turn this URL into a timeline', or asks for a recipe from a specific service. Sources: spoonacular (preferred — high quality, structured ingredients), themealdb (free fallback), cooklang (.cook files from any URL including GitHub blob URLs — pass URL as query, action='import'). Actions: search (find candidates; no login), import (URL/id → program JSON; needs `token` from **login**), random (needs `token`). After import, pass the returned program to **visualize_schedule** so the user can start cooking. Pass `enrich: true` with action='import' to split the import into parallel tracks with cross-track triggers (one model call, capped per day; inferred steps are marked `metadata.inferred`).",
    lab:
      "Import a lab protocol from an external source into a runnable Rhylthyme program. Use when the user pastes a protocols.io link, an Opentrons Protocol API .py file, a Benchling protocol URL, or a published method they want timed at the bench. Sources: benchling (the user's connected Benchling library — supports action='search' with `query`, then action='import' with the protocol id or URL), protocolsio (protocols.io URL or id), opentrons (Opentrons Protocol API v2 .py — pass URL as query, or paste source via text; action='import'). Actions: search, import, random (random not supported for benchling). import/random and anything Benchling need the user's Rhylthyme access token via `token` (from **login**). After import, pass the returned program to **visualize_schedule** so the user can start the experiment. Pass `enrich: true` with action='import' to split the import into parallel tracks with cross-track triggers (one model call, capped per day; inferred steps are marked `metadata.inferred`).",
    events:
      "Import an event template into a Rhylthyme program. The catalog leans toward recipe/protocol sources (no dedicated event-template source today), so this tool is mostly useful for power-users who want to seed an event run-of-show from a recipe-style schedule. import/random need the user's token from **login**. Most planners build from scratch with **validate_program** + **visualize_schedule** instead.",
    gym:
      "Import a workout from an external source into a Rhylthyme program. The catalog leans toward recipe/protocol sources (no dedicated workout source today), so this tool is mostly a power-user fallback. import/random need the user's token from **login**. Most lifters build a workout from scratch with **validate_program** + **visualize_schedule** instead, or pick one with **start_workout**.",
  },
  import_text: {
    generic:
      "Turn a block of pasted text \u2014 a recipe, a lab protocol, a run-of-show, a training plan \u2014 into a validated multi-track Rhylthyme program. Use when the user pastes the steps themselves and no structural importer fits (no URL, no supported service, a photo they transcribed, a PDF they copied out of). Runs four model turns server-side: read-back, schema check, step extraction with the exact source span each step came from, then tracks and triggers. Needs the user's Rhylthyme token from **login**; costs a model call per turn and is capped per day. Returns the program plus a step\u2192span table, so you can show the user which words each step came from and which steps were inferred.",
    kitchen:
      "Turn pasted recipe text into a cookable multi-track Rhylthyme program. Use when the user pastes or types the recipe itself \u2014 off a card, out of a cookbook photo, from a message \u2014 instead of giving a URL a recipe importer could fetch. Runs four model turns server-side (read-back, schema check, step extraction with source spans, then tracks and triggers) and hands back a program whose dishes run in parallel. Needs the user's token from **login**; capped per day. Pass `environmentType: 'kitchen'`, the time dinner has to be on the table as `deadline`, and the equipment limits as `hints`. Then call **visualize_schedule**.",
    lab:
      "Turn pasted protocol text into a runnable multi-track Rhylthyme program. Use when the user pastes the method itself \u2014 out of a paper, a PDF, a lab notebook \u2014 instead of a protocols.io or Benchling link a structural importer could read. Runs four model turns server-side (read-back, schema check, step extraction with the source span each step came from, then tracks and triggers), so incubations overlap hands-on work instead of queuing behind it. Needs the user's token from **login**; capped per day. Pass `environmentType: 'lab'` and the shared instruments as `hints`. Then call **visualize_schedule**.",
    events:
      "Turn a pasted run-of-show \u2014 a schedule in an email, a call sheet, a printed programme \u2014 into a multi-track Rhylthyme run-of-show with cues, gates and parallel tracks. Runs four model turns server-side (read-back, schema check, extraction with source spans, then tracks and triggers). Needs the user's token from **login**; capped per day. Pass `environmentType: 'events'`, doors or curtain time as `deadline`, and stage/PA/crew limits as `hints`. Then call **visualize_schedule**.",
    gym:
      "Turn a pasted workout \u2014 a coach's message, a plan off a whiteboard, a printed session \u2014 into a timed multi-track Rhylthyme program with work and rest intervals. Runs four model turns server-side (read-back, schema check, extraction with source spans, then tracks and triggers). Needs the user's token from **login**; capped per day. Pass `environmentType: 'gym'` and any equipment limits as `hints`. Then call **visualize_schedule**.",
  },
  create_environment: {
    generic:
      "Create a Rhylthyme environment definition with resource constraints for a workspace (lab, kitchen, bakery, etc.). Returns environment JSON; copy its resourceConstraints into the program (or reference it by environmentId) before calling **visualize_schedule**.",
    kitchen:
      "Describe a kitchen's equipment limits (one oven, two stovetop burners, one stand mixer, etc.) so multi-recipe schedules respect them. Use when the user is planning multiple dishes around shared equipment ('Thanksgiving dinner with one oven') and the timeline needs to interleave correctly. Copy the returned resourceConstraints into the program before calling **visualize_schedule**.",
    lab:
      "Describe a lab's equipment limits (two incubators, one centrifuge, one plate reader, four thermocyclers, etc.) so multi-protocol or batched-sample timelines respect them. Critical when a protocol uses shared instruments or when several protocols run in parallel — the schedule will queue access correctly. Copy the returned resourceConstraints into the program before calling **visualize_schedule**.",
    events:
      "Describe an event's parallel-resource limits (one stage, one PA, three caterers, two photographers, etc.) so the run-of-show interleaves cues correctly across tracks. Copy the returned resourceConstraints into the program before calling **visualize_schedule**.",
    gym:
      "Describe a gym's equipment limits (one squat rack, two benches, eight dumbbells, etc.) so multi-lifter workouts or supersets respect them. Useful for group/class sessions where stations are shared. Copy the returned resourceConstraints into the program before calling **visualize_schedule**.",
  },
  login: {
    generic:
      "Sign in to your Rhylthyme account so you can list and save your schedules and import from external sources. Opens a browser page where you log in (Google, Apple, or email). After signing in, copy the token displayed on the page and provide it here. Tokens expire after about an hour; if a later call reports an auth error, call login again for a fresh one.",
    kitchen:
      "Connect a user's Rhylthyme account so you can save recipes to their personal cookbook, list ones they've saved, or import recipes from external sources. Public recipes don't require login — only call this when the user explicitly wants to save/recall their own stuff or import. Opens a browser sign-in (Google/Apple/email); user pastes the resulting token back. Tokens expire after about an hour.",
    lab:
      "Connect a user's Rhylthyme account so you can save protocols to their personal collection, list ones they've saved, or import from Benchling / protocols.io / Opentrons. Public protocols don't require login. Opens a browser sign-in (Google/Apple/email); user pastes the resulting token back. Tokens expire after about an hour.",
    events:
      "Connect a user's Rhylthyme account so you can save event run-of-shows to their personal collection or list ones they've saved. Public templates don't require login. Opens a browser sign-in (Google/Apple/email); user pastes the resulting token back. Tokens expire after about an hour.",
    gym:
      "Connect a user's Rhylthyme account so you can save workouts to their personal collection or list ones they've saved. Public workouts don't require login. Opens a browser sign-in (Google/Apple/email); user pastes the resulting token back. Tokens expire after about an hour.",
  },
  list_my_programs: {
    generic:
      "List your saved Rhylthyme schedules. Requires a login token from the login tool.",
    kitchen:
      "List the user's saved recipes (their personal cookbook). Use when the user asks 'what recipes do I have saved' or wants to re-cook something they bookmarked. Requires a login token.",
    lab:
      "List the user's saved lab protocols (their personal collection). Use when the user asks 'what protocols do I have' or wants to re-run something they bookmarked. Requires a login token.",
    events:
      "List the user's saved event run-of-shows. Use when the user asks 'what events do I have' or wants to revisit a planned event. Requires a login token.",
    gym:
      "List the user's saved workouts (their personal training log). Use when the user asks 'what workouts do I have' or wants to repeat a session. Requires a login token.",
  },
  load_program: {
    generic:
      "Load a specific saved program by ID. Returns a markdown summary plus a live-timeline URL.",
    kitchen:
      "Open one of the user's own saved recipes by id. Returns a markdown summary (ingredients, schedule, total time) plus the live-timeline URL the user can open on their phone. Requires a login token.",
    lab:
      "Open one of the user's own saved protocols by id. Returns a markdown summary (steps, durations, equipment) plus the live-timeline URL. Requires a login token.",
    events:
      "Open one of the user's own saved event run-of-shows by id. Returns a markdown summary (tracks, cues, total run-of-show) plus the live-timeline URL. Requires a login token.",
    gym:
      "Open one of the user's own saved workouts by id. Returns a markdown summary (exercises, sets, rest, total time) plus the live-timeline URL. Requires a login token.",
  },
  list_runs: {
    generic:
      "List the recorded executions of one saved program, newest first: when it ran, how it ended, and the actual makespan against the planned one. A run record is written whenever the live timeline is played (or the terminal runner is used); it is what makes the planned durations checkable against reality. Requires a login token; runs are private to whoever ran them.",
    kitchen:
      "List the times the user has actually cooked one of their saved recipes: date, how it ended, and how long it really took against the plan. Use when they ask 'how long did this take last time', 'have I made this before', or before proposing changes to a recipe's timings. Requires a login token.",
    lab:
      "List the recorded executions of one of the user's saved protocols: date, outcome, and actual against planned duration per run. Use when they ask how long a protocol really takes at the bench, or before adjusting incubation times. Requires a login token.",
    events:
      "List the times one of the user's saved run-of-shows was actually run: date, outcome, and actual against planned total. Use when they ask how a previous event ran to time. Requires a login token.",
    gym:
      "List the recorded sessions of one of the user's saved workouts: date, outcome, and actual against planned duration. Use when they ask how long the session really took or whether they finished it. Requires a login token.",
  },
  load_run: {
    generic:
      "Open one recorded execution by run id: planned versus actual start, end and duration for every step, what ended each step (a person, a timer, an abort), time the clock was paused, and the recorded variance factors. Use it to see where a plan drifts from reality. Requires a login token.",
    kitchen:
      "Open one recorded cook: planned versus actual timing for every step, which steps the cook ended by hand, and where the schedule drifted. Use it to explain why dinner ran late, or to justify new durations for a recipe. Requires a login token.",
    lab:
      "Open one recorded protocol execution: planned versus actual timing per step, which steps the operator ended, and any pauses. Use it to see which incubations really take longer than the protocol claims. Requires a login token.",
    events:
      "Open one recorded event: planned versus actual timing per cue, which cues the MC ended by hand, and where the run-of-show slipped. Requires a login token.",
    gym:
      "Open one recorded session: planned versus actual timing per exercise and rest, and which sets the lifter ended by hand. Requires a login token.",
  },
  calibrate_program: {
    generic:
      "Propose new durations for one of the user's saved programs from its recorded runs, with the evidence. For every non-fixed step with enough runs a person ended by hand: the median becomes the proposed default, the 10th/90th percentiles the proposed min/max, widened so the author's own range is never narrowed. A fixed step that consistently overruns gets a \"consider variable\" note and no number, because only the author can decide that. The result is a per-step table (n, median, IQR, current, proposed, delta) plus what accepting the lot would do to the makespan and the critical path. **It never saves anything**: pass `accept` to get the calibrated program back — each changed duration carrying `calibratedFrom` — and then save_program if the user wants it kept. Requires a login token; the runs are private to whoever ran them.",
    kitchen:
      "Turn the times the user has actually cooked a saved recipe into proposed durations for it. Each step they ended by hand gets its median cook time as the new default and its 10th/90th percentiles as the range, never narrower than what the recipe already says; a fixed step that always overruns is flagged as one that should probably be variable. Use it when they say a recipe's timings are wrong, or after a few cooks. Shows the evidence and the effect on total time; **saves nothing** unless you pass `accept` and then call save_program. Requires a login token.",
    lab:
      "Propose durations for one of the user's saved protocols from its recorded executions: the median observed time per operator-ended step as the new default, the 10th/90th percentiles as the range (never narrowed), and a \"consider variable\" note on any fixed incubation that consistently overruns. Use it when the protocol's stated times do not match the bench. Shows n, median and IQR per step and the effect on total duration; **writes nothing** unless you pass `accept` and then call save_program. Requires a login token.",
    events:
      "Propose new cue durations for one of the user's saved run-of-shows from how the previous events actually ran: median per cue as the default, 10th/90th percentiles as the range. Use it when the schedule always slips. Shows the evidence per cue and the effect on the total; **saves nothing** unless you pass `accept` and then call save_program. Requires a login token.",
    gym:
      "Propose new durations for one of the user's saved workouts from their recorded sessions: median per set or rest as the default, 10th/90th percentiles as the range. Use it when the planned session time never matches the real one. Shows the evidence and the effect on total time; **saves nothing** unless you pass `accept` and then call save_program. Requires a login token.",
  },
  list_public_runs: {
    generic:
      "List the runs other people have contributed for one exact program version: when each ran, how it ended, actual against planned total, and the variance factors that run was recorded with. Contribution is opt-in per run and contributed records carry no user id and no step notes, so this is anonymous, aggregate evidence about how long a program really takes. **No login needed.** Identify the program either by `program_hash` (`sha256:<hex>`, as `programVersion` in a run record) or by passing the `program` JSON, which is hashed here.",
    kitchen:
      "List the cooks other people have contributed for one exact version of a recipe: how long each really took against the plan, and what they reported (turkey weight, oven type, …). Use it before trusting a recipe's timings, or when the user asks 'how long does this actually take'. No login needed; contributed cooks are anonymous. Pass `program` (the recipe JSON) or `program_hash`.",
    lab:
      "List the contributed executions of one exact version of a protocol: actual against planned duration per run and the conditions each was run under. Use it to see whether an incubation's stated time holds up across labs. No login needed; contributed runs are anonymous. Pass `program` (the protocol JSON) or `program_hash`.",
    events:
      "List the contributed runs of one exact version of an event run-of-show: how each ran to time against the plan. No login needed; contributed runs are anonymous. Pass `program` or `program_hash`.",
    gym:
      "List the contributed sessions of one exact version of a workout: actual against planned duration per session. No login needed; contributed sessions are anonymous. Pass `program` or `program_hash`.",
  },
  search_public_recipes: {
    generic:
      "Search the public Rhylthyme catalog of cookable recipes, lab protocols, event templates, and workouts. Returns up to 50 matching programs (id, name, description, view URL) — no sign-in required. The catalog is split by environment: pass environment='kitchen' (default), 'laboratory', 'event' or 'gym' to pick the collection. Pass an id to **load_public_recipe** for the full schedule (its result already includes the live URL).",
    kitchen:
      "Search Rhylthyme's public-recipe catalog (tens of thousands of cookable recipes, all with structured ingredients and step timing). Use the moment the user wants to cook something and you don't yet have a specific recipe — search by name ('carbonara'), cuisine ('thai'), or ingredient ('chicken thigh'). Returns titles, ids, and short descriptions; pass an id to **cook_recipe** to go straight to a live timeline, or to **load_public_recipe** to read it first.",
    lab:
      "Search Rhylthyme's public-protocol catalog (laboratory protocols with structured steps, durations, and equipment). Use the moment the user wants to run a protocol and you don't yet have a specific one — search by technique ('Western blot'), assay ('ELISA'), or kit. Returns titles, ids, and short descriptions; pass an id to **run_protocol** to go straight to a live timeline, or to **load_public_recipe** to read it first.",
    events:
      "Search Rhylthyme's public-event-template catalog (wedding, conference, ceremony, launch, party, etc.). Use when the user wants to plan an event and you don't yet have a template — search by event type or style. Returns titles, ids, and short descriptions; pass an id to **plan_event** for a live run-of-show, or to **load_public_recipe** to read it first.",
    gym:
      "Search Rhylthyme's public-workout catalog (HIIT, strength splits, yoga flows, circuits, mobility, etc.). Use when the user wants to train and you don't yet have a workout — search by style ('HIIT'), body part ('push day'), or modality ('yoga'). Returns titles, ids, and short descriptions; pass an id to **start_workout** for a live training timeline, or to **load_public_recipe** to read it first.",
  },
  load_public_recipe: {
    generic:
      "Load a single public recipe / protocol / workout / event template by id. Returns a markdown summary plus a live-timeline URL (no visualize_schedule call needed).",
    kitchen:
      "Open a public recipe by id and return a markdown summary (total time, ingredients, schedule by track) plus the live-timeline URL the user can open on their phone. Use when the user wants to read what's in a recipe before cooking. For 'just cook it now', skip this and use **cook_recipe** directly.",
    lab:
      "Open a public lab protocol by id and return a markdown summary (steps, durations, equipment) plus the live-timeline URL. Use when the user wants to review the protocol before running it. For 'just run it now', skip this and use **run_protocol** directly.",
    events:
      "Open a public event template by id and return a markdown summary (tracks, cues, total run-of-show) plus the live-timeline URL. Use when the user wants to review the template before running. For 'just go', skip this and use **plan_event** directly.",
    gym:
      "Open a public workout by id and return a markdown summary (exercises, sets, rest, total time) plus the live-timeline URL. Use when the user wants to preview the workout before training. For 'just start it', skip this and use **start_workout** directly.",
  },
  save_program: {
    generic:
      "Save a Rhylthyme program to your account. If a program with the same programId already exists, it will be updated. Requires a login token.",
    kitchen:
      "Save a recipe to the user's personal cookbook. Use when the user says 'save this for later' or 'add this to my cookbook'. Requires a login token.",
    lab:
      "Save a protocol to the user's personal collection. Use when the user says 'save this protocol' or 'add this to my lab notebook'. Requires a login token.",
    events:
      "Save an event template to the user's personal collection. Use when the user says 'save this run-of-show' or 'keep this for later'. Requires a login token.",
    gym:
      "Save a workout to the user's personal training log. Use when the user says 'save this workout' or 'add this to my routine'. Requires a login token.",
  },
};

// ---------------------------------------------------------------------
// MCP tool annotations. Honest hints so hosts can auto-approve the
// read-only tools and confirm the ones that write.
// ---------------------------------------------------------------------

const ANN = {
  // Pure computation, no network, deterministic.
  pure:      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
  // Reads from rhylthyme.com / external catalogs.
  read:      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  // Creates a share row / saves to the user's account. Never deletes.
  publish:   { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
  // Upsert keyed on programId — safe to repeat.
  upsert:    { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
};

// ---------------------------------------------------------------------
// Zod schemas. Deliberately *loose*: zod strips unknown keys from plain
// z.object(), which used to silently drop metadata.thumbnail, step
// choices, replicates, trigger events and buffers before the program
// was shared. Everything the spec allows must survive the round-trip.
// ---------------------------------------------------------------------

const SecondsLike = z.union([z.number(), z.string()])
  .describe("Seconds as a number, or a time string like \"5m\", \"1h30m\", \"90s\".");

const SingleTrigger = z.looseObject({
  type: z.enum(["programStart", "programStartOffset", "afterStep", "afterStepWithBuffer", "manual", "onAbort"]).optional()
    .describe("programStart: at t=0. programStartOffset: offsetSeconds after t=0. afterStep: when stepId ends (or starts, with event='start') plus offsetSeconds. afterStepWithBuffer: after stepId ends plus bufferSeconds. manual: user taps to start. onAbort: only if stepId is aborted."),
  stepId: z.string().optional().describe("Referenced step (afterStep / afterStepWithBuffer / onAbort)."),
  event: z.enum(["start", "end"]).optional().describe("afterStep anchor: the referenced step's end (default) or start."),
  offsetSeconds: SecondsLike.optional().describe("Delay after the anchor. Negative values ('start 20m before X ends') require the referenced step to be indefinite."),
  bufferSeconds: SecondsLike.optional().describe("afterStepWithBuffer: gap after the referenced step ends."),
  choiceId: z.string().optional().describe("Only run this step if the user picked this option on the referenced step's choice."),
  triggerName: z.string().optional(),
});

const StartTrigger = SingleTrigger.extend({
  logic: z.enum(["all", "any"]).optional().describe("Compound trigger: wait for all / any of `triggers`."),
  triggers: z.array(SingleTrigger).optional(),
});

const Duration = z.looseObject({
  type: z.enum(["fixed", "variable", "indefinite"]).describe("fixed: exact seconds. variable: min/max with a default, user can end early. indefinite: runs until the user ends it (give defaultSeconds for planning)."),
  seconds: SecondsLike.optional(),
  minSeconds: SecondsLike.optional(),
  maxSeconds: SecondsLike.optional(),
  defaultSeconds: SecondsLike.optional(),
  triggerName: z.string().optional(),
});

const Replicates = z.looseObject({
  count: z.number().int().min(1),
  mode: z.enum(["parallel", "stagger", "serial"]).optional(),
  delay: SecondsLike.optional(),
});

const Step = z.looseObject({
  stepId: z.string().describe("Unique across the WHOLE program."),
  name: z.string(),
  description: z.string().optional(),
  task: z.string().optional().describe("Resource this step occupies; must match a resourceConstraints[].task."),
  tasks: z.array(z.string()).optional(),
  duration: Duration,
  startTrigger: StartTrigger,
  choice: z.looseObject({
    prompt: z.string().optional(),
    options: z.array(z.looseObject({ choiceId: z.string(), label: z.string().optional() })).min(2),
  }).optional().describe("Branch point: downstream steps with a matching choiceId only run for that option."),
  replicates: Replicates.optional(),
  canAbort: z.boolean().optional(),
});

const Track = z.looseObject({
  trackId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(Step),
  replicates: Replicates.optional(),
});

const ResourceConstraint = z.looseObject({
  task: z.string(),
  maxConcurrent: z.number().int().min(1),
  description: z.string().optional(),
});

const Metadata = z.looseObject({
  ingredients: z.array(z.looseObject({ name: z.string(), measure: z.string().optional() })).optional(),
  serves: z.union([z.string(), z.number()]).optional(),
  sourceUrl: z.string().optional(),
  attribution: z.string().optional(),
  thumbnail: z.string().optional(),
});

const Program = z.looseObject({
  schemaVersion: z.string().default("0.1.0"),
  programId: z.string().describe("Kebab-case identifier"),
  name: z.string().describe("Human-readable name"),
  description: z.string().optional(),
  environmentType: z.string().optional().describe("kitchen | laboratory | event | gym | bakery | manufacturing | general …"),
  environment: z.string().optional().describe("Optional environmentId whose resourceConstraints apply."),
  actors: z.number().int().optional().describe("How many people are available to work steps concurrently."),
  tracks: z.array(Track).min(1),
  resourceConstraints: z.array(ResourceConstraint).optional(),
  metadata: Metadata.optional(),
}).describe("Rhylthyme program JSON. Read rhylthyme://guide/authoring for the rules.");

// Loose program for read-only analysis tools: accept anything object-
// shaped so the validator (not zod) produces the actionable errors.
const AnyProgram = z.looseObject({}).describe("Rhylthyme program JSON (any shape — validation errors come back in the result, not as a schema rejection).");

// Output schemas (kept permissive; the SDK validates structuredContent
// against these on every call).
const Finding = z.looseObject({
  code: z.string(),
  message: z.string(),
  where: z.string().nullable(),
  fix: z.string().nullable(),
});
const ValidationOutput = {
  valid: z.boolean(),
  errors: z.array(Finding),
  warnings: z.array(Finding),
  info: z.array(Finding).optional(),
  stats: z.looseObject({}).nullable(),
};
const AnalysisOutput = {
  programId: z.string().nullable(),
  name: z.string().nullable(),
  makespanSeconds: z.number(),
  makespan: z.string(),
  tracks: z.array(z.looseObject({})),
  steps: z.array(z.looseObject({})),
  criticalPath: z.array(z.string()),
  // One entry per critical-path edge saying what gates it: an in-flight
  // cap (schema 0.3.0 `replicates.maxInFlight`), a saturated
  // maxConcurrent task, an explicit offset/buffer, or the dependency.
  bindingConstraints: z.array(z.looseObject({
    from: z.string(),
    to: z.string(),
    kind: z.string(),
  })).optional(),
  // Conflict items always carry `kind`: "maxConcurrent" | "inFlight".
  resourceConflicts: z.array(z.looseObject({})),
  // Per-replicated-step in-flight windows (empty unless maxInFlight is used).
  inFlight: z.array(z.looseObject({})).optional(),
  actorPeak: z.looseObject({}),
  wallClock: z.looseObject({}).nullable(),
  validation: z.looseObject({}).optional(),
  // Prediction from execution history (Phase 6). Present only when the call
  // supplied run records; without them the output is what it always was.
  // Per step the analysis also carries `plannedDurationSeconds` and, where
  // there is history, `predicted: {seconds, low, high, basis, n, …}` — both
  // inside the loose `steps` objects above.
  durationsUsed: z.string().optional()
    .describe("\"planned\" or \"predicted\": which duration set the makespan, itinerary, critical path and conflicts above were computed from."),
  plannedMakespanSeconds: z.number().optional(),
  plannedMakespan: z.string().optional(),
  predictedMakespanSeconds: z.number().optional(),
  predictedMakespan: z.string().optional(),
  predictedCriticalPath: z.array(z.string()).optional(),
};
const SearchOutput = {
  query: z.string(),
  environment: z.string().nullable(),
  count: z.number(),
  results: z.array(z.looseObject({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    url: z.string(),
  })),
};
const ShareOutput = {
  url: z.string(),
  shareId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  makespanSeconds: z.number(),
  warnings: z.array(Finding),
};

// ---------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------

function textResult(text, extra) {
  return Object.assign({ content: [{ type: "text", text }] }, extra || {});
}
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function loginRequired(what) {
  return errorResult(
    `${what} requires the user's Rhylthyme access token. Call **login** (no arguments) to get the sign-in URL, ` +
    "have the user paste the token back, then retry with `token` set. Public catalog tools (search_public_recipes, " +
    "load_public_recipe, validate_program, analyze_schedule, visualize_schedule) do not need a token."
  );
}
async function readErrorBody(resp) {
  try {
    const t = await resp.text();
    try { const j = JSON.parse(t); return j.error || t; } catch (_) { return t; }
  } catch (_) { return ""; }
}
function apiError(prefix, resp, body) {
  const msg = (body || "").toString().slice(0, 300);
  if (resp && (resp.status === 401 || resp.status === 403)) {
    return errorResult(`${prefix}: not authorized (${resp.status})${msg ? ` — ${msg}` : ""}. The token may have expired; call **login** again for a fresh one.`);
  }
  return errorResult(`${prefix} (${resp ? resp.status : "network"})${msg ? `: ${msg}` : ""}`);
}
function fetchOpts(extra, timeoutMs) {
  return Object.assign({ signal: AbortSignal.timeout(timeoutMs || FETCH_TIMEOUT_MS) }, extra || {});
}

// ---------------------------------------------------------------------
// CDN inliners. Kept for back-compat with the old inline-HTML path —
// not used by today's tool returns but cheap to keep around.
// ---------------------------------------------------------------------

let d3BundlePromise;
function getD3Bundle() {
  if (!d3BundlePromise) {
    d3BundlePromise = fetch("https://d3js.org/d3.v5.min.js")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`d3 fetch ${r.status}`))))
      .catch((e) => { d3BundlePromise = null; throw e; });
  }
  return d3BundlePromise;
}

let faCssPromise;
function getFontAwesomeCss() {
  if (!faCssPromise) {
    faCssPromise = (async () => {
      const FA_BASE = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0";
      const [cssResp, woffResp] = await Promise.all([
        fetch(`${FA_BASE}/css/all.min.css`),
        fetch(`${FA_BASE}/webfonts/fa-solid-900.woff2`),
      ]);
      if (!cssResp.ok) throw new Error(`fa css fetch ${cssResp.status}`);
      if (!woffResp.ok) throw new Error(`fa woff fetch ${woffResp.status}`);
      let css = await cssResp.text();
      const woffBuf = Buffer.from(await woffResp.arrayBuffer());
      const woffDataUri = "data:font/woff2;base64," + woffBuf.toString("base64");
      css = css.replace(
        /url\((['"]?)\.\.\/webfonts\/fa-solid-900\.woff2\1\)/g,
        function () { return "url(" + woffDataUri + ")"; },
      );
      css = css.replace(
        /url\((['"]?)\.\.\/webfonts\/[^)'"]+\1\)/g,
        "url(data:,)",
      );
      return css;
    })().catch((e) => { faCssPromise = null; throw e; });
  }
  return faCssPromise;
}

async function inlineCdnScripts(html) {
  try {
    const d3Source = await getD3Bundle();
    const safeD3 = d3Source.replace(/<\/script/gi, "\\x3c/script");
    html = html.replace(
      /<script\s+src="https:\/\/d3js\.org\/d3\.v5\.min\.js"><\/script>/,
      function () { return "<script>" + safeD3 + "</script>"; },
    );
  } catch (e) {
    console.error("Failed to inline D3:", e);
  }
  try {
    const faCss = await getFontAwesomeCss();
    html = html.replace(
      /<link\s+rel="stylesheet"\s+href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/6\.4\.0\/css\/all\.min\.css">/,
      function () { return "<style>" + faCss + "</style>"; },
    );
  } catch (e) {
    console.error("Failed to inline Font Awesome:", e);
  }
  return html;
}

// ---------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------

// Delegated to ../static/js/timeline-render.js (the open-sourced
// renderer). Re-exported as local symbols so callsites below don't
// have to change.
const computeStepTimings = TimelineRender.computeStepTimings;

// Makespan: the latest end across ALL steps once cross-track
// dependencies and offsets are resolved. (Used to be "longest track by
// summed durations", which under-reported any program with offsets or
// cross-track waits.)
function _programTotalSec(program) {
  const timings = computeStepTimings(program || {});
  let end = 0;
  for (const sid in timings) end = Math.max(end, timings[sid].end);
  return end;
}
function _fmtMinutes(seconds) {
  const m = Math.round((seconds || 0) / 60);
  if (m <= 0) return "—";
  if (m < 60) return m + "min";
  const h = Math.floor(m / 60), r = m % 60;
  return r === 0 ? h + "h" : (h + "h " + r + "min");
}

function _fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ":" + String(r).padStart(2, "0");
}

// Render a Gantt chart laid out by ACTUAL step start times, with step
// labels inline where they fit. Each row is one track; blocks within a
// row reflect the wall-clock position of each step.
//
// Example for a 28-min program:
//   Eggs           │░Boil eggs░░░░░░░░░░░░░░░░Ice░░░░Peel░│
//   Vegetables     │░░░Slice░░░Soak░░░░░░░░░░░░░░░░░Cucu░░│
//   Cream cheese   │░░Whip cream cheese░░░░░░             │
//   Toast bagels   │                          ░░░░Toast░░░│
//
// Renders inside a ``` block so monospace alignment holds in Claude
// Desktop's markdown rendering.
function renderAsciiGantt(program) {
  const tracks = (program.tracks || []).filter(t => (t.steps || []).length > 0);
  if (!tracks.length) return "";

  const timings = computeStepTimings(program);
  let globalEnd = 0;
  for (const sid in timings) globalEnd = Math.max(globalEnd, timings[sid].end);
  if (globalEnd <= 0) globalEnd = 1;

  const BAR = 48;            // bar width in columns
  const NAME = 14;           // left-side track name column

  const lines = [];
  // Time axis: 0 ... mid ... end (in minutes)
  const totalMin = Math.round(globalEnd / 60);
  const midMin = Math.round(totalMin / 2);
  const axisRow = " ".repeat(NAME + 2)
    + "0".padEnd(Math.floor(BAR / 2), " ")
    + (midMin + "m").padEnd(Math.ceil(BAR / 2) - 1, " ")
    + (totalMin + "m");
  lines.push(axisRow);

  for (const t of tracks) {
    const name = (t.name || "Track").slice(0, NAME).padEnd(NAME);
    // Build a character array for the bar so we can place labels.
    const bar = new Array(BAR).fill(" ");
    const sorted = (t.steps || [])
      .map(s => Object.assign({ ref: s }, timings[s.stepId] || { start: 0, end: 0, duration: 0 }))
      .filter(s => s.duration > 0)
      .sort((a, b) => a.start - b.start);

    sorted.forEach((s, i) => {
      const startCol = Math.max(0, Math.floor((s.start / globalEnd) * BAR));
      const endCol = Math.min(BAR, Math.max(startCol + 1, Math.floor((s.end / globalEnd) * BAR)));
      const span = endCol - startCol;
      const fill = (i % 2 === 0) ? "░" : "▒";
      // Lay the fill char.
      for (let c = startCol; c < endCol; c++) bar[c] = fill;
      // Inline label, truncated to span and padded with the fill char.
      const rawLabel = (s.ref.name || s.ref.stepId || "").replace(/\s+/g, " ").trim();
      if (rawLabel && span >= 4) {
        let lbl = rawLabel.length > span - 2 ? rawLabel.slice(0, Math.max(1, span - 3)) + "…" : rawLabel;
        // center the label in the span
        const pad = Math.max(0, Math.floor((span - lbl.length) / 2));
        for (let c = 0; c < lbl.length; c++) {
          const idx = startCol + pad + c;
          if (idx >= 0 && idx < BAR) bar[idx] = lbl[c];
        }
      }
    });
    lines.push(name + " │" + bar.join("") + "│");
  }
  return "```\n" + lines.join("\n") + "\n```";
}

// Render the program's Gantt as an SVG so we can return it as an
// `image` content block in the MCP response. Claude Desktop renders
// image content blocks natively, which sidesteps the "Claude
// paraphrased the markdown" problem — the visual is delivered as a
// rendered image, not as ASCII the model might compress.
// With a `run` (a `runs` schema record) the renderer draws planned-vs-actual:
// the plan as a thin ghost bar under each step's actual bar, outlined by the
// sign of its end deviation. Without one the output is unchanged.
function renderSvgGantt(program, run) {
  const svg = run && typeof run === "object"
    ? TimelineRender.renderTimelineSvg(program, { run })
    : TimelineRender.renderTimelineSvg(program);
  return svg || null;
}

// Wrap renderSvgGantt's output as an MCP image content block. Returns
// null when the program has no renderable Gantt (no tracks/steps).
//
// Claude Desktop's image content blocks support raster formats only —
// SVG payloads are silently dropped. We rasterize to PNG via
// @resvg/resvg-js (a small Rust-via-N-API SVG renderer) before
// handing the bytes off. If the renderer is unavailable (cold start,
// missing platform binary), we fall back to no image rather than
// failing the whole tool call.
function buildTimelineImageBlock(program, run) {
  const svg = renderSvgGantt(program, run);
  if (!svg) return null;
  try {
    const { Resvg } = require("@resvg/resvg-js");
    const resvg = new Resvg(svg, {
      // Render at a fixed 820px width to match the SVG's viewBox.
      // Resvg scales the rest proportionally.
      fitTo: { mode: "width", value: 820 },
      background: "#fafafa",
    });
    const png = resvg.render().asPng();
    return {
      type: "image",
      data: png.toString("base64"),
      mimeType: "image/png",
    };
  } catch (e) {
    // resvg failed to load or render — log but don't break the tool.
    // The markdown text block still ships, just without the picture.
    try { console.error("resvg render failed:", e && e.message); } catch (_) {}
    return null;
  }
}

// Combine the markdown summary text + the rendered timeline image
// into the standard MCP content-blocks array.
//
// Image delivery strategy (in priority order):
//   1. MCP `image` content block with base64 PNG — Claude Desktop
//      renders this inline. This is the canonical, trusted path.
//   2. Markdown image URL as a non-imperative caption inside the
//      text block — clients that render tool-result markdown
//      (Claude.ai web) will show it; others see a link.
//
// DO NOT add directives like "copy this line into your reply" —
// that is textbook prompt-injection style and well-aligned models
// correctly refuse to follow it. Image rendering must work via the
// MCP protocol's first-class image block, not by manipulating the
// model's output format from inside a tool result.
function buildPreviewContent(program, summaryText, opts) {
  opts = opts || {};
  const blocks = [];
  const image = buildTimelineImageBlock(program);
  if (opts.imageUrl) {
    // Plain caption — no instructions, no imperative language.
    summaryText = `[Timeline image: ${opts.imageUrl}]\n\n` + summaryText;
  }
  if (image) blocks.push(image);
  blocks.push({ type: "text", text: summaryText });
  return blocks;
}

// Build the OG-image URL for a shared program. Used by tools that
// already have a share_id (visualize_schedule, preview_timeline) to
// produce the markdown image URL Claude Desktop can render.
function ogTimelineUrlForShare(shareId, vertical) {
  if (!shareId) return null;
  const cfg = VERTICALS[vertical] || VERTICALS.generic;
  return `${cfg.hostBase}/api/og/timeline.png?share=${encodeURIComponent(shareId)}`;
}

// Build the OG-image URL for a public catalog program by id.
function ogTimelineUrlForProgram(programId, vertical) {
  if (!programId) return null;
  const cfg = VERTICALS[vertical] || VERTICALS.generic;
  return `${cfg.hostBase}/api/og/timeline.png?program=${encodeURIComponent(programId)}`;
}

// Create a share entry for an inline-built program so we get a stable
// public URL + PNG. Returns { shareId, url } or null on any failure.
async function createShareForProgram(program) {
  try {
    const resp = await fetch(`${API_BASE}/api/share`, fetchOpts({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ program }),
    }, 10000));
    if (!resp.ok) return null;
    const data = await resp.json();
    const shareId = data.share_id || data.shareId || data.id || null;
    return { shareId, url: data.url || (shareId ? `${API_BASE}?share=${shareId}` : null) };
  } catch (e) {
    return null;
  }
}

// Chronological itinerary: every step ordered by start time, with
// wall-clock start, duration, and which track it belongs to. The "do
// what at what time" view, complementary to the Gantt.
function renderItinerary(program) {
  const timings = computeStepTimings(program);
  const tracks = program.tracks || [];
  const events = [];
  tracks.forEach(t => {
    (t.steps || []).forEach(s => {
      const tim = timings[s.stepId];
      if (!tim || tim.duration <= 0) return;
      events.push({
        start: tim.start,
        duration: tim.duration,
        name: s.name || s.stepId,
        track: t.name || "Track",
      });
    });
  });
  if (!events.length) return "";
  events.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));

  // Compute padding for the time column and track column so the list
  // aligns nicely in monospace.
  const maxTime = events.reduce((m, e) => Math.max(m, _fmtClock(e.start).length), 0);
  const maxTrack = events.reduce((m, e) => Math.max(m, e.track.length), 0);

  const lines = [];
  events.forEach(e => {
    const time = _fmtClock(e.start).padStart(maxTime, " ");
    const track = ("[" + e.track + "]").padEnd(maxTrack + 2, " ");
    const dur = _fmtMinutes(e.duration);
    lines.push(`${time} ${track}  ${e.name}  _(${dur})_`);
  });
  return "```\n" + lines.join("\n") + "\n```";
}

// Render a Rhylthyme program JSON as a markdown summary the user can
// read inline in the chat. The goal is to make the tool result feel
// like a *preview* of what the live page would show — cover photo,
// description, equipment list, ingredient list, ASCII Gantt, itinerary,
// source attribution. Claude Desktop renders markdown images, so the
// cover photo lands inline; everything else lays out as text.
//
// Skips dumping the full JSON (which can run past Claude Desktop's
// tool-result cap) and gives Claude something short + structured to
// quote when the user asks follow-up questions.
function formatProgramSummary(program, shareUrl, opts) {
  opts = opts || {};
  const tracks = program.tracks || [];
  // Recipes use ``metadata``; some older programs use ``meta``. Check both.
  const md = program.metadata || {};
  const meta2 = program.meta || {};
  const ingredients = md.ingredients || meta2.ingredients || [];
  const serves = md.serves || meta2.serves;
  // Cover photo lives under a few possible keys depending on importer
  // (recipe-scrapers, themealdb, spoonacular, cooklang).
  const coverPhoto =
    md.thumbnail
    || md.coverPhoto
    || md.image
    || meta2.thumbnail
    || meta2.coverPhoto
    || (md.source && md.source.thumbnail);
  // Source URL + attribution for "Recipe from <site>" footer.
  const sourceUrl =
    md.sourceUrl
    || meta2.sourceUrl
    || (md.source && (md.source.url || md.source.sourceUrl))
    || (meta2.source && (meta2.source.url || meta2.source.sourceUrl));
  const attribution =
    md.attribution
    || meta2.attribution
    || (md.source && md.source.attribution)
    || (meta2.source && meta2.source.attribution);
  // Equipment / shared resources rendered in the live page's
  // "resourceConstraints" panel. Surface them here too — for cooking
  // it's "one oven, two burners"; for lab it's "two thermocyclers,
  // one centrifuge".
  const constraints = program.resourceConstraints || [];

  const totalSec = _programTotalSec(program);

  const lines = [];
  if (opts.heading) lines.push(opts.heading);
  lines.push(`# ${program.name || "Program"}`);

  // Cover photo right under the title. Markdown image is rendered by
  // Claude Desktop when the URL is publicly fetchable, which all
  // rhylthyme.com / supabase storage URLs are.
  if (coverPhoto) {
    const alt = String(program.name || "Cover photo").replace(/[\[\]]/g, "");
    lines.push("", `![${alt}](${coverPhoto})`);
  }

  if (program.description) {
    const desc = String(program.description).replace(/\s+/g, " ").trim().slice(0, 280);
    if (desc) lines.push("", `> ${desc}`);
  }

  // One-line meta row matching the live page's top stats.
  const metaParts = [`**Time:** ${_fmtMinutes(totalSec)}`, `**Tracks:** ${tracks.length}`];
  if (serves) metaParts.push(`**Serves:** ${serves}`);
  lines.push("", metaParts.join("  •  "));

  // Lead with the live-preview CTA so the user sees the URL near the
  // top — they may scroll right to it if the rest is irrelevant.
  if (shareUrl) {
    const cta = opts.ctaLabel || "Open live page";
    const hint = opts.ctaHint
      || "interactive timeline, real-time play/pause, parallel-track sync.";
    lines.push("", `🔗 **[${cta} ↗](${shareUrl})** — ${hint}`);
    lines.push("", _liveTour(opts.vertical || _guessVertical(shareUrl)));
  }

  // Equipment / shared resources.
  if (constraints.length) {
    const equipHeader = opts.equipmentLabel || "Equipment";
    lines.push("", `## ${equipHeader} (${constraints.length})`);
    constraints.slice(0, 20).forEach((rc) => {
      const label = rc.description || rc.task || "Resource";
      const cap = rc.maxConcurrent > 1 ? ` _(×${rc.maxConcurrent})_` : "";
      lines.push(`- ${label}${cap}`);
    });
    if (constraints.length > 20) lines.push(`- …and ${constraints.length - 20} more`);
  }

  if (ingredients.length) {
    // "Ingredients" is recipe-shaped, but the same metadata field is
    // overloaded in non-kitchen verticals. Header reflects what the
    // caller asked for.
    const ingHeader = opts.ingredientsLabel || "Ingredients";
    lines.push("", `## ${ingHeader} (${ingredients.length})`);
    ingredients.slice(0, 24).forEach((i) => {
      const part = [i.measure, i.name].filter(Boolean).join(" ").trim();
      if (part) lines.push(`- ${part}`);
    });
    if (ingredients.length > 24) lines.push(`- …and ${ingredients.length - 24} more`);
  }

  if (tracks.length) {
    const gantt = renderAsciiGantt(program);
    if (gantt) lines.push("", "## Timeline", "", gantt);
    const itinerary = renderItinerary(program);
    if (itinerary) lines.push("", "## Itinerary", "", itinerary);
  }

  if (opts.scheduleCheck) {
    lines.push("", "## Schedule check", "", opts.scheduleCheck);
  }

  // Source attribution footer.
  if (sourceUrl || attribution) {
    const label = attribution || sourceUrl;
    const url = sourceUrl || "";
    lines.push("", url
      ? `_Source: [${label}](${url})_`
      : `_Source: ${label}_`);
  }

  return lines.join("\n");
}

// Heuristic: pick the vertical from a share URL so default copy lines
// up. Falls back to "generic".
function _guessVertical(url) {
  if (!url) return "generic";
  if (url.indexOf("kitchen.rhylthyme.com") !== -1) return "kitchen";
  if (url.indexOf("lab.rhylthyme.com") !== -1) return "lab";
  if (url.indexOf("events.rhylthyme.com") !== -1) return "events";
  if (url.indexOf("gym.rhylthyme.com") !== -1) return "gym";
  return "generic";
}

// Per-vertical "what you'll see when you click" block. Spelled out so
// the user understands the link goes somewhere they can actually act
// from, not just a static page.
function _liveTour(vertical) {
  switch (vertical) {
    case "kitchen":
      return [
        "**When you open this URL** you'll see:",
        "- An **interactive Gantt timeline** with play/pause, set the speed, audio step cues",
        "- An **ingredient checklist** with strike-through as you use each one (works as a shopping list)",
        "- A **chronological itinerary** sorted by clock time across tracks",
        "- A **DAG view** showing step-to-step dependencies",
        "- Translate to your locale, save to your cookbook, share via link",
      ].join("\n");
    case "lab":
      return [
        "**When you open this URL** you'll see:",
        "- A **live protocol timeline** with stage timers and parallel-incubation sync",
        "- A **materials / reagents checklist**",
        "- **Equipment scheduling** so two protocols don't claim the same thermocycler",
        "- A **DAG view** of step dependencies",
        "- Save to your account or share with the lab",
      ].join("\n");
    case "events":
      return [
        "**When you open this URL** you'll see:",
        "- A **live run-of-show** with a real-time clock and cue list",
        "- **Cross-track sync** so ceremony / A-V / catering / music all align",
        "- A **DAG view** of dependencies between cues",
        "- Share the live timeline with the whole team",
      ].join("\n");
    case "gym":
      return [
        "**When you open this URL** you'll see:",
        "- A **live workout timeline** with set/rest timers and interval beeps",
        "- **Superset coordination** for paired exercises",
        "- A **DAG view** of dependencies between exercises",
        "- Save to your routine or share the session",
      ].join("\n");
    default:
      return [
        "**When you open this URL** you'll see:",
        "- An **interactive Gantt timeline** with play/pause, real-time timers, audio cues",
        "- A **chronological itinerary** sorted by clock time across tracks",
        "- A **DAG view** of step dependencies",
        "- Share via link or save to your account",
      ].join("\n");
  }
}

// Rewrite a www/bare rhylthyme.com URL to the right vertical subdomain.
// All subdomains serve the same Flask app and accept /p/<id> + /?share=<id>.
function verticalizeUrl(url, vertical) {
  if (!url) return url;
  const cfg = VERTICALS[vertical];
  if (!cfg || cfg.hostBase === API_BASE) return url;
  const subHost = cfg.hostBase.replace(/^https?:\/\//, "");
  return url.replace(/\/\/(www\.)?rhylthyme\.com/, "//" + subHost);
}

function programViewUrl(id, vertical) {
  const cfg = VERTICALS[vertical] || VERTICALS.generic;
  return `${cfg.hostBase}/p/${encodeURIComponent(id)}`;
}

// Per-vertical CTA copy on the "open timeline" link so it reads naturally.
const VIEWER_CTA = {
  generic: { label: "Open live timeline", hint: "interactive timeline, real-time play/pause, parallel-track sync." },
  kitchen: { label: "Open live cooking timeline", hint: "open on your phone to follow along with real-time timers, audio cues, and parallel track sync." },
  lab:     { label: "Open live protocol timeline", hint: "follow at the bench — real-time stage timers, equipment scheduling, parallel-step sync." },
  events:  { label: "Open live run-of-show", hint: "follow during the event — real-time clock, cue list, cross-track sync." },
  gym:     { label: "Open live workout timeline", hint: "follow during training — real-time set/rest timers, interval beeps, superset coordination." },
};

const INGREDIENTS_LABEL = {
  generic: "Ingredients / Materials",
  kitchen: "Ingredients",
  lab:     "Materials & Reagents",
  events:  "Resources & Vendors",
  gym:     "Equipment",
};

// Per-vertical equipment-section label. Cooking calls it "Equipment";
// lab calls it "Instruments"; events use "Resources"; gym uses "Stations".
const EQUIPMENT_LABEL = {
  generic: "Equipment / Resources",
  kitchen: "Equipment",
  lab:     "Instruments",
  events:  "Resources",
  gym:     "Stations",
};

function summaryOpts(vertical, extra) {
  const ctaCfg = VIEWER_CTA[vertical] || VIEWER_CTA.generic;
  return Object.assign({
    vertical: vertical,  // used by formatProgramSummary's _liveTour branch
    ctaLabel: ctaCfg.label,
    ctaHint: ctaCfg.hint,
    ingredientsLabel: INGREDIENTS_LABEL[vertical] || INGREDIENTS_LABEL.generic,
    equipmentLabel: EQUIPMENT_LABEL[vertical] || EQUIPMENT_LABEL.generic,
  }, extra || {});
}

// Fetch + summarize a public catalog program by id. Shared by
// load_public_recipe, the one-shot tools and the random tools.
async function loadPublicProgramContent(progId, vertical, heading) {
  const resp = await fetch(`${API_BASE}/api/public/programs/${encodeURIComponent(progId)}`, fetchOpts());
  if (!resp.ok) return apiError("Load error", resp, await readErrorBody(resp));
  const data = await resp.json();
  const program = data.program_json || {};
  if (!program.name && data.name) program.name = data.name;
  const url = programViewUrl(data.id || progId, vertical);
  const summary = formatProgramSummary(program, url, summaryOpts(vertical, heading ? { heading } : {}));
  const imageUrl = ogTimelineUrlForProgram(data.id || progId, vertical);
  return { content: buildPreviewContent(program, summary, { imageUrl }) };
}

// ---------------------------------------------------------------------
// Tool registrations. Each takes the server + the active vertical so it
// can tune descriptions and output URLs without per-call branching.
// ---------------------------------------------------------------------

function registerValidateProgram(server, vertical) {
  server.registerTool(
    "validate_program",
    {
      title: "Validate a program",
      description:
        "Check a Rhylthyme program for structural and scheduling errors BEFORE visualizing or saving it: missing/duplicate ids, dangling afterStep references, dependency cycles, steps that overlap within a track, tasks with no resourceConstraint, unparseable durations, invalid choice references, and schema 0.3.0-alpha `instances`/`replicates` misuse (E_INSTANCES_ON_SINGLE, E_EACH_WITH_REPLICATES, E_EACH_COUNT_MISMATCH, E_INFLIGHT_GT_COUNT, E_INFLIGHT_NO_CHAIN). Every finding has a `code`, a `message` and a `fix` hint — apply the fixes and re-run until `valid` is true. Warnings (e.g. tracks that finish far apart, W_UNBARRIERED_CHAIN) are advisory; `info` notes (I_IMPLICIT_BARRIER: a replicated step referenced without `instances`) suggest making a barrier explicit. Pure computation: no network, no side effects, safe to call repeatedly.",
      inputSchema: { program: AnyProgram },
      outputSchema: ValidationOutput,
      annotations: Object.assign({ title: "Validate a program" }, ANN.pure),
    },
    async ({ program }) => {
      const v = Schedule.validateProgram(program);
      return { content: [{ type: "text", text: Schedule.formatValidation(v) }], structuredContent: v };
    },
  );
}

function registerAnalyzeSchedule(server, vertical) {
  server.registerTool(
    "analyze_schedule",
    {
      title: "Analyze schedule timing",
      description:
        "Resolve a Rhylthyme program onto the clock and report what the live runner will do: every step's start/end (seconds from start and, if you pass `finishAt` or `startAt`, ISO wall-clock times), total makespan, the critical path, `bindingConstraints` (what gates each critical-path edge — an in-flight cap, a saturated task, an offset, or a plain dependency), resource conflicts tagged `kind: \"maxConcurrent\"` (more steps claim a task than its maxConcurrent allows) or `kind: \"inFlight\"` (more instances of a replicated step are between it and its barrier than `replicates.maxInFlight` allows), `inFlight` windows per replicated step, peak concurrency vs. declared actors, and per-track slack (instances get their own sub-track rows, tagged with `parentTrackId` / `instanceOf`). Use it to answer 'when do I start the potatoes so everything is ready at 6pm?' (pass finishAt), to find why a schedule is longer than expected (critical path and binding constraints — e.g. the cooling rack, not the oven), or to check equipment contention before visualizing. Pure computation; also returns validation findings so you can fix problems in the same turn.\n\n**Analysing against real history.** Pass `history` (run records from **load_run**, or from `rhylthyme runs` on disk) and every step with enough measurements gains `predicted: {seconds, low, high, basis, n}` beside its planned duration, plus top-level `predictedMakespan` and `predictedCriticalPath`. `basis` is `\"identical\"` (runs of the same program version, environment and variance factors — their median), `\"model\"` (a per-step regression on the factors that correlate) or `\"none\"` (no usable measurement). Simpler still: give `program_id` (a UUID from **list_my_programs**) plus `token` and the tool loads the caller's own recorded runs of that program for you. `useDurations: \"predicted\"` then recomputes the makespan, itinerary, critical path and conflicts from the predicted durations instead of the authored ones; the default stays `\"planned\"` so a program is analysed on what it says.",
      inputSchema: {
        program: AnyProgram,
        finishAt: z.string().optional().describe("ISO 8601 datetime the whole program should END at (e.g. '2026-11-26T18:00:00-05:00'). Start times are computed backwards from it."),
        startAt: z.string().optional().describe("ISO 8601 datetime the program STARTS at. Ignored when finishAt is given."),
        history: z.array(z.looseObject({})).optional()
          .describe("Recorded runs of this program (`runs` schema 0.1.0-alpha documents, as load_run returns them in `run`). Supplying them adds `predicted` per step and `predictedMakespan` / `predictedCriticalPath` to the result. Only runs that measure the executor count — completed, wall clock, speed 1 — and within them only steps a person ended, unpaused."),
        program_id: z.string().optional()
          .describe("Library program UUID: with `token` and no `history`, the caller's own recorded runs of this program are loaded and used as the history."),
        token: z.string().optional()
          .describe("Your Rhylthyme access token from the login tool. Only needed with `program_id`, to load your recorded runs; analysis itself needs no login."),
        predictionContext: z.looseObject({
          environmentId: z.string().optional().describe("Predict for this environment; runs recorded elsewhere are not \"identical\"."),
          userTags: z.looseObject({}).optional().describe("The variance factors of the run being planned, e.g. {\"turkeyKg\": 7, \"oven\": \"gas\"} — the values the model is evaluated at."),
          userId: z.string().optional().describe("Prefer this person's own runs for the identical-context lookup before falling back to everyone's."),
          programVersion: z.string().optional().describe("`sha256:<hex>` of the exact program JSON being planned; defaults to the hash of `program`."),
          minIdentical: z.number().int().optional().describe("Identical-context runs needed before their median is used (default 3)."),
          minModel: z.number().int().optional().describe("Measurements needed before a regression is fitted rather than a median (default 8)."),
          corrThreshold: z.number().optional().describe("Minimum |Pearson r| for a factor to enter the model (default 0.3)."),
          verdicts: z.looseObject({}).optional().describe("Inferentiality verdicts per step (`rhylthyme runs report`); a step marked executor-controlled gets no prediction."),
        }).optional()
          .describe("How to condition the prediction. Everything is optional; with none of it the lookup uses the program's own hash and the factors each run recorded."),
        useDurations: z.enum(["planned", "predicted"]).default("planned")
          .describe("Which duration set the makespan, wall-clock itinerary, critical path, conflicts and slack are computed from. \"planned\" (default) analyses the program as authored; \"predicted\" analyses it as history says it will actually run. Needs `history` (or `program_id` + `token`) to differ."),
      },
      outputSchema: AnalysisOutput,
      annotations: Object.assign({ title: "Analyze schedule timing" }, ANN.pure),
    },
    async ({ program, finishAt, startAt, history, program_id: progId, token, predictionContext, useDurations }) => {
      const v = Schedule.validateProgram(program);
      if (!v.stats) {
        return { content: [{ type: "text", text: Schedule.formatValidation(v) }], isError: true };
      }
      // Convenience: no `history` given, but the caller named one of their own
      // saved programs — load its recorded runs rather than making the model
      // round-trip through list_runs/load_run for every one of them.
      let records = Array.isArray(history) ? history : null;
      let historyNote = null;
      if (!records && progId && token) {
        const loaded = await loadOwnRuns(progId, token);
        if (loaded.error) return loaded.error;
        records = loaded.records;
        historyNote = loaded.note;
      }
      const a = Schedule.analyzeSchedule(program, {
        finishAt, startAt, history: records, predictionContext, useDurations,
      });
      a.validation = { valid: v.valid, errors: v.errors, warnings: v.warnings };
      const parts = [Schedule.formatAnalysis(a)];
      if (historyNote) parts.push("", historyNote);
      if (!v.valid) parts.push("", "⚠️ The program has validation errors; timings above assume the fallback placement (t=0) for unschedulable steps.", "", Schedule.formatValidation(v));
      else if (v.warnings.length) parts.push("", Schedule.formatValidation(v));
      // Compact itinerary with wall clock when anchored.
      if (a.wallClock) {
        const rows = a.steps.slice(0, 60).map((s) => `${s.startAt.replace("T", " ").slice(0, 16)}  ${s.name}  _(${Schedule._fmtDur(s.durationSeconds)}, ${s.trackId})_`);
        parts.push("", "**Wall-clock itinerary:**", "```", ...rows, a.steps.length > 60 ? `…and ${a.steps.length - 60} more` : "", "```");
      }
      return { content: [{ type: "text", text: parts.filter((x) => x !== undefined).join("\n") }], structuredContent: a };
    },
  );
}

function registerVisualizeSchedule(server, vertical) {
  server.registerTool(
    "visualize_schedule",
    {
      title: "Publish a live timeline",
      description: DESC.visualize_schedule[vertical],
      inputSchema: {
        program: Program,
        allowInvalid: z.boolean().default(false).describe("Publish even if validation reports errors. Only use when the user explicitly wants an imperfect draft shared; the live page may show wrong timings."),
      },
      outputSchema: ShareOutput,
      annotations: Object.assign({ title: "Publish a live timeline" }, ANN.publish),
    },
    async ({ program, allowInvalid }) => {
      const v = Schedule.validateProgram(program);
      if (!v.valid && !allowInvalid) {
        return errorResult(
          "Not published — the program has validation errors. Fix them and call visualize_schedule again " +
          "(or pass allowInvalid=true if the user explicitly wants a rough draft shared).\n\n" +
          Schedule.formatValidation(v),
        );
      }
      const analysis = Schedule.analyzeSchedule(program);
      let shareResp;
      try {
        shareResp = await fetch(`${API_BASE}/api/share`, fetchOpts({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ program }),
        }));
      } catch (e) {
        return errorResult(`Could not reach rhylthyme.com to create the share link: ${e.message || e}`);
      }
      if (!shareResp.ok) return apiError("Error creating share link", shareResp, await readErrorBody(shareResp));
      const shareData = await shareResp.json();
      const shareId = shareData.share_id || shareData.shareId || shareData.id || null;
      let shareUrl = shareData.url || (shareId ? `${API_BASE}?share=${shareId}` : API_BASE);
      shareUrl = verticalizeUrl(shareUrl, vertical);

      const checkLines = [Schedule.formatAnalysis(analysis)];
      if (!v.valid) checkLines.push("", "⚠️ Published with validation errors (allowInvalid):", "", Schedule.formatValidation(v));
      else if (v.warnings.length) checkLines.push("", Schedule.formatValidation(v));
      const summary = formatProgramSummary(program, shareUrl, summaryOpts(vertical, { scheduleCheck: checkLines.join("\n") }));
      const imageUrl = ogTimelineUrlForShare(shareId, vertical);
      return {
        content: buildPreviewContent(program, summary, { imageUrl }),
        structuredContent: {
          url: shareUrl,
          shareId,
          imageUrl,
          makespanSeconds: analysis.makespanSeconds,
          warnings: v.warnings,
        },
      };
    },
  );
}

// One line about what `enrich: true` did (or why it didn't), so the model
// knows whether the tracks it is looking at came from the importer or from
// the relationship pass, and which steps were inferred rather than read.
function enrichmentNote(enrichment) {
  if (!enrichment) return "";
  if (enrichment.error) {
    return "\n\n_Enrichment skipped: " + enrichment.error +
      " \u2014 this is the program the importer produced._";
  }
  const added = (enrichment.added || []).length;
  const changed = (enrichment.changed || []).length;
  return "\n\n_Enriched into " + (enrichment.tracks || "?") + " track(s): " +
    changed + " trigger(s) re-pointed, " + added + " inferred step(s) added" +
    (added ? " (marked `metadata.inferred`)" : "") + "._";
}

// The step -> source-span table an import_text result carries. The point
// of running extraction as its own turn is that every step can be traced
// back to the words it came from; a step with no span is one the model
// inferred (a preheat, a rest, a warm-up), and the editor -- and the user
// -- should be able to tell the two apart at a glance.
function spanTable(steps) {
  const rows = (steps || []).filter((s) => s && s.stepId);
  if (!rows.length) return "";
  const lines = rows.slice(0, 60).map((s) => {
    const span = s.sourceSpan;
    const quote = span && span.quote
      ? '"' + String(span.quote).replace(/\s+/g, " ").trim().slice(0, 90) + '"' +
        (span.occurrence && span.occurrence > 1 ? ` (occurrence ${span.occurrence})` : "")
      : (s.inferred ? "_inferred — not stated in the source_" : "_no span_");
    return `| \`${s.stepId}\` | ${s.name || ""} | ${quote.replace(/\|/g, "\\|")} |`;
  });
  const inferred = rows.filter((s) => s.inferred).length;
  return "\n\n**Where each step came from**\n\n| step | name | source |\n|---|---|---|\n" +
    lines.join("\n") +
    (rows.length > 60 ? `\n\n_(${rows.length - 60} more steps not shown)_` : "") +
    (inferred ? `\n\n${inferred} step(s) were inferred rather than read from the text; they carry \`metadata.inferred\`.` : "");
}

// The 2/1/0 scores for the read-back and the model-check turns: 2 first
// time, 1 after one retry, 0 never. Worth surfacing because a low score
// says the model misread the source, which is a different problem from a
// program that came out wrong.
function turnNote(turns, chunks) {
  if (!turns) return "";
  const parts = [`read-back ${turns.t1_score}/2`, `model check ${turns.t2_score}/2`];
  if (chunks && chunks > 1) parts.push(`source read in ${chunks} chunks`);
  return "\n\n_Turn scores: " + parts.join(", ") + "._";
}

function registerImportText(server, vertical) {
  server.registerTool(
    "import_text",
    {
      title: "Import pasted text",
      description: DESC.import_text[vertical],
      inputSchema: {
        text: z.string().describe(
          "The source text itself: the recipe, protocol, run sheet or plan, as the user wrote or pasted it. " +
          "Paste all of it — turn 1 reads it back and a long source is extracted in chunks.",
        ),
        environmentType: z.string().describe(
          "Where the work happens: kitchen, lab, events, gym, or generic. Fills the scenario prompt's " +
          "environment slot and becomes the program's environmentType.",
        ),
        deadline: z.string().optional().describe(
          "When everything must be finished, if the user said: \"18:00\", \"dinner at six\", an ISO datetime.",
        ),
        hints: z.string().optional().describe(
          "Equipment and people limits in the user's own words, e.g. 'one oven, two burners, one cook'. " +
          "Used as the scenario prompt's environment and as the resource constraints to expect.",
        ),
        token: z.string().optional().describe(
          "User's Rhylthyme access token from the **login** tool. Required: this import runs model calls on the server.",
        ),
      },
      annotations: Object.assign({ title: "Import pasted text" }, ANN.read),
    },
    async ({ text, environmentType, deadline, hints, token }) => {
      if (!token) return loginRequired("import_text");
      const body = (text || "").trim();
      if (!body) return errorResult("import_text needs `text` — the source to extract from.");
      try {
        const resp = await fetch(`${API_BASE}/api/import`, fetchOpts({
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "llm-text",
            text: body,
            environmentType: environmentType || "generic",
            deadline: deadline || undefined,
            hints: hints || undefined,
          }),
        }, 120000));
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          // The server names the turn that failed; pass that through so the
          // model can retry with a fuller source instead of guessing.
          const stage = data && data.stage ? ` (failed at ${data.stage})` : "";
          return apiError("Text import failed" + stage, resp, (data && data.error) || "");
        }
        if (data && data.error) return errorResult(`Text import failed: ${data.error}`);
        const program = data && data.program;
        if (!program || !program.tracks) return errorResult("The import returned no program JSON.");
        const v = Schedule.validateProgram(program);
        const summary = formatProgramSummary(program, null, summaryOpts(vertical, {
          scheduleCheck: v.valid
            ? Schedule.formatAnalysis(Schedule.analyzeSchedule(program))
            : Schedule.formatValidation(v),
        }))
          + turnNote(data.turns, data.chunks)
          + spanTable(data.steps)
          + "\n\nCall **visualize_schedule** with this program (below) to get the live-timeline URL.\n\n```json\n"
          + JSON.stringify(program) + "\n```";
        return { content: buildPreviewContent(program, summary, {}) };
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerImportFromSource(server, vertical) {
  server.registerTool(
    "import_from_source",
    {
      title: "Import from an external source",
      description: DESC.import_from_source[vertical],
      inputSchema: {
        source: z.enum([
          "themealdb", "protocolsio", "spoonacular", "cooklang", "opentrons", "benchling",
          // Pasted free text with no structure to read. `action` must be
          // 'import' and the text goes in `text`; the dedicated
          // **import_text** tool is the better door for it (it takes the
          // environment and the deadline, and reports the source span per
          // step), but the enum accepts it so a model that already has
          // this tool open does not have to switch.
          "llm-text",
        ]),
        action: z.enum(["search", "import", "random"]),
        query: z.string().optional().describe("Search keywords (search), or the URL / id to import (import)."),
        text: z.string().optional().describe("Raw source text (Opentrons .py) when the user pasted it instead of a URL."),
        // A structural importer reads structure, not meaning, so it
        // yields one track chained head-to-tail. `enrich` sends that step
        // list through turn 4 of the plan_schedule prompt server-side --
        // tracks, triggers, the question-refinement pattern -- and returns
        // a multi-track program. Costs a model call, so it is opt-in and
        // rate-limited; a failed enrichment still returns the import.
        enrich: z.boolean().optional()
          .describe(
            "Split the import into parallel tracks with cross-track triggers (action='import' only). " +
            "Runs the relationship turn of the plan_schedule prompt server-side against the imported " +
            "step list: steps, durations and resources are kept as imported, tracks and start triggers " +
            "are inferred, and any step the model adds is marked `metadata.inferred`. Costs a model call " +
            "and is capped per day; if it fails you still get the un-enriched program.",
          ),
        // `token` is the user's Rhylthyme access token (NOT the Benchling
        // token). rhylthyme.com gates import/random behind sign-in, and
        // Benchling needs it to look up the user's stored credentials.
        token: z.string().optional()
          .describe(
            "User's Rhylthyme access token from the **login** tool. " +
            "Required for action='import' and action='random' on every source, and for anything with source='benchling'. " +
            "Not needed for action='search' on public sources.",
          ),
      },
      annotations: Object.assign({ title: "Import from an external source" }, ANN.read),
    },
    async ({ source, action, query, text, token, enrich }) => {
      const authHeader = token
        ? { Authorization: "Bearer " + token, "Content-Type": "application/json" }
        : { "Content-Type": "application/json" };

      // ---- Benchling branch ----
      // Routes through the per-user, token-aware Rhylthyme endpoints
      // so the Benchling token never crosses the MCP boundary.
      if (source === "benchling") {
        if (!token) {
          return errorResult(
            "Benchling import requires a Rhylthyme access token (call **login** first, " +
            "then pass the token back as the `token` argument). Benchling itself uses the " +
            "API token the user stored at Rhylthyme → Settings → Benchling; this tool does NOT " +
            "accept a Benchling token directly.",
          );
        }
        try {
          if (action === "search") {
            const resp = await fetch(`${API_BASE}/api/mcp/benchling/search`, fetchOpts({
              method: "POST",
              headers: authHeader,
              body: JSON.stringify({ query: query || "", limit: 20 }),
            }));
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) return apiError("Benchling search failed", resp, data.error);
            const results = data.results || [];
            if (!results.length) {
              return textResult(`No Benchling protocols matched "${query || ""}".`);
            }
            const tenant = data.tenant || "(your tenant)";
            const lines = results.map((r, i) => {
              const desc = (r.description || "").replace(/\s+/g, " ").trim().slice(0, 140);
              return `${i + 1}. **${r.name}** — id \`${r.id}\`\n   ${desc}`;
            });
            return textResult(
              `Found ${results.length} Benchling protocol${results.length === 1 ? "" : "s"} on ` +
              `\`${tenant}.benchling.com\`${query ? ` matching "${query}"` : ""}:\n\n` +
              lines.join("\n\n") +
              "\n\nPick an id and call **import_from_source** again with " +
              "`{source: 'benchling', action: 'import', query: '<id>', token}` to " +
              "convert it into a Rhylthyme program, then call **visualize_schedule**.",
            );
          }
          if (action === "import") {
            const idOrUrl = (query || text || "").trim();
            if (!idOrUrl) return errorResult("Provide a Benchling protocol id or URL in `query`.");
            const body = idOrUrl.startsWith("http")
              ? { url: idOrUrl }
              : { protocol_id: idOrUrl };
            const resp = await fetch(`${API_BASE}/api/mcp/benchling/import`, fetchOpts({
              method: "POST",
              headers: authHeader,
              body: JSON.stringify(body),
            }, 30000));
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) return apiError("Benchling import failed", resp, data.error);
            const program = data.program;
            if (!program) return errorResult("Benchling returned no program JSON.");
            // Build a viewer URL on the right vertical so the inline
            // summary's CTA opens at lab.rhylthyme.com (or wherever
            // the active MCP endpoint serves).
            const url = data.source_url || "";
            const summary = formatProgramSummary(program, url, summaryOpts(vertical))
              + "\n\nCall **visualize_schedule** with this program to share a live-timeline URL.";
            const share = await createShareForProgram(program);
            const imageUrl = share && share.shareId ? ogTimelineUrlForShare(share.shareId, vertical) : null;
            return { content: buildPreviewContent(program, summary, { imageUrl }) };
          }
          return errorResult(
            "`random` isn't supported for source='benchling' — your Benchling library is " +
            "private, not a public catalog. Use action='search' to browse, then 'import' " +
            "to pull a specific protocol.",
          );
        } catch (e) {
          return errorResult(`Error: ${e.message || e}`);
        }
      }

      // ---- All other sources ----
      // rhylthyme.com requires a signed-in user for import + random
      // (search is open). Say so up front instead of surfacing a raw 401.
      if ((action === "import" || action === "random") && !token) {
        return loginRequired(`import_from_source action='${action}'`);
      }
      if (action === "search" && !query) {
        return errorResult("action='search' needs `query` (keywords to search for).");
      }
      if (action === "import" && !query && !text) {
        return errorResult("action='import' needs `query` (URL or id) or `text` (pasted source).");
      }
      try {
        let url, options;
        if (action === "search") {
          url = `${API_BASE}/api/import/search`;
          options = { method: "POST", headers: authHeader, body: JSON.stringify({ source, query }) };
        } else if (action === "import") {
          url = `${API_BASE}/api/import`;
          const body = { source };
          if (query) body.query = query;
          if (text) body.text = text;
          if (enrich) body.enrich = true;
          options = { method: "POST", headers: authHeader, body: JSON.stringify(body) };
        } else {
          url = `${API_BASE}/api/import/random`;
          options = { method: "POST", headers: authHeader, body: JSON.stringify({ source }) };
        }
        const resp = await fetch(url, fetchOpts(options, 30000));
        if (!resp.ok) return apiError(`Import ${action} failed`, resp, await readErrorBody(resp));
        const data = await resp.json();
        if (data && data.error) return errorResult(`Import ${action} failed: ${data.error}`);
        // import/random return { program }: summarize it like every other
        // program-shaped result and remind the model of the next step.
        if (data && data.program && data.program.tracks) {
          const program = data.program;
          const v = Schedule.validateProgram(program);
          const summary = formatProgramSummary(program, null, summaryOpts(vertical, {
            scheduleCheck: v.valid ? Schedule.formatAnalysis(Schedule.analyzeSchedule(program)) : Schedule.formatValidation(v),
          })) + enrichmentNote(data.enrichment)
            + "\n\nCall **visualize_schedule** with this program (below) to get the live-timeline URL.\n\n```json\n"
            + JSON.stringify(program) + "\n```";
          return { content: buildPreviewContent(program, summary, {}) };
        }
        return textResult(JSON.stringify(data, null, 2));
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerCreateEnvironment(server, vertical) {
  server.registerTool(
    "create_environment",
    {
      title: "Define equipment limits",
      description: DESC.create_environment[vertical],
      inputSchema: {
        name: z.string(),
        type: z.enum(["kitchen", "laboratory", "bakery", "airport", "restaurant", "manufacturing", "hospital", "workshop", "event", "gym", "general"]),
        description: z.string().optional(),
        actors: z.number().int().min(1).optional().describe("How many people can work at once (default 1)."),
        resourceConstraints: z.array(z.looseObject({
          task: z.string(),
          maxConcurrent: z.number().int().min(1),
          description: z.string().optional(),
        })).min(1),
      },
      annotations: Object.assign({ title: "Define equipment limits" }, ANN.pure),
    },
    async ({ name, type, description, actors, resourceConstraints }) => {
      const envId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const env = { environmentId: envId, name, description: description || "", type, resourceConstraints, actors: actors || 1 };
      const summary = resourceConstraints.map((rc) => `  - ${rc.task}: max ${rc.maxConcurrent}`).join("\n");
      return textResult(
        `Environment "${name}" defined.\n\n**Type:** ${type}\n**Actors:** ${env.actors}\n**Resources:**\n${summary}\n\n` +
        "Copy `resourceConstraints` into the program (and set each step's `task` to one of these names), then run **validate_program**.\n\n" +
        `\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\``,
      );
    },
  );
}

function registerLogin(server, vertical) {
  server.registerTool(
    "login",
    {
      title: "Connect Rhylthyme account",
      description: DESC.login[vertical],
      inputSchema: {
        token: z.string().optional().describe(
          "Paste the access token shown on the login page after you sign in. Leave empty on the first call to get the login URL.",
        ),
      },
      annotations: Object.assign({ title: "Connect Rhylthyme account" }, ANN.read),
    },
    async ({ token }) => {
      if (!token) {
        return textResult(
          `To connect your Rhylthyme account, open this URL in your browser:\n\n**${API_BASE}/mcp/auth**\n\nSign in with Google, Apple, or email. Then copy the token shown on the page and call this tool again with it.`,
        );
      }
      try {
        const resp = await fetch(`${API_BASE}/api/mcp/programs`, fetchOpts({
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        }, 10000));
        if (!resp.ok) {
          return errorResult("Token verification failed. Please visit the login page again and copy a fresh token.");
        }
        const data = await resp.json();
        const count = (data.programs || []).length;
        return textResult(
          `Logged in successfully! You have ${count} saved program${count !== 1 ? "s" : ""}. Use **list_my_programs** to see them, **save_program** to save a new schedule, or pass this token to **import_from_source**.`,
        );
      } catch (e) {
        return errorResult(`Login failed: ${e.message || e}`);
      }
    },
  );
}

function registerListMyPrograms(server, vertical) {
  server.registerTool(
    "list_my_programs",
    {
      title: "List my saved programs",
      description: DESC.list_my_programs[vertical],
      inputSchema: { token: z.string().describe("Your Rhylthyme access token from the login tool") },
      annotations: Object.assign({ title: "List my saved programs" }, ANN.read),
    },
    async ({ token }) => {
      try {
        const resp = await fetch(`${API_BASE}/api/mcp/programs`, fetchOpts({
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        }));
        if (!resp.ok) return apiError("Could not list programs", resp, await readErrorBody(resp));
        const data = await resp.json();
        const programs = data.programs || [];
        if (programs.length === 0) {
          return textResult("You don't have any saved programs yet. Create a schedule and use **save_program** to save it to your account.");
        }
        const list = programs
          .map((p) => `- **${p.name}** (${p.program_id || "no-id"})\n  ID: \`${p.id}\` | Environment: ${p.environment || "general"} | Updated: ${p.updated_at?.slice(0, 10) || "?"}`)
          .join("\n");
        return textResult(
          `You have ${programs.length} saved program${programs.length !== 1 ? "s" : ""}:\n\n${list}\n\nUse **load_program** with the ID to retrieve the full schedule.`,
        );
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerLoadProgram(server, vertical) {
  server.registerTool(
    "load_program",
    {
      title: "Open a saved program",
      description: DESC.load_program[vertical],
      inputSchema: {
        token: z.string().describe("Your Rhylthyme access token"),
        program_id: z.string().describe("The program UUID from list_my_programs"),
      },
      annotations: Object.assign({ title: "Open a saved program" }, ANN.read),
    },
    async ({ token, program_id: progId }) => {
      try {
        const resp = await fetch(`${API_BASE}/api/mcp/programs/${encodeURIComponent(progId)}`, fetchOpts({
          headers: { Authorization: "Bearer " + token },
        }));
        if (!resp.ok) return apiError("Could not load program", resp, await readErrorBody(resp));
        const data = await resp.json();
        const url = programViewUrl(data.id || progId, vertical);
        const program = data.program_json || {};
        if (!program.name && data.name) program.name = data.name;
        const summary = formatProgramSummary(program, url, summaryOpts(vertical));
        const imageUrl = ogTimelineUrlForProgram(data.id || progId, vertical);
        return { content: buildPreviewContent(program, summary, { imageUrl }) };
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

// ---------------------------------------------------------------------
// Execution history. A run record (runs schema 0.1.0-alpha) is written by
// a runtime — the web player, the CLI runner — and stored beside the
// program in the user's library. Both tools are thin wrappers over the
// Flask endpoints; runs are private to the person who ran them.
// See plans/execution-history-duration-prediction.md Phase 3.
// ---------------------------------------------------------------------

function _runDeviation(planned, actual) {
  if (typeof planned !== "number" || typeof actual !== "number" || planned <= 0) return "";
  const pct = Math.round(((actual - planned) / planned) * 100);
  if (pct === 0) return " (on plan)";
  return ` (${pct > 0 ? "+" : ""}${pct} %)`;
}

// Load the caller's own run records for one saved program, whole (not the
// summary rows list_runs renders): `?full=1` on the same endpoint asks Flask
// to include each row's run_json. Returns
// `{ records, note }` or `{ error }` (an MCP error result, ready to return).
// Shared by analyze_schedule's `program_id` convenience and by
// calibrate_program.
async function loadOwnRuns(progId, token) {
  let resp;
  try {
    resp = await fetch(
      `${API_BASE}/api/mcp/programs/${encodeURIComponent(progId)}/runs?full=1`,
      fetchOpts({ headers: { Authorization: "Bearer " + token } }),
    );
  } catch (e) {
    return { error: errorResult(`Could not reach rhylthyme.com to load your runs: ${e.message || e}`) };
  }
  if (!resp.ok) return { error: apiError("Could not load your recorded runs", resp, await readErrorBody(resp)) };
  let data;
  try { data = await resp.json(); } catch (e) { data = {}; }
  const rows = (data && data.runs) || [];
  const records = rows.map((r) => r && r.run).filter((r) => r && typeof r === "object");
  const note = records.length
    ? `_History: ${records.length} recorded run${records.length === 1 ? "" : "s"} of this program, loaded from your library._`
    : "_No recorded runs of this program yet, so there is nothing to predict from — the planned durations are all there is._";
  return { records, note };
}

function registerListRuns(server, vertical) {
  server.registerTool(
    "list_runs",
    {
      title: "List recorded runs",
      description: DESC.list_runs[vertical],
      inputSchema: {
        program_id: z.string().describe("The program UUID from list_my_programs or the program's URL"),
        token: z.string().optional().describe("Your Rhylthyme access token from the login tool"),
      },
      annotations: Object.assign({ title: "List recorded runs" }, ANN.read),
    },
    async ({ program_id: progId, token }) => {
      if (!token) return loginRequired("list_runs");
      try {
        const resp = await fetch(
          `${API_BASE}/api/mcp/programs/${encodeURIComponent(progId)}/runs`,
          fetchOpts({ headers: { Authorization: "Bearer " + token } }),
        );
        if (!resp.ok) return apiError("Could not list runs", resp, await readErrorBody(resp));
        const data = await resp.json();
        const runs = data.runs || [];
        if (runs.length === 0) {
          return textResult(
            "No runs recorded for this program yet. Runs are written when somebody plays the " +
            "live timeline to the end (or stops part-way) while signed in, and by `rhylthyme run` " +
            "in the terminal.",
          );
        }
        const lines = runs.map((r) => {
          const when = (r.startedAt || "").replace("T", " ").replace(/\..*$/, "").replace("Z", " UTC");
          const plan = _fmtMinutes(r.plannedMakespanSeconds);
          const act = _fmtMinutes(r.actualMakespanSeconds);
          const flags = [];
          if (r.pausedSeconds) flags.push(`paused ${_fmtMinutes(r.pausedSeconds)}`);
          if (r.speed && Number(r.speed) !== 1) flags.push(`${r.speed}× speed`);
          if (r.clockMode && r.clockMode !== "wall") flags.push(r.clockMode + " clock");
          return `- **${when}** — ${r.outcome} · actual ${act} vs planned ${plan}` +
            _runDeviation(r.plannedMakespanSeconds, r.actualMakespanSeconds) +
            (flags.length ? ` · ${flags.join(", ")}` : "") +
            `\n  Run ID: \`${r.id}\` (${r.runtime || "?"}, ${r.steps} steps)`;
        });
        return textResult(
          `${runs.length} recorded run${runs.length !== 1 ? "s" : ""} for this program, newest first:\n\n` +
          lines.join("\n") +
          "\n\nUse **load_run** with a Run ID for the planned-vs-actual detail per step.",
        );
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerLoadRun(server, vertical) {
  server.registerTool(
    "load_run",
    {
      title: "Open a recorded run",
      description: DESC.load_run[vertical],
      inputSchema: {
        run_id: z.string().describe("The run UUID from list_runs"),
        token: z.string().optional().describe("Your Rhylthyme access token from the login tool"),
      },
      annotations: Object.assign({ title: "Open a recorded run" }, ANN.read),
    },
    async ({ run_id: runId, token }) => {
      if (!token) return loginRequired("load_run");
      try {
        const resp = await fetch(
          `${API_BASE}/api/mcp/runs/${encodeURIComponent(runId)}`,
          fetchOpts({ headers: { Authorization: "Bearer " + token } }),
        );
        if (!resp.ok) return apiError("Could not load run", resp, await readErrorBody(resp));
        const data = await resp.json();
        const record = data.run || {};
        const rt = record.runtime || {};
        const head = [
          `## Run ${record.runId || runId}`,
          "",
          `- Program: \`${record.programId || "?"}\` (${record.programVersion || "no hash"})`,
          `- Started: ${record.startedAt || "?"}${record.endedAt ? ` · ended ${record.endedAt}` : ""}`,
          `- Outcome: **${record.outcome || "?"}** · ${rt.kind || "?"} ${rt.version || ""}`.trim() +
            ` · ${rt.clockMode || "?"} clock · ${rt.speed === undefined ? 1 : rt.speed}× speed`,
          `- Makespan: actual ${_fmtMinutes(data.actualMakespanSeconds)} vs planned ${_fmtMinutes(data.plannedMakespanSeconds)}` +
            _runDeviation(data.plannedMakespanSeconds, data.actualMakespanSeconds),
        ];
        const tags = (record.context || {}).userTags || {};
        const tagKeys = Object.keys(tags);
        if (tagKeys.length) head.push(`- Recorded factors: ${tagKeys.map((k) => `${k}=${tags[k]}`).join(", ")}`);
        const rows = (record.steps || []).map((s) => {
          const planned = s.planned || {};
          const actual = s.actual || {};
          const pd = typeof planned.end === "number" && typeof planned.start === "number"
            ? planned.end - planned.start : null;
          const ad = typeof actual.end === "number" && typeof actual.start === "number"
            ? actual.end - actual.start : null;
          const name = s.stepId + (s.instance && s.instance > 1 ? ` [${s.instance}]` : "");
          return `| ${name} | ${planned.durationType || "?"} | ${_fmtMinutes(pd)} | ${ad === null ? "—" : _fmtMinutes(ad)}` +
            `${_runDeviation(pd, ad)} | ${s.endedBy || (actual.start === undefined ? "never started" : "still running")}` +
            ` | ${s.pausedSeconds ? _fmtMinutes(s.pausedSeconds) : "—"} |`;
        });
        const table = rows.length
          ? ["", "| Step | Kind | Planned | Actual | Ended by | Paused |", "|---|---|---|---|---|---|", ...rows].join("\n")
          : "\n(no steps recorded)";
        return textResult(head.join("\n") + "\n" + table +
          "\n\nOnly steps a person ended (`endedBy: executor`), unpaused, at speed 1, in a completed run " +
          "measure how long the work really takes." +
          "\n\nTo see it: call **preview_timeline** with this program and `run` set to the run record above " +
          "for a planned-versus-actual picture, or **calibrate_program** to turn these measurements into " +
          "proposed durations.");
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

// ---------------------------------------------------------------------
// Calibration (Phase 5). A read-only tool over POST /api/mcp/calibrate:
// the server proposes durations from the caller's recorded runs, and this
// renders the proposal. It never saves. `accept` asks the server to write the
// accepted values into a *copy* of the program and hand it back; keeping it
// is a separate, explicit **save_program** call the user has to want.
// ---------------------------------------------------------------------

// One duration as one cell: "min–default–max" for a range, else the number.
// The CLI's `describe_values`.
function _describeDuration(values) {
  if (!values || typeof values !== "object") return "—";
  if (values.type === "fixed" || values.seconds !== undefined) return _fmtMinutes(values.seconds);
  const low = values.minSeconds, def = values.defaultSeconds, high = values.maxSeconds;
  if (low === undefined && high === undefined) return _fmtMinutes(def);
  return [low, def, high].map((v) => (v === undefined || v === null ? "—" : _fmtMinutes(v))).join("–");
}

function _fmtSigned(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return "—";
  const m = Math.round(seconds / 60);
  if (m === 0) return "±0min";
  return (m > 0 ? "+" : "−") + _fmtMinutes(Math.abs(m) * 60);
}

const CALIBRATE_REASONS = {
  "insufficient-runs": "fewer than k measured runs",
  "fixed-duration": "fixed duration: history only confirms the timer",
  "no-measurements": "no measurements in the recorded runs",
  "not-in-program": "measured, but no such step in the program any more",
  "not-a-duration-object": "duration is a bare number or time string",
};

// The per-step table + the effect line, the same shape `rhylthyme calibrate`
// prints in the terminal.
function formatCalibration(proposal, calibrated) {
  const rows = proposal.steps || [];
  const proposed = rows.filter((r) => r.status === "proposed");
  const notes = rows.filter((r) => r.status === "note");
  const lines = [];
  lines.push(`## Calibration proposal: ${proposal.programId || "(unknown program)"}`);
  lines.push("");
  const excluded = (proposal.runsExcluded || []).length;
  lines.push(
    `Runs: **${proposal.runsUsable}** usable of ${proposal.runsConsidered}` +
    (excluded ? ` (${excluded} excluded: paused, scaled, simulated or unfinished)` : "") +
    `; k=${proposal.minRuns}, range from P${proposal.lowPercentile}/P${proposal.highPercentile} widened to the author's.`,
  );
  lines.push(
    `Proposed: **${proposed.length} step${proposed.length === 1 ? "" : "s"}**` +
    (notes.length ? `; notes on ${notes.length} fixed step${notes.length === 1 ? "" : "s"}` : "") +
    `; as of ${proposal.asOf}.`,
  );
  lines.push("");
  lines.push("| Step | Type | n | Current | Proposed | Median | IQR | Delta | Note |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  rows.forEach((r) => {
    const ev = r.evidence || {};
    const note = r.status === "note"
      ? `${r.note} (lag ${_fmtSigned(ev.lagSeconds)})`
      : (r.status === "proposed" ? (r.verdict || "") : (CALIBRATE_REASONS[r.reason] || r.reason || ""));
    lines.push([
      r.stepId,
      r.durationType || "—",
      r.n,
      _describeDuration(ev.current),
      r.status === "proposed" ? _describeDuration(ev.proposed) : "—",
      ev.median === null || ev.median === undefined ? "—" : _fmtMinutes(ev.median),
      ev.iqr === null || ev.iqr === undefined ? "—" : _fmtMinutes(ev.iqr),
      r.status === "proposed" ? _fmtSigned(ev.deltaSeconds) : "—",
      note,
    ].join(" | ").replace(/^/, "| ") + " |");
  });
  lines.push("");
  const effect = proposal.effect || {};
  if (!Object.keys(effect).length) {
    lines.push("**Effect if accepted:** not computed.");
  } else if (!(effect.acceptedSteps || []).length) {
    lines.push(`**Effect if accepted:** nothing to accept; makespan stays ${_fmtMinutes(effect.makespanBeforeSeconds)}.`);
  } else {
    lines.push(
      `**Effect if accepted:** makespan ${_fmtMinutes(effect.makespanBeforeSeconds)} → ` +
      `${_fmtMinutes(effect.makespanAfterSeconds)} (${_fmtSigned(effect.makespanDeltaSeconds)}); ` +
      (effect.criticalPathChanged
        ? `critical path changes to ${(effect.criticalPathAfter || []).join(" → ")}.`
        : "critical path unchanged."),
    );
  }
  lines.push("");
  if (calibrated) {
    lines.push(
      "**Nothing has been saved.** The calibrated program is in `structuredContent.program` " +
      "(each changed duration carries `calibratedFrom: {runs, asOf, programVersion}`). Call " +
      "**save_program** with it to keep it, after showing the user what changed.",
    );
  } else if (proposed.length) {
    lines.push(
      "**Nothing has been written.** Call calibrate_program again with " +
      "`accept: [\"" + proposed.map((r) => r.stepId).join("\", \"") + "\"]` (or `\"all\"`) to get the " +
      "calibrated program back, then **save_program** to keep it.",
    );
  } else {
    lines.push("Nothing to accept yet. A step needs " + proposal.minRuns +
      " runs it was ended by hand in, unpaused, at speed 1, before history can propose a number for it.");
  }
  return lines.join("\n");
}

function registerCalibrateProgram(server, vertical) {
  server.registerTool(
    "calibrate_program",
    {
      title: "Propose durations from recorded runs",
      description: DESC.calibrate_program[vertical],
      inputSchema: {
        program: AnyProgram.optional()
          .describe("The program JSON to calibrate. Omit it and `program_id`'s saved JSON is used, so the usual call is just an id."),
        program_id: z.string().optional()
          .describe("Library program UUID (from list_my_programs). Names the program whose recorded runs are the evidence, and — with no `program` — the JSON to calibrate."),
        history: z.array(z.looseObject({})).optional()
          .describe("Run records to use instead of the ones stored against `program_id` (`runs` schema 0.1.0-alpha)."),
        k: z.number().int().min(1).optional()
          .describe("Measurements a step needs before it gets a proposal (default 5). A step under it is reported as skipped with its statistics, not silently dropped."),
        since: z.string().optional()
          .describe("Only runs started on or after this date (YYYY-MM-DD or ISO), e.g. to calibrate on the last month's cooks only."),
        accept: z.union([z.literal("all"), z.array(z.string())]).optional()
          .describe("Step ids to accept, or \"all\". The result then also carries the calibrated program with `calibratedFrom` beside each written duration. NOTHING IS SAVED either way — pass that program to save_program if the user wants it kept."),
        token: z.string().optional().describe("Your Rhylthyme access token from the login tool"),
      },
      annotations: Object.assign({ title: "Propose durations from recorded runs" }, ANN.read),
    },
    async ({ program, program_id: progId, history, k, since, accept, token }) => {
      if (!token) return loginRequired("calibrate_program");
      if (!progId && !(program && typeof program === "object")) {
        return errorResult("Pass `program_id` (a UUID from list_my_programs) or the `program` JSON to calibrate.");
      }
      if (!progId && !Array.isArray(history)) {
        return errorResult(
          "Pass `program_id` so the recorded runs can be found, or `history` with the run records themselves. " +
          "Calibration is a function of a program and its runs; without runs there is nothing but the author's guess.",
        );
      }
      const body = {};
      if (program && typeof program === "object") body.program = program;
      if (progId) body.programId = progId;
      if (Array.isArray(history)) body.history = history;
      if (k !== undefined) body.k = k;
      if (since) body.since = since;
      if (accept !== undefined) body.accept = accept;
      let resp;
      try {
        resp = await fetch(`${API_BASE}/api/mcp/calibrate`, fetchOpts({
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(body),
        }, 30000));
      } catch (e) {
        return errorResult(`Could not reach rhylthyme.com to calibrate: ${e.message || e}`);
      }
      if (!resp.ok) return apiError("Could not calibrate", resp, await readErrorBody(resp));
      let data;
      try { data = await resp.json(); } catch (e) { data = null; }
      const proposal = data && data.proposal;
      if (!proposal || !Array.isArray(proposal.steps)) {
        return errorResult("The calibrate endpoint returned no proposal.");
      }
      return {
        content: [{ type: "text", text: formatCalibration(proposal, data.program || null) }],
        structuredContent: data,
      };
    },
  );
}

// ---------------------------------------------------------------------
// The public run catalog (Phase 4). A contributed run is a run record
// somebody opted to publish: notes removed, no user id, keyed only by the
// canonical hash of the program JSON that was run. No login needed, because
// there is nobody to authenticate as — the rows belong to no one.
// ---------------------------------------------------------------------

const PROGRAM_HASH_RE = /^sha256:[0-9a-f]{64}$/;

// Fourth twin of rhylthyme_cli_runner/history/hash.py, after
// rhylthyme-timeline/tools/hash-program.js and the copy inlined in
// src/element.js. Inlined here for the same reason it is inlined there:
// this file is byte-mirrored into rhylthyme-mcp and must not import
// anything that lives outside mcp-api/ and static/.
function _compareCodePoints(a, b) {
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next(), nb = ib.next();
    if (na.done && nb.done) return 0;
    if (na.done) return -1;
    if (nb.done) return 1;
    const ca = na.value.codePointAt(0), cb = nb.value.codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}
function _canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(_canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort(_compareCodePoints);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + _canonicalJson(value[k])).join(",") + "}";
}
function _programVersion(program) {
  const crypto = require("crypto");
  return "sha256:" + crypto.createHash("sha256").update(_canonicalJson(program), "utf8").digest("hex");
}

function _median(values) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function registerListPublicRuns(server, vertical) {
  server.registerTool(
    "list_public_runs",
    {
      title: "List contributed runs",
      description: DESC.list_public_runs[vertical],
      inputSchema: {
        program_hash: z.string().optional()
          .describe("Canonical program hash, \"sha256:\" plus 64 hex characters — the programVersion field of a run record, or programs.program_hash."),
        program: AnyProgram.optional()
          .describe("The program JSON to look up instead of a hash; it is hashed here with the same canonical hash the runtimes record."),
        limit: z.number().int().min(1).max(200).optional()
          .describe("How many contributed runs to return, newest first (default 50)."),
      },
      annotations: Object.assign({ title: "List contributed runs" }, ANN.read),
    },
    async ({ program_hash: programHash, program, limit }) => {
      let hash = (programHash || "").trim();
      if (!hash && program && typeof program === "object") {
        try { hash = _programVersion(program); } catch (e) { hash = ""; }
      }
      if (!PROGRAM_HASH_RE.test(hash)) {
        return errorResult(
          "Pass either `program_hash` (\"sha256:\" plus 64 hex characters, from a run record's " +
          "programVersion) or the `program` JSON to hash. Contributed runs are keyed by the exact " +
          "program JSON that was run, so an edited program has no history until it is run again.",
        );
      }
      try {
        const url = `${API_BASE}/api/public/runs?programHash=${encodeURIComponent(hash)}` +
          (limit ? `&limit=${encodeURIComponent(limit)}` : "");
        const resp = await fetch(url, fetchOpts());
        if (!resp.ok) return apiError("Could not list contributed runs", resp, await readErrorBody(resp));
        const data = await resp.json();
        const runs = data.runs || [];
        if (runs.length === 0) {
          return textResult(
            `No contributed runs for program version \`${hash}\` yet.\n\n` +
            "Contribution is opt-in per run and keyed by the exact program JSON, so a program that " +
            "has been edited since it was last run starts again from nothing. The planned durations " +
            "are all there is to go on for now.",
          );
        }
        const lines = runs.map((r) => {
          const when = (r.startedAt || "").replace("T", " ").replace(/\..*$/, "").replace("Z", " UTC");
          const flags = [];
          if (r.pausedSeconds) flags.push(`paused ${_fmtMinutes(r.pausedSeconds)}`);
          if (r.speed && Number(r.speed) !== 1) flags.push(`${r.speed}× speed`);
          if (r.clockMode && r.clockMode !== "wall") flags.push(`${r.clockMode} clock`);
          const tags = r.userTags || {};
          const tagKeys = Object.keys(tags);
          if (tagKeys.length) flags.push(tagKeys.map((k) => `${k}=${tags[k]}`).join(", "));
          return `- **${when}** — ${r.outcome} · actual ${_fmtMinutes(r.actualMakespanSeconds)} vs planned ` +
            `${_fmtMinutes(r.plannedMakespanSeconds)}` +
            _runDeviation(r.plannedMakespanSeconds, r.actualMakespanSeconds) +
            (flags.length ? ` · ${flags.join(" · ")}` : "");
        });
        const medianActual = _median(runs.map((r) => r.actualMakespanSeconds));
        const planned = _median(runs.map((r) => r.plannedMakespanSeconds));
        const summary = medianActual === null
          ? ""
          : `\n\nMedian actual total across ${runs.length} contributed run${runs.length !== 1 ? "s" : ""}: ` +
            `**${_fmtMinutes(medianActual)}** against a planned ${_fmtMinutes(planned)}` +
            _runDeviation(planned, medianActual) + ".";
        return textResult(
          `${runs.length} contributed run${runs.length !== 1 ? "s" : ""} of program version \`${hash}\`, ` +
          "newest first:\n\n" + lines.join("\n") + summary +
          "\n\nContributed runs are anonymous: no account, no step notes, only timings and the " +
          "variance factors each executor reported. Runs that were paused, or played faster than " +
          "real time, measure the timer rather than the work.",
        );
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerSearchPublicRecipes(server, vertical) {
  const envFilter = VERTICALS[vertical].envFilter;
  // Verticals default to their own envFilter so generic queries don't
  // mix in unrelated content; user can still pass another. The catalog
  // API itself defaults to "kitchen" when no environment is given, so
  // the generic endpoint says so instead of pretending to search all.
  const envValues = ["kitchen", "laboratory", "gym", "event", "events"];
  const envSchema = envFilter
    ? z.enum(envValues).default(envFilter).describe(`Defaults to "${envFilter}" on this endpoint.`)
    : z.enum(envValues).default("kitchen").describe("Which catalog to search. Defaults to \"kitchen\"; use \"laboratory\", \"event\" or \"gym\" for the other collections.");

  const nextHint = (() => {
    switch (vertical) {
      case "kitchen": return "Pick an id and call **cook_recipe** (one-shot, opens timeline) or **load_public_recipe** (preview first).";
      case "lab":     return "Pick an id and call **run_protocol** (one-shot, opens timeline) or **load_public_recipe** (preview first).";
      case "events":  return "Pick an id and call **plan_event** (one-shot, opens run-of-show) or **load_public_recipe** (preview first).";
      case "gym":     return "Pick an id and call **start_workout** (one-shot, opens timeline) or **load_public_recipe** (preview first).";
      default:        return "Pick an id and call **load_public_recipe** — its result includes the live-timeline URL.";
    }
  })();

  server.registerTool(
    "search_public_recipes",
    {
      title: "Search the public catalog",
      description: DESC.search_public_recipes[vertical],
      inputSchema: {
        query: z.string().describe("Keyword to search (matches name and description). Empty returns the most recent entries.").default(""),
        environment: envSchema,
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: SearchOutput,
      annotations: Object.assign({ title: "Search the public catalog" }, ANN.read),
    },
    async ({ query, environment, limit }) => {
      const env = environment || envFilter || "kitchen";
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (env) params.set("environment", env);
      if (limit) params.set("limit", String(limit));
      try {
        const resp = await fetch(`${API_BASE}/api/public/search?${params.toString()}`, fetchOpts());
        if (!resp.ok) return apiError("Search failed", resp, await readErrorBody(resp));
        const data = await resp.json();
        const rows = data.results || [];
        const structured = {
          query: query || "",
          environment: env || null,
          count: rows.length,
          results: rows.map((r) => ({
            id: String(r.id),
            name: r.name || "",
            description: r.description ? String(r.description).replace(/\s+/g, " ").trim().slice(0, 240) : null,
            url: programViewUrl(r.id, vertical),
          })),
        };
        if (!rows.length) {
          const verticalLabel = env || "program";
          return {
            content: [{
              type: "text",
              text:
                `No public ${verticalLabel} programs found for "${query}". **Next step:** build the program yourself, run **validate_program**, then call **visualize_schedule** to deliver an inline + shareable timeline — do NOT describe the schedule in prose. The user explicitly wants a visual timeline.`,
            }],
            structuredContent: structured,
          };
        }
        const lines = structured.results.map((r, i) => {
          const desc = (r.description || "").slice(0, 120);
          return `${i + 1}. **${r.name}** — id \`${r.id}\` · [view](${r.url})\n   ${desc}`;
        });
        return {
          content: [{
            type: "text",
            text: `Found ${rows.length} public program${rows.length === 1 ? "" : "s"}${query ? ` for "${query}"` : ""}:\n\n${lines.join("\n\n")}\n\n${nextHint}`,
          }],
          structuredContent: structured,
        };
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerLoadPublicRecipe(server, vertical) {
  server.registerTool(
    "load_public_recipe",
    {
      title: "Open a public program",
      description: DESC.load_public_recipe[vertical],
      inputSchema: { program_id: z.string().describe("Program UUID (from search_public_recipes)") },
      annotations: Object.assign({ title: "Open a public program" }, ANN.read),
    },
    async ({ program_id: progId }) => {
      try {
        return await loadPublicProgramContent(progId, vertical);
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerSaveProgram(server, vertical) {
  server.registerTool(
    "save_program",
    {
      title: "Save to my account",
      description: DESC.save_program[vertical],
      inputSchema: {
        token: z.string().describe("Your Rhylthyme access token"),
        program: Program,
      },
      annotations: Object.assign({ title: "Save to my account" }, ANN.upsert),
    },
    async ({ token, program }) => {
      const v = Schedule.validateProgram(program);
      if (!v.valid) {
        return errorResult("Not saved — fix these validation errors first:\n\n" + Schedule.formatValidation(v));
      }
      try {
        const resp = await fetch(`${API_BASE}/api/mcp/save`, fetchOpts({
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ program }),
        }));
        if (!resp.ok) return apiError("Save failed", resp, await readErrorBody(resp));
        const data = await resp.json();
        const url = data.id ? programViewUrl(data.id, vertical) : null;
        return textResult(
          `Saved **${data.name}** to your account!\n\nID: \`${data.id}\`\nProgram ID: ${data.program_id}` +
          (url ? `\n\n🔗 [Open it](${url})` : "") +
          `\n\nUse **list_my_programs** to see all your saved programs.`,
        );
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

// ---------------------------------------------------------------------
// Vertical-specific tools. One pair per vertical, registered only on
// that vertical's endpoint. Implementation is shared — the only
// per-vertical bits are tool name, description, and copy.
// ---------------------------------------------------------------------

function registerOneShotTool(server, vertical) {
  const cfg = VERTICALS[vertical];
  if (!cfg || !cfg.oneShot) return;
  const oneShot = cfg.oneShot;
  server.registerTool(
    oneShot.name,
    {
      title: oneShot.title,
      description: oneShot.description,
      inputSchema: { query: z.string().describe(oneShot.argLabel) },
      annotations: Object.assign({ title: oneShot.title }, ANN.read),
    },
    async ({ query }) => {
      const q = (query || "").trim();
      if (!q) return errorResult(oneShot.missingQuery);
      try {
        const searchParams = new URLSearchParams({ q, limit: "1" });
        if (cfg.envFilter) searchParams.set("environment", cfg.envFilter);
        const searchResp = await fetch(`${API_BASE}/api/public/search?${searchParams.toString()}`, fetchOpts());
        if (!searchResp.ok) return apiError("Search error", searchResp, await readErrorBody(searchResp));
        const searchData = await searchResp.json();
        const top = (searchData.results || [])[0];
        if (!top) return textResult(oneShot.noMatch(q));
        return await loadPublicProgramContent(top.id, vertical, oneShot.headingFor(q));
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerRandomTool(server, vertical) {
  const cfg = VERTICALS[vertical];
  if (!cfg || !cfg.random) return;
  const random = cfg.random;
  server.registerTool(
    random.name,
    {
      title: random.title,
      description: random.description,
      inputSchema: {},
      annotations: Object.assign({ title: random.title }, ANN.read, { idempotentHint: false }),
    },
    async () => {
      try {
        const randomParams = new URLSearchParams();
        if (cfg.envFilter) randomParams.set("environment", cfg.envFilter);
        const randomResp = await fetch(`${API_BASE}/api/programs/random?${randomParams.toString()}`, fetchOpts());
        if (!randomResp.ok) return apiError("Random pick failed", randomResp, await readErrorBody(randomResp));
        const pick = await randomResp.json();
        if (!pick || !pick.id) return errorResult(random.noResult);
        return await loadPublicProgramContent(pick.id, vertical, random.headingFor());
      } catch (e) {
        return errorResult(`Error: ${e.message || e}`);
      }
    },
  );
}

function registerPreviewTimeline(server, vertical) {
  server.registerTool(
    "preview_timeline",
    {
      title: "Preview timeline image",
      description:
        "Render a Rhylthyme program as a static Gantt-chart image so the user can SEE what the live timeline looks like, without committing to opening the live URL. Use this when the user asks for a 'preview' or 'picture' of the timeline, or when you have just built a freehand program and want to give the user a visual before they commit. The tool returns ONLY an image plus a one-line caption — no recipe prose, no ingredient list, no copyright concerns. Just the structural visualization of which step runs when on which track.\n\nPair with **visualize_schedule** when the user wants the full shareable interactive URL too. This tool is for the visual-only quick preview case.\n\n**Planned versus actual.** Pass `run` — a recorded run of the same program, as **load_run** returns it in `run` — and the picture becomes a comparison: each step's real bar over a thin ghost bar at its planned position, outlined green where it finished early and amber where it ran late. That is the fastest way to show a person where a plan drifted.\n\n**Rendering option for HTML-artifact-capable clients (Claude.ai etc.):** Claude.ai's artifact sandbox blocks external scripts from non-cdnjs sources, so a `<script src=\"https://kitchen.rhylthyme.com/...\">` tag will fail. To render the timeline yourself with the official Rhylthyme look, call **get_renderer_source** first to fetch the renderer's full source as a string, then embed that source verbatim inside a `<script>…</script>` block in your HTML artifact, followed by your program JSON and a call to `Rhylthyme.renderTimeline(document.getElementById('t'), program)`. The renderer is open-source (Apache-2.0), zero-dependency, ~9KB.",
      inputSchema: {
        program: AnyProgram.describe("Rhylthyme program JSON (same shape visualize_schedule accepts)."),
        run: z.looseObject({}).optional()
          .describe("Optional recorded run of the SAME program (`runs` schema 0.1.0-alpha — the `run` object from load_run). Draws planned-vs-actual: the actual bars over ghost bars at the planned positions, coloured by the sign of each step's end deviation."),
      },
      annotations: Object.assign({ title: "Preview timeline image" }, ANN.publish),
    },
    async ({ program, run }) => {
      const tracks = (program && program.tracks) || [];
      const stepCount = tracks.reduce((n, t) => n + ((t && t.steps) || []).length, 0);
      if (!tracks.length || !stepCount) {
        return errorResult("Couldn't render a timeline — the program has no tracks/steps. Add at least one track with steps and try again.");
      }
      const totalSec = _programTotalSec(program);
      const hasRun = !!(run && typeof run === "object" && Array.isArray(run.steps) && run.steps.length);
      const caption =
        `**${program.name || "Timeline"}** — ${tracks.length} track${tracks.length === 1 ? "" : "s"}, `
        + `${stepCount} step${stepCount === 1 ? "" : "s"}, ${_fmtMinutes(totalSec)} total. `
        + (hasRun
          ? `Planned versus actual for run \`${run.runId || "?"}\`: the thin ghost bar is the plan, the solid bar what happened. `
          : "")
        + `Call **visualize_schedule** with the same program to get a shareable URL.`;
      // Always include the MCP `image` content block — that's the
      // canonical path Claude Desktop renders. Pair with a markdown
      // image URL caption so clients that render tool-result markdown
      // (Claude.ai web) also get an inline preview. No directives
      // telling the model how to format its reply — that reads as
      // prompt injection and gets correctly refused.
      const image = buildTimelineImageBlock(program, hasRun ? run : null);
      // The OG endpoint renders the program alone, so a planned-vs-actual
      // preview has no URL twin: the image block is the whole picture.
      const share = hasRun ? null : await createShareForProgram(program);
      const captionWithImage = share && share.shareId
        ? `[Timeline image: ${ogTimelineUrlForShare(share.shareId, vertical)}]\n\n${caption}`
        : caption;
      if (image) {
        return { content: [image, { type: "text", text: captionWithImage }] };
      }
      return { content: [{ type: "text", text: captionWithImage }] };
    },
  );
}

// Cache the renderer source after first fetch. We pull it from our
// own CDN (same Vercel project, different output dir) rather than
// trying to read it from the function's filesystem — function
// bundles don't include the static/ tree by default.
let _rendererSourceCache = null;
async function getRendererSource() {
  if (_rendererSourceCache !== null) return _rendererSourceCache;
  try {
    const resp = await fetch(
      `${API_BASE}/static/js/timeline-render.js`,
      fetchOpts({}, 8000),
    );
    if (resp.ok) {
      _rendererSourceCache = await resp.text();
      return _rendererSourceCache;
    }
  } catch (e) { /* fall through */ }
  // The module is bundled with the function too (we require() it), so
  // fall back to reading it from disk when the CDN is unreachable.
  try {
    const fs = require("fs");
    const path = require("path");
    _rendererSourceCache = fs.readFileSync(path.join(__dirname, "..", "static", "js", "timeline-render.js"), "utf8");
    return _rendererSourceCache;
  } catch (e) { /* fall through */ }
  _rendererSourceCache = "";
  return "";
}

function registerGetRendererSource(server, vertical) {
  server.registerTool(
    "get_renderer_source",
    {
      title: "Get timeline renderer source",
      description:
        "Returns the source code of the open-source Rhylthyme timeline renderer (Apache-2.0, ~9KB, zero dependencies). Use this when you're building an HTML artifact and the artifact sandbox blocks external scripts (e.g., Claude.ai's CSP only allows cdnjs.cloudflare.com). The returned text is plain JavaScript with a UMD wrapper — paste it verbatim inside a `<script>…</script>` block in your artifact, then call `Rhylthyme.renderTimeline(container, program)` where `program` is the Rhylthyme program JSON. After this call, the global `Rhylthyme` object exposes: `renderTimeline(container, program)`, `renderTimelineSvg(program)`, `computeStepTimings(program)`, `parseSeconds(value)` and `stepDurationSeconds(step)`.",
      inputSchema: {},
      annotations: Object.assign({ title: "Get timeline renderer source" }, ANN.read),
    },
    async () => {
      const src = await getRendererSource();
      if (!src) return errorResult("Renderer source unavailable on this deployment.");
      return textResult(src);
    },
  );
}

// ---------------------------------------------------------------------
// Resources: the schema, an authoring cheat-sheet and complete example
// programs. Hosts that support resources (Claude Desktop, Claude Code,
// the Agent SDK) let the model pull these on demand instead of
// re-deriving the format from tool descriptions.
// ---------------------------------------------------------------------

const AUTHORING_GUIDE = `# Rhylthyme program authoring guide

A program describes a real-time, multi-track process. The live runner
(rhylthyme.com) turns it into timers, cues and a shared clock.

## Shape

\`\`\`json
{
  "schemaVersion": "0.3.0-alpha",
  "programId": "kebab-case-id",
  "name": "Human title",
  "description": "optional",
  "environmentType": "kitchen | laboratory | event | gym | manufacturing | general",
  "actors": 1,
  "tracks": [
    { "trackId": "t1", "name": "Station / dish / instrument / performer",
      "steps": [
        { "stepId": "s1", "name": "Do the thing", "task": "oven",
          "duration": { "type": "fixed", "seconds": 600 },
          "startTrigger": { "type": "programStart" } },
        { "stepId": "s2", "name": "Next thing", "task": "prep",
          "duration": { "type": "variable", "minSeconds": 60, "maxSeconds": 300, "defaultSeconds": 120 },
          "startTrigger": { "type": "afterStep", "stepId": "s1" } }
      ] }
  ],
  "resourceConstraints": [ { "task": "oven", "maxConcurrent": 1 }, { "task": "prep", "maxConcurrent": 2 } ],
  "metadata": { "ingredients": [ { "name": "eggs", "measure": "2" } ], "serves": "4", "sourceUrl": "", "attribution": "" }
}
\`\`\`

## Rules the validator enforces

1. \`stepId\` is unique across the WHOLE program (not just the track).
2. Steps in one track run sequentially and must not overlap. The first
   step usually uses \`programStart\`; every later step chains with
   \`{"type":"afterStep","stepId":"<previous step>"}\`. Parallel work goes
   in separate tracks.
3. Every \`task\` used by a step needs a \`resourceConstraints\` entry
   with the same name (unless the program references an \`environment\`
   or declares \`actors\`). This includes steps inside an
   \`instances: "each"\` chain: every instance claims the same task, so
   one constraint entry covers them, but it must exist.
4. Durations: \`fixed\` needs \`seconds\`; \`variable\` needs \`minSeconds\`
   + \`maxSeconds\` (+ \`defaultSeconds\` for planning); \`indefinite\` runs
   until the user ends it (give \`defaultSeconds\` so previews look right).
   Numbers are seconds; strings like \`"5m"\`, \`"1h30m"\`, \`"90s"\` also work.
5. \`afterStep\` references must point at existing steps and must not form
   a cycle.
6. \`instances\` may only reference a replicated step (or a step already
   replicated by an \`"each"\` chain); an \`"each"\` step must not declare
   its own \`replicates\`; \`maxInFlight\` must be <= \`count\`. See
   "Repeating work" below for the codes.

## Triggers

| type                 | fields                                   | meaning                                            |
|----------------------|------------------------------------------|----------------------------------------------------|
| programStart         | —                                        | at t = 0                                           |
| programStartOffset   | offsetSeconds                            | at t = offset                                      |
| afterStep            | stepId, offsetSeconds?, event?, choiceId?, instances? | when stepId ends (event="start": when it starts) + offset |
| afterStepWithBuffer  | stepId, bufferSeconds, instances?        | when stepId ends + buffer                          |
| manual               | triggerName?                             | user taps to start                                 |
| onAbort              | stepId                                   | only if stepId is aborted                          |
| compound             | logic: "all" \\| "any", triggers: [...]   | wait for all / the first of several triggers       |

Negative \`offsetSeconds\` ("start 20 min before the roast finishes")
requires the referenced step to be \`indefinite\`. \`instances\`
(\`"each" | "all" | "any"\`, default \`"all"\`) only applies when the
referenced step is replicated — see "Repeating work" below.

## Finishing together

To make every track end at the same moment, compute each track's length
and delay the shorter ones with \`programStartOffset\`, or chain them
\`afterStep\` off a step in the long track. \`analyze_schedule\` reports
per-track slack; pass \`finishAt\` to get wall-clock start times.

## Repeating work: per-instance chains, barriers and in-flight limits

### \`replicates\`: do this step n times

\`replicates\` on a step says "do this n times" without copying JSON:

\`\`\`json
"replicates": { "count": 3, "mode": "serial", "delay": "5m", "maxInFlight": 2 }
\`\`\`

- \`count\` — how many instances. Expansion names them \`<stepId>-r1\` …
  \`<stepId>-r<n>\` and stamps \`instanceOf\` / \`instanceIndex\` on each.
- \`mode\` — \`serial\` (one after another, in the same track), \`parallel\`
  (all at once, each instance in its own sub-track), \`stagger\` (each
  start \`delay\` after the previous one).
- \`delay\` — the gap for \`stagger\` (\`"5m"\`, \`"90s"\`, or seconds).
- \`maxInFlight\` — the work-in-progress cap; see below.

### \`instances\`: per instance, every instance, or the first

A trigger that references a replicated step says how it joins.
\`instances\` goes on \`afterStep\` / \`afterStepWithBuffer\` (including
inside \`compound\`):

| instances        | meaning                                                                                 |
|------------------|-----------------------------------------------------------------------------------------|
| \`"all"\` (default) | one step that waits for EVERY instance — the barrier; this is what pre-0.3.0 programs already do, so leaving \`instances\` off never changes an existing schedule |
| \`"each"\`         | the step is itself replicated, once per instance: instance i starts when instance i of the referenced step ends (\`offsetSeconds\` / \`bufferSeconds\` / \`event: "start"\` all still apply) |
| \`"any"\`          | one step that starts when the FIRST instance ends                                       |

\`"each"\` is transitive and inherits the count — never declare
\`replicates\` on an \`"each"\` step. \`"all"\` and \`"any"\` collapse the chain
back into a single step, which downstream steps then reference without
\`instances\`. A \`compound\` may pair two \`"each"\` upstreams only if they
have the same \`count\`.

### \`maxInFlight\`: hold upstream, don't strand downstream

\`maxConcurrent\` (on \`resourceConstraints\`) caps how many steps occupy
one task at one instant. \`maxInFlight\` (on \`replicates\`) caps how many
instances are *between* the replicated step and its barrier — a chain
across time. Instance i is in flight from its start until instance i has
finished every \`"each"\` descendant; instance i + \`maxInFlight\` may not
start before that.

Reach for \`maxInFlight\` whenever the limit is a holding area rather than
a machine: a cooling rack that holds two trays, a rotor that holds six
tubes, a taxiway that holds four aircraft, a bench with room for four
open plates. \`"rack", maxConcurrent: 2\` alone would let the third tray
bake anyway and then make it queue for a rack slot — a hot tray with
nowhere to go. \`maxInFlight: 2\` holds the *bake* instead.

With \`mode: "parallel"\` a \`maxInFlight\` below \`count\` turns the fan-out
into a rolling window; with \`mode: "stagger"\` the delay becomes a
minimum gap.

### Worked example: three trays, one oven, a rack that holds two

<!-- rhylthyme:example cookies-three-trays -->
\`\`\`json
{
  "schemaVersion": "0.3.0-alpha",
  "programId": "cookies-three-trays",
  "name": "Three trays, one oven",
  "environmentType": "kitchen",
  "tracks": [
    { "trackId": "cookies", "name": "Cookies", "steps": [
      { "stepId": "mix", "name": "Mix dough", "task": "prep",
        "duration": { "type": "fixed", "seconds": 900 },
        "startTrigger": { "type": "programStart" } },
      { "stepId": "bake", "name": "Bake tray", "task": "oven",
        "duration": { "type": "fixed", "seconds": 720 },
        "replicates": { "count": 3, "mode": "serial", "maxInFlight": 2 },
        "startTrigger": { "type": "afterStep", "stepId": "mix" } },
      { "stepId": "cool", "name": "Cool on rack", "task": "rack",
        "duration": { "type": "fixed", "seconds": 900 },
        "startTrigger": { "type": "afterStep", "stepId": "bake", "instances": "each" } },
      { "stepId": "box", "name": "Box cookies", "task": "prep",
        "duration": { "type": "fixed", "seconds": 300 },
        "startTrigger": { "type": "afterStep", "stepId": "cool", "instances": "all" } }
    ] }
  ],
  "resourceConstraints": [
    { "task": "prep", "maxConcurrent": 1 },
    { "task": "oven", "maxConcurrent": 1 },
    { "task": "rack", "maxConcurrent": 2 }
  ]
}
\`\`\`

Minutes from start: mix 0–15; bake 15–27, 27–39, **42–54**; cool 27–42,
39–54, 54–69; box 69–74. The third bake could start at 39 (the oven is
free) but waits until 42, when the first tray leaves the rack.
\`analyze_schedule\` reports the in-flight windows and names \`rack\`, not
\`oven\`, as the binding constraint. The same shape covers "12 samples,
the rotor holds 6" and "three landings, the taxiway holds two".

### Findings you may see

| code                    | what it means                                                                   |
|-------------------------|---------------------------------------------------------------------------------|
| \`E_INSTANCES_ON_SINGLE\` | \`instances\` on a step that is not replicated — remove it, or add \`replicates\` to the referenced step |
| \`E_EACH_WITH_REPLICATES\`| a step has both an \`"each"\` trigger and its own \`replicates\` — drop the \`replicates\`, the count is inherited |
| \`E_EACH_COUNT_MISMATCH\` | a \`compound\` \`"each"\` pairs two replicated steps with different \`count\`s     |
| \`E_INFLIGHT_GT_COUNT\`   | \`maxInFlight\` is greater than \`count\`                                          |
| \`E_INFLIGHT_NO_CHAIN\`   | \`maxInFlight\` on a \`serial\` replicate with no \`"each"\` descendants: nothing is ever held back |
| \`W_UNBARRIERED_CHAIN\`   | warning: an \`"each"\` chain has no \`"all"\` barrier, yet later steps do not wait for it |
| \`I_IMPLICIT_BARRIER\`    | info: a reference to a replicated step with no \`instances\`; the default \`"all"\` barrier applies. Add \`"all"\` to confirm it, or \`"each"\` if the work is per instance |

## Predicted offsets (experimental)

**\`metadata.offsetsUse\`.** Set it to \`"predicted"\` to let a negative \`offsetSeconds\` be resolved against a *predicted* end of the step it is anchored on instead of that step's authored \`defaultSeconds\`. It only affects negative offsets on \`indefinite\` anchors, and only when the program has enough recorded runs for a prediction whose interval is narrower than the authored \`defaultSeconds\`; otherwise the authored number is used unchanged. Nothing else in the program changes: every other trigger, and the plan \`analyze_schedule\` reports, still come from the durations as written. Leave it out (or set \`"planned"\`) and behaviour is exactly as before. It is worth setting on a program whose key step is genuinely open-ended (a roast, an incubation) and whose duration depends on something the program declares in \`metadata.varianceFactors\`; it is pointless on a program of fixed durations.

## Choice branching (schemaVersion "0.2.0-alpha" and later)

A step with \`"choice": {"prompt": "...", "options": [{"choiceId":"a","label":"A"},{"choiceId":"b","label":"B"}]}\`
becomes a decision point; downstream steps with \`"startTrigger": {"type":"afterStep","stepId":"<choice step>","choiceId":"a"}\`
only run for that option.

## Workflow

build → \`validate_program\` (fix every error) → \`analyze_schedule\`
(optional; makespan, critical path, conflicts, wall clock) →
\`visualize_schedule\` (publishes; returns the live URL, Gantt and itinerary).

Before the build, when the program comes from a goal or from a source
text (a recipe, a protocol, a run sheet), work through the four turns of
the \`plan_schedule\` prompt — read the source back, confirm this model,
extract the steps with the words each came from, and only then assign
tracks and triggers. \`rhylthyme://guide/extraction\` carries those four
turns as prose, with the expected output shape for each, for hosts that
cannot run a multi-message prompt. It is also where
\`metadata.sourceSpan\` (\`{"quote": "...", "occurrence": n}\`) and
\`metadata.inferred\` are defined: keep both on every step so the editor
can show where a step came from.
`;

function registerResources(server, vertical) {
  server.registerResource(
    "program-schema",
    "rhylthyme://schema/program",
    {
      title: `Rhylthyme program JSON Schema (${SCHEMA_VERSION_LABEL})`,
      description: "The full JSON Schema for Rhylthyme program files: tracks, steps, durations, start triggers (incl. compound and choice-gated), replicates, resource constraints, metadata.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(PROGRAM_SCHEMA) }],
    }),
  );
  server.registerResource(
    "authoring-guide",
    "rhylthyme://guide/authoring",
    {
      title: "Rhylthyme authoring guide",
      description: "One-page cheat-sheet: program shape, the rules validate_program enforces, every trigger type, how to make tracks finish together, repeated work (replicates, per-instance `instances` chains, barriers and `maxInFlight`), choice branching, and the recommended tool workflow.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: AUTHORING_GUIDE }],
    }),
  );
  server.registerResource(
    "extraction-guide",
    "rhylthyme://guide/extraction",
    {
      title: "Rhylthyme extraction guide (the four turns)",
      description: "The four-turn structure the plan_schedule prompt sends — read-back, model check, step extraction with source spans, then tracks and triggers — as prose with each turn's expected output shape, for hosts that cannot run a multi-message prompt.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: Prompts.EXTRACTION_GUIDE }],
    }),
  );
  Object.keys(EXAMPLE_PROGRAMS).forEach((key) => {
    const p = EXAMPLE_PROGRAMS[key];
    server.registerResource(
      `example-${key}`,
      `rhylthyme://examples/${key}`,
      {
        title: `Example: ${p.name || key}`,
        description: `${p.description ? String(p.description).slice(0, 160) + " — " : ""}complete, valid program (${(p.tracks || []).length} tracks, environment ${p.environmentType || "general"}).`,
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(p, null, 2) }],
      }),
    );
  });
}

// ---------------------------------------------------------------------
// Prompts: reusable "slash-command" style entry points hosts can list.
// ---------------------------------------------------------------------

function registerPrompts(server, vertical) {
  const key = VERTICALS[vertical] ? vertical : "generic";
  const cfg = VERTICALS[key];
  const nouns = {
    generic: { thing: "schedule", example: "Thanksgiving dinner for 8 with one oven, ready at 6pm" },
    kitchen: { thing: "meal", example: "Thanksgiving dinner for 8 with one oven, ready at 6pm" },
    lab: { thing: "protocol", example: "Western blot for 12 samples with one transfer apparatus" },
    events: { thing: "run-of-show", example: "wedding ceremony at 2pm, reception at 5pm, one PA system" },
    gym: { thing: "workout", example: "45-minute upper-body superset session" },
  }[key] || { thing: "schedule", example: "a multi-step process" };

  // Four user messages, not one: the host sends them in order in one
  // conversation, so each turn sees the previous answers. Separating
  // extraction (T3) from relationship inference (T4) is the point --
  // relationships are the component that goes wrong. See prompts.js.
  server.registerPrompt(
    "plan_schedule",
    {
      title: `Plan a ${nouns.thing} as a live timeline`,
      description: `Turn a goal ("${nouns.example}"), or a source text, into a validated Rhylthyme program and a live timeline URL. Four turns: read the source back, confirm the program model, extract the steps with the words each came from, then assign tracks and triggers and run validate → analyze → visualize.`,
      argsSchema: {
        goal: z.string().describe(`What to plan, e.g. "${nouns.example}".`),
        finishAt: z.string().optional().describe("Optional ISO datetime everything must be done by (used for wall-clock start times)."),
        constraints: z.string().optional().describe("Optional equipment / people limits, e.g. 'one oven, two burners, 2 cooks'."),
        sourceText: z.string().optional().describe("Optional source text to extract from: a recipe, a protocol, a run sheet. Embedded in turns 1 and 3; without it the steps are extracted from the goal alone."),
      },
    },
    ({ goal, finishAt, constraints, sourceText }) => ({
      messages: Prompts.renderFourTurns({
        goal,
        finishAt,
        constraints,
        sourceText,
        vertical: key,
        oneShot: cfg.oneShot ? cfg.oneShot.name : null,
      }).map((turn) => ({ role: "user", content: { type: "text", text: turn.text } })),
    }),
  );
}

function _registerAll(server, vertical) {
  registerValidateProgram(server, vertical);
  registerAnalyzeSchedule(server, vertical);
  registerVisualizeSchedule(server, vertical);
  registerImportFromSource(server, vertical);
  registerImportText(server, vertical);
  registerCreateEnvironment(server, vertical);
  registerLogin(server, vertical);
  registerListMyPrograms(server, vertical);
  registerLoadProgram(server, vertical);
  registerListRuns(server, vertical);
  registerLoadRun(server, vertical);
  registerCalibrateProgram(server, vertical);
  registerListPublicRuns(server, vertical);
  registerSearchPublicRecipes(server, vertical);
  registerLoadPublicRecipe(server, vertical);
  registerSaveProgram(server, vertical);
  registerPreviewTimeline(server, vertical);
  registerGetRendererSource(server, vertical);
  // Vertical-specific verbs (no-ops on the generic endpoint).
  registerOneShotTool(server, vertical);
  registerRandomTool(server, vertical);
  registerResources(server, vertical);
  registerPrompts(server, vertical);
}

const _handlerPromises = {};
function getHandler(vertical) {
  const key = VERTICALS[vertical] ? vertical : "generic";
  if (!_handlerPromises[key]) {
    _handlerPromises[key] = (async () => {
      const { createMcpHandler } = await import("mcp-handler");
      return createMcpHandler(
        (server) => { _registerAll(server, key); },
        {
          serverInfo: { name: VERTICALS[key].serverName, version: SERVER_VERSION },
          instructions: serverInstructions(key),
        },
        // import_text waits up to 120 s on the Flask side (four model
        // turns); leave headroom so the MCP function is not the one cut off.
        { basePath: "", maxDuration: 180 },
      );
    })().catch((e) => { _handlerPromises[key] = null; throw e; });
  }
  return _handlerPromises[key];
}

// Map an incoming path prefix to a vertical. Sorted longest-first
// implicitly because all vertical names are single segments under /.
const VERTICAL_PATH_PREFIXES = {
  "/kitchen/": "kitchen",
  "/lab/": "lab",
  "/events/": "events",
  "/gym/": "gym",
};

function detectVertical(reqUrl, hostHeader) {
  // Path prefix wins — /kitchen/mcp is kitchen regardless of host.
  for (const prefix of Object.keys(VERTICAL_PATH_PREFIXES)) {
    if (reqUrl.startsWith(prefix)) return VERTICAL_PATH_PREFIXES[prefix];
  }
  // Otherwise the vertical subdomain is a hint, so users can wire
  // kitchen.rhylthyme.com/mcp directly without the /kitchen prefix.
  const host = (hostHeader || "").toLowerCase();
  if (host.startsWith("kitchen.")) return "kitchen";
  if (host.startsWith("lab.")) return "lab";
  if (host.startsWith("events.")) return "events";
  if (host.startsWith("gym.")) return "gym";
  // Future-proofing for kitchen-mcp.* / mcp.kitchen.* style hostnames.
  if (host.startsWith("kitchen-mcp.") || host.startsWith("mcp.kitchen.")) return "kitchen";
  if (host.startsWith("lab-mcp.") || host.startsWith("mcp.lab.")) return "lab";
  if (host.startsWith("events-mcp.") || host.startsWith("mcp.events.")) return "events";
  if (host.startsWith("gym-mcp.") || host.startsWith("mcp.gym.")) return "gym";
  return "generic";
}

// ---------------------------------------------------------------------
// OG image endpoint — renders a PNG of the Gantt for a given shared
// program. Claude Desktop strips MCP image content blocks but DOES
// render markdown image URLs, so each tool's text return embeds a
// `![timeline](https://www.rhylthyme.com/api/og/timeline.png?share=…)`
// pointing here.
// ---------------------------------------------------------------------

async function handleOgTimeline(req, res) {
  const u = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  const share = (u.searchParams.get("share") || "").trim();
  const programId = (u.searchParams.get("program") || u.searchParams.get("p") || "").trim();
  if (!share && !programId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    res.end("share or program parameter required");
    return;
  }

  // Look up the program JSON. shared_programs (one row per /api/share
  // creation) has the inline program; programs is the canonical catalog.
  let program;
  try {
    const path = share
      ? `shared_programs?share_id=eq.${encodeURIComponent(share)}&select=program_json&limit=1`
      : `programs?id=eq.${encodeURIComponent(programId)}&is_public=eq.true&select=program_json&limit=1`;
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/${path}`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY || "",
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY || ""}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!resp.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain");
      res.end(`Lookup failed (${resp.status})`);
      return;
    }
    const rows = await resp.json();
    program = rows && rows[0] && rows[0].program_json;
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain");
    res.end(`Supabase unreachable: ${e.message || e}`);
    return;
  }
  if (!program) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("program not found");
    return;
  }

  const svg = renderSvgGantt(program);
  if (!svg) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("no tracks to render");
    return;
  }

  try {
    const { Resvg } = require("@resvg/resvg-js");
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 820 },
      background: "#fafafa",
    });
    const png = resvg.render().asPng();
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    // Long cache because rendering is deterministic from the program.
    // shared_programs rows are append-only; programs.updated_at can
    // change, so for programId we use a shorter window.
    res.setHeader(
      "Cache-Control",
      share
        ? "public, max-age=86400, s-maxage=86400, immutable"
        : "public, max-age=3600, s-maxage=3600",
    );
    res.end(png);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    res.end(`PNG render failed: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------------
// Vercel function entry
// ---------------------------------------------------------------------

// A stateless POST gets exactly one SSE stream holding its JSON-RPC
// response(s). For clients that did not accept text/event-stream, return
// the response as a plain JSON body instead (an array for batches).
async function sseToJson(webResponse) {
  const type = webResponse.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) return webResponse;
  const text = await webResponse.text();
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { messages.push(JSON.parse(line.slice(5).trim())); } catch (_) { /* keep-alive or partial */ }
  }
  const replies = messages.filter((m) => m && m.id !== undefined && (m.result !== undefined || m.error !== undefined));
  const headers = new Headers(webResponse.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  if (!replies.length) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(replies.length === 1 ? replies[0] : replies), {
    status: webResponse.status,
    headers,
  });
}

module.exports = async function handler(req, res) {
  const reqUrl = req.url || "";

  // OG-image route: matches /og/timeline.png and any-vertical variants
  // like /api/og/timeline.png. Handled inline to keep the cold-start
  // cost low (no mcp-handler involvement).
  if (reqUrl.includes("/og/timeline.png")) {
    return handleOgTimeline(req, res);
  }

  const hostHeader = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  const vertical = detectVertical(reqUrl, hostHeader);

  const webHandler = await getHandler(vertical);

  // Strip the vertical prefix before passing the URL to mcp-handler;
  // each handler thinks it's mounted at /mcp.
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = hostHeader || "www.rhylthyme.com";
  let pathForHandler = reqUrl || "/";
  for (const prefix of Object.keys(VERTICAL_PATH_PREFIXES)) {
    if (pathForHandler.startsWith(prefix)) {
      // "/kitchen/mcp" → "/mcp", "/lab/mcp" → "/mcp", etc.
      pathForHandler = pathForHandler.slice(prefix.length - 1);
      break;
    }
  }
  const url = `${protocol}://${host}${pathForHandler}`;

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  // Streamable HTTP requires POSTs to accept both application/json and
  // text/event-stream, and the SDK answers anything else with 406. Simple
  // clients (uptime checkers, directory crawlers, curl) often send */* or
  // application/json alone, so accept them: ask the SDK for both, and if
  // the client did not accept a stream, unwrap the SSE reply into JSON.
  const acceptHeader = String(req.headers.accept || "").toLowerCase();
  const clientTakesSse = acceptHeader.includes("text/event-stream");
  const lenientAccept = req.method === "POST" &&
    !(clientTakesSse && acceptHeader.includes("application/json"));
  const forwardHeaders = Object.fromEntries(
    Object.entries(req.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
  );
  if (lenientAccept) forwardHeaders.accept = "application/json, text/event-stream";

  const webRequest = new Request(url, {
    method: req.method,
    headers: forwardHeaders,
    body: body,
    duplex: "half",
  });

  // Usage analytics (see analytics.js). Null when disabled or when the
  // body holds nothing worth logging; rows are written after res.end()
  // so the client never waits on the insert.
  const tracker = req.method === "POST"
    ? Analytics.begin(body, { vertical, headers: req.headers })
    : null;

  try {
    let webResponse = await webHandler(webRequest);
    if (lenientAccept && !clientTakesSse) webResponse = await sseToJson(webResponse);
    res.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers.entries()) {
      res.setHeader(key, value);
    }
    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          if (tracker) tracker.capture(value);
          res.write(value);
        }
      };
      await pump();
    } else {
      res.end();
    }
    if (tracker) {
      const done = tracker.finish(webResponse.status);
      if (!Analytics.waitUntil(done)) await done;
    }
  } catch (e) {
    console.error("MCP handler error:", e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message || "Internal server error" }));
    if (tracker) {
      const done = tracker.finish(500);
      if (!Analytics.waitUntil(done)) await done;
    }
  }
};

// Exported for unit testing — not used by the Vercel runtime.
module.exports._formatProgramSummary = formatProgramSummary;
module.exports._verticalizeUrl = verticalizeUrl;
module.exports._detectVertical = detectVertical;
module.exports._registerAll = _registerAll;
module.exports._serverInstructions = serverInstructions;
module.exports._schemas = { Program, AnyProgram };
module.exports._VERTICALS = VERTICALS;
module.exports._programTotalSec = _programTotalSec;
module.exports._renderSvgGantt = renderSvgGantt;
module.exports.inlineCdnScripts = inlineCdnScripts;
module.exports._prompts = Prompts;
module.exports._analytics = Analytics;
