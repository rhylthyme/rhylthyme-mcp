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
// Bundled copies of the spec + a few example programs, exposed as MCP
// resources. Kept under static/ so the same files are also fetchable
// over HTTPS (www.rhylthyme.com/static/schema/…, /static/examples/…).
const PROGRAM_SCHEMA = require("../static/schema/program_schema_0.2.0-alpha.json");
const EXAMPLE_PROGRAMS = {
  breakfast_schedule: require("../static/examples/breakfast_schedule.json"),
  lab_experiment: require("../static/examples/lab_experiment.json"),
  stir_fry_with_choice: require("../static/examples/stir_fry_with_choice.json"),
  hiit_cardio_workout: require("../static/examples/hiit_cardio_workout.json"),
  corporate_presentation: require("../static/examples/corporate_presentation.json"),
};

const SERVER_VERSION = "1.3.0";
const SCHEMA_VERSION_LABEL = "0.2.0-alpha";

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
    "- Existing content: **search_public_recipes** → **load_public_recipe** (or the one-shot tool). The result already includes the live URL; no further call is needed.",
    oneShot.trimEnd(),
    "- New content: build the program → **validate_program** (fix every error it reports) → optionally **analyze_schedule** (makespan, critical path, resource conflicts, wall-clock itinerary when you pass finishAt/startAt) → **visualize_schedule** to get the shareable live timeline. visualize_schedule validates too and refuses invalid programs.",
    "- Never describe a schedule in prose when a timeline is possible; the URL is the deliverable. Quote the ASCII Gantt / itinerary from the tool result when summarizing.",
    "- **login** is only needed for the user's private library (list_my_programs, load_program, save_program) and for imports (import_from_source with action=import/random). Public catalog tools need no token.",
    "- Read `rhylthyme://guide/authoring` for the authoring cheat-sheet and `rhylthyme://schema/program` for the full JSON schema; `rhylthyme://examples/*` are complete, valid programs to pattern-match.",
    "",
    "Authoring rules: stepIds unique across the whole program; steps in one track never overlap (chain with afterStep); every `task` used by a step has a matching resourceConstraint; durations in seconds (numbers) or time strings (\"5m\", \"1h30m\"); to make everything finish together, delay short tracks with programStartOffset or afterStep, and pass finishAt to analyze_schedule to get wall-clock start times.",
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
      "Import a recipe or lab protocol from an external source into a Rhylthyme program. Sources: spoonacular (recipes, preferred), themealdb (recipes, fallback), protocolsio (lab protocols), cooklang (.cook recipe URL — action must be 'import', query is the URL; GitHub blob URLs are auto-converted), opentrons (Opentrons Protocol API v2 .py — pass URL as query, or paste source via text; action must be 'import'), benchling (the user's connected library). Actions: search (no login needed), import and random (need the user's Rhylthyme token from **login**). After import, run the returned program through **visualize_schedule**.",
    kitchen:
      "Import a recipe from a URL or recipe source into a cookable Rhylthyme program. Use when the user shares a recipe link, says 'turn this URL into a timeline', or asks for a recipe from a specific service. Sources: spoonacular (preferred — high quality, structured ingredients), themealdb (free fallback), cooklang (.cook files from any URL including GitHub blob URLs — pass URL as query, action='import'). Actions: search (find candidates; no login), import (URL/id → program JSON; needs `token` from **login**), random (needs `token`). After import, pass the returned program to **visualize_schedule** so the user can start cooking.",
    lab:
      "Import a lab protocol from an external source into a runnable Rhylthyme program. Use when the user pastes a protocols.io link, an Opentrons Protocol API .py file, a Benchling protocol URL, or a published method they want timed at the bench. Sources: benchling (the user's connected Benchling library — supports action='search' with `query`, then action='import' with the protocol id or URL), protocolsio (protocols.io URL or id), opentrons (Opentrons Protocol API v2 .py — pass URL as query, or paste source via text; action='import'). Actions: search, import, random (random not supported for benchling). import/random and anything Benchling need the user's Rhylthyme access token via `token` (from **login**). After import, pass the returned program to **visualize_schedule** so the user can start the experiment.",
    events:
      "Import an event template into a Rhylthyme program. The catalog leans toward recipe/protocol sources (no dedicated event-template source today), so this tool is mostly useful for power-users who want to seed an event run-of-show from a recipe-style schedule. import/random need the user's token from **login**. Most planners build from scratch with **validate_program** + **visualize_schedule** instead.",
    gym:
      "Import a workout from an external source into a Rhylthyme program. The catalog leans toward recipe/protocol sources (no dedicated workout source today), so this tool is mostly a power-user fallback. import/random need the user's token from **login**. Most lifters build a workout from scratch with **validate_program** + **visualize_schedule** instead, or pick one with **start_workout**.",
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
  resourceConflicts: z.array(z.looseObject({})),
  actorPeak: z.looseObject({}),
  wallClock: z.looseObject({}).nullable(),
  validation: z.looseObject({}).optional(),
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
function renderSvgGantt(program) {
  const svg = TimelineRender.renderTimelineSvg(program);
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
function buildTimelineImageBlock(program) {
  const svg = renderSvgGantt(program);
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
        "Check a Rhylthyme program for structural and scheduling errors BEFORE visualizing or saving it: missing/duplicate ids, dangling afterStep references, dependency cycles, steps that overlap within a track, tasks with no resourceConstraint, unparseable durations, invalid choice references. Every finding has a `code`, a `message` and a `fix` hint — apply the fixes and re-run until `valid` is true. Warnings (e.g. tracks that finish far apart) are advisory. Pure computation: no network, no side effects, safe to call repeatedly.",
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
        "Resolve a Rhylthyme program onto the clock and report what the live runner will do: every step's start/end (seconds from start and, if you pass `finishAt` or `startAt`, ISO wall-clock times), total makespan, the critical path, resource conflicts (windows where more steps claim a task than its maxConcurrent allows), peak concurrency vs. declared actors, and per-track slack. Use it to answer 'when do I start the potatoes so everything is ready at 6pm?' (pass finishAt), to find why a schedule is longer than expected (critical path), or to check equipment contention before visualizing. Pure computation; also returns validation findings so you can fix problems in the same turn.",
      inputSchema: {
        program: AnyProgram,
        finishAt: z.string().optional().describe("ISO 8601 datetime the whole program should END at (e.g. '2026-11-26T18:00:00-05:00'). Start times are computed backwards from it."),
        startAt: z.string().optional().describe("ISO 8601 datetime the program STARTS at. Ignored when finishAt is given."),
      },
      outputSchema: AnalysisOutput,
      annotations: Object.assign({ title: "Analyze schedule timing" }, ANN.pure),
    },
    async ({ program, finishAt, startAt }) => {
      const v = Schedule.validateProgram(program);
      if (!v.stats) {
        return { content: [{ type: "text", text: Schedule.formatValidation(v) }], isError: true };
      }
      const a = Schedule.analyzeSchedule(program, { finishAt, startAt });
      a.validation = { valid: v.valid, errors: v.errors, warnings: v.warnings };
      const parts = [Schedule.formatAnalysis(a)];
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

function registerImportFromSource(server, vertical) {
  server.registerTool(
    "import_from_source",
    {
      title: "Import from an external source",
      description: DESC.import_from_source[vertical],
      inputSchema: {
        source: z.enum([
          "themealdb", "protocolsio", "spoonacular", "cooklang", "opentrons", "benchling",
        ]),
        action: z.enum(["search", "import", "random"]),
        query: z.string().optional().describe("Search keywords (search), or the URL / id to import (import)."),
        text: z.string().optional().describe("Raw source text (Opentrons .py) when the user pasted it instead of a URL."),
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
    async ({ source, action, query, text, token }) => {
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
          })) + "\n\nCall **visualize_schedule** with this program (below) to get the live-timeline URL.\n\n```json\n"
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
        "Render a Rhylthyme program as a static Gantt-chart image so the user can SEE what the live timeline looks like, without committing to opening the live URL. Use this when the user asks for a 'preview' or 'picture' of the timeline, or when you have just built a freehand program and want to give the user a visual before they commit. The tool returns ONLY an image plus a one-line caption — no recipe prose, no ingredient list, no copyright concerns. Just the structural visualization of which step runs when on which track.\n\nPair with **visualize_schedule** when the user wants the full shareable interactive URL too. This tool is for the visual-only quick preview case.\n\n**Rendering option for HTML-artifact-capable clients (Claude.ai etc.):** Claude.ai's artifact sandbox blocks external scripts from non-cdnjs sources, so a `<script src=\"https://kitchen.rhylthyme.com/...\">` tag will fail. To render the timeline yourself with the official Rhylthyme look, call **get_renderer_source** first to fetch the renderer's full source as a string, then embed that source verbatim inside a `<script>…</script>` block in your HTML artifact, followed by your program JSON and a call to `Rhylthyme.renderTimeline(document.getElementById('t'), program)`. The renderer is open-source (Apache-2.0), zero-dependency, ~9KB.",
      inputSchema: {
        program: AnyProgram.describe("Rhylthyme program JSON (same shape visualize_schedule accepts)."),
      },
      annotations: Object.assign({ title: "Preview timeline image" }, ANN.publish),
    },
    async ({ program }) => {
      const tracks = (program && program.tracks) || [];
      const stepCount = tracks.reduce((n, t) => n + ((t && t.steps) || []).length, 0);
      if (!tracks.length || !stepCount) {
        return errorResult("Couldn't render a timeline — the program has no tracks/steps. Add at least one track with steps and try again.");
      }
      const totalSec = _programTotalSec(program);
      const caption =
        `**${program.name || "Timeline"}** — ${tracks.length} track${tracks.length === 1 ? "" : "s"}, `
        + `${stepCount} step${stepCount === 1 ? "" : "s"}, ${_fmtMinutes(totalSec)} total. `
        + `Call **visualize_schedule** with the same program to get a shareable URL.`;
      // Always include the MCP `image` content block — that's the
      // canonical path Claude Desktop renders. Pair with a markdown
      // image URL caption so clients that render tool-result markdown
      // (Claude.ai web) also get an inline preview. No directives
      // telling the model how to format its reply — that reads as
      // prompt injection and gets correctly refused.
      const image = buildTimelineImageBlock(program);
      const share = await createShareForProgram(program);
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
  "schemaVersion": "0.1.0",
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
   or declares \`actors\`).
4. Durations: \`fixed\` needs \`seconds\`; \`variable\` needs \`minSeconds\`
   + \`maxSeconds\` (+ \`defaultSeconds\` for planning); \`indefinite\` runs
   until the user ends it (give \`defaultSeconds\` so previews look right).
   Numbers are seconds; strings like \`"5m"\`, \`"1h30m"\`, \`"90s"\` also work.
5. \`afterStep\` references must point at existing steps and must not form
   a cycle.

## Triggers

| type                 | fields                                   | meaning                                            |
|----------------------|------------------------------------------|----------------------------------------------------|
| programStart         | —                                        | at t = 0                                           |
| programStartOffset   | offsetSeconds                            | at t = offset                                      |
| afterStep            | stepId, offsetSeconds?, event?, choiceId? | when stepId ends (event="start": when it starts) + offset |
| afterStepWithBuffer  | stepId, bufferSeconds                    | when stepId ends + buffer                          |
| manual               | triggerName?                             | user taps to start                                 |
| onAbort              | stepId                                   | only if stepId is aborted                          |
| compound             | logic: "all" \\| "any", triggers: [...]   | wait for all / the first of several triggers       |

Negative \`offsetSeconds\` ("start 20 min before the roast finishes")
requires the referenced step to be \`indefinite\`.

## Finishing together

To make every track end at the same moment, compute each track's length
and delay the shorter ones with \`programStartOffset\`, or chain them
\`afterStep\` off a step in the long track. \`analyze_schedule\` reports
per-track slack; pass \`finishAt\` to get wall-clock start times.

## Choice branching (schemaVersion "0.2.0-alpha")

A step with \`"choice": {"prompt": "...", "options": [{"choiceId":"a","label":"A"},{"choiceId":"b","label":"B"}]}\`
becomes a decision point; downstream steps with \`"startTrigger": {"type":"afterStep","stepId":"<choice step>","choiceId":"a"}\`
only run for that option.

## Workflow

build → \`validate_program\` (fix every error) → \`analyze_schedule\`
(optional; makespan, critical path, conflicts, wall clock) →
\`visualize_schedule\` (publishes; returns the live URL, Gantt and itinerary).
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
      description: "One-page cheat-sheet: program shape, the rules validate_program enforces, every trigger type, how to make tracks finish together, choice branching, and the recommended tool workflow.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: AUTHORING_GUIDE }],
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
  const cfg = VERTICALS[vertical] || VERTICALS.generic;
  const nouns = {
    generic: { thing: "schedule", example: "Thanksgiving dinner for 8 with one oven, ready at 6pm" },
    kitchen: { thing: "meal", example: "Thanksgiving dinner for 8 with one oven, ready at 6pm" },
    lab: { thing: "protocol", example: "Western blot for 12 samples with one transfer apparatus" },
    events: { thing: "run-of-show", example: "wedding ceremony at 2pm, reception at 5pm, one PA system" },
    gym: { thing: "workout", example: "45-minute upper-body superset session" },
  }[vertical] || { thing: "schedule", example: "a multi-step process" };

  server.registerPrompt(
    "plan_schedule",
    {
      title: `Plan a ${nouns.thing} as a live timeline`,
      description: `Turn a goal ("${nouns.example}") into a validated Rhylthyme program and a live timeline URL. Walks the model through search → build → validate → analyze → visualize.`,
      argsSchema: {
        goal: z.string().describe(`What to plan, e.g. "${nouns.example}".`),
        finishAt: z.string().optional().describe("Optional ISO datetime everything must be done by (used for wall-clock start times)."),
        constraints: z.string().optional().describe("Optional equipment / people limits, e.g. 'one oven, two burners, 2 cooks'."),
      },
    },
    ({ goal, finishAt, constraints }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Plan this as a Rhylthyme ${nouns.thing} and deliver a live timeline: ${goal}`,
            constraints ? `Resource limits: ${constraints}.` : "",
            finishAt ? `Everything must be finished by ${finishAt}.` : "",
            "",
            "Steps:",
            "1. Check the public catalog first (search_public_recipes" + (cfg.oneShot ? ` or ${cfg.oneShot.name}` : "") + "). If a good match exists, use it and stop — its result already has the live URL.",
            "2. Otherwise read rhylthyme://guide/authoring and build a program: one track per parallel line of work, sequential steps chained with afterStep, realistic durations, and a resourceConstraint for every task.",
            "3. Run validate_program and fix every error it reports.",
            "4. Run analyze_schedule" + (finishAt ? ` with finishAt="${finishAt}"` : "") + " to check the makespan, critical path and resource conflicts; adjust offsets so tracks finish together.",
            "5. Call visualize_schedule and give the user the live URL plus the Gantt/itinerary from the result. Do not describe the schedule in prose.",
          ].filter(Boolean).join("\n"),
        },
      }],
    }),
  );
}

function _registerAll(server, vertical) {
  registerValidateProgram(server, vertical);
  registerAnalyzeSchedule(server, vertical);
  registerVisualizeSchedule(server, vertical);
  registerImportFromSource(server, vertical);
  registerCreateEnvironment(server, vertical);
  registerLogin(server, vertical);
  registerListMyPrograms(server, vertical);
  registerLoadProgram(server, vertical);
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
        { basePath: "", maxDuration: 60 },
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

  const webRequest = new Request(url, {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
    ),
    body: body,
    duplex: "half",
  });

  try {
    const webResponse = await webHandler(webRequest);
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
          res.write(value);
        }
      };
      await pump();
    } else {
      res.end();
    }
  } catch (e) {
    console.error("MCP handler error:", e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message || "Internal server error" }));
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
module.exports.inlineCdnScripts = inlineCdnScripts;
