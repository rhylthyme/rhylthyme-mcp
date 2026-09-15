// mcp-api/prompts.js
//
// The four-turn prompt structure for agent-authored programs, and the
// prose guide that carries it to hosts which cannot run a multi-message
// prompt.
//
// One source of truth: `index.js` renders `plan_schedule` from these
// templates, `rhylthyme://guide/extraction` serves EXTRACTION_GUIDE, and
// the evaluation harness in rhylthyme-cli-runner keeps byte-identical
// Python copies (`eval/patterns/four_turn.py`, checked by a parity test)
// so the prompt under test is the prompt that ships. This file is
// byte-copied to rhylthyme-mcp/mcp-api/prompts.js; see
// tools/check_mirrors.sh.
//
// Structure follows Almuntashiri, Ibanez & Chapman (ProvenanceWeek '25):
// read the whole source back, confirm the target data model, extract the
// activities with the span each came from, and only then infer the
// relationships between them -- relationships being the component their
// evaluation found weakest.
"use strict";

// ---------------------------------------------------------------------
// Slot rendering
// ---------------------------------------------------------------------

// A slot marker is {name}. JSON braces in the templates never match:
// every one of them is followed by a quote, a bracket or a word plus a
// colon, not by a bare identifier and a closing brace.
const SLOT_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The slot names a template asks for, in first-appearance order. */
function slotsIn(template) {
  const names = [];
  let match;
  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(template)) !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Fill {slot} markers. Throws on an unknown slot (given but not in the
 * template) and on a missing one (in the template but not given), so a
 * renamed slot fails loudly instead of shipping a half-filled prompt.
 */
function render(template, slots) {
  const values = slots || {};
  const wanted = slotsIn(template);
  const unknown = Object.keys(values).filter((key) => !wanted.includes(key));
  if (unknown.length) {
    throw new Error(
      "render: unknown slot(s) " + unknown.join(", ") +
      "; template takes " + (wanted.join(", ") || "no slots"),
    );
  }
  const missing = wanted.filter((key) => !(key in values));
  if (missing.length) {
    throw new Error("render: missing slot(s) " + missing.join(", "));
  }
  return template.replace(SLOT_RE, (_, name) => String(values[name]));
}

// ---------------------------------------------------------------------
// Expected output shapes (valid JSON, one per turn)
// ---------------------------------------------------------------------

const EXPECTED_T1 = `{
  "summary": "one paragraph: what is being made, for how many, by when, under what constraints",
  "servesOrScale": "8 people",
  "deadline": "2026-11-26T18:00:00",
  "constraints": ["one oven", "two burners", "two cooks"]
}`;

const EXPECTED_T2 = `{
  "acknowledgement": "tracks are sequential lines of work; one duration kind per step; triggers link steps; every task needs a resourceConstraint; stepIds are global",
  "resourceConstraints": [
    { "task": "oven", "maxConcurrent": 1 },
    { "task": "burner", "maxConcurrent": 2 },
    { "task": "prep", "maxConcurrent": 2 }
  ],
  "actors": 2
}`;

const EXPECTED_T3 = `{
  "steps": [
    {
      "stepId": "roast-turkey",
      "name": "Roast the turkey",
      "task": "oven",
      "duration": { "type": "fixed", "seconds": 10800 },
      "sourceSpan": { "quote": "Roast the turkey for 3 hours", "occurrence": 1 },
      "inferred": false
    },
    {
      "stepId": "rest-turkey",
      "name": "Rest the turkey",
      "task": "counter",
      "duration": { "type": "variable", "minSeconds": 1200, "maxSeconds": 2400, "defaultSeconds": 1800 },
      "sourceSpan": { "quote": "let it rest", "occurrence": 1 },
      "inferred": false
    },
    {
      "stepId": "preheat-oven",
      "name": "Preheat the oven",
      "task": "oven",
      "duration": { "type": "fixed", "seconds": 900 },
      "sourceSpan": null,
      "inferred": true
    }
  ]
}`;

const EXPECTED_T4 = `{
  "schemaVersion": "0.3.0-alpha",
  "programId": "kebab-case-id",
  "name": "Human title",
  "environmentType": "kitchen",
  "actors": 2,
  "tracks": [
    {
      "trackId": "turkey",
      "name": "Turkey",
      "steps": [
        {
          "stepId": "preheat-oven",
          "name": "Preheat the oven",
          "task": "oven",
          "duration": { "type": "fixed", "seconds": 900 },
          "startTrigger": { "type": "programStart" },
          "metadata": { "sourceSpan": null, "inferred": true }
        },
        {
          "stepId": "roast-turkey",
          "name": "Roast the turkey",
          "task": "oven",
          "duration": { "type": "fixed", "seconds": 10800 },
          "startTrigger": { "type": "afterStep", "stepId": "preheat-oven" },
          "metadata": { "sourceSpan": { "quote": "Roast the turkey for 3 hours", "occurrence": 1 }, "inferred": false }
        }
      ]
    }
  ],
  "resourceConstraints": [
    { "task": "oven", "maxConcurrent": 1 },
    { "task": "counter", "maxConcurrent": 2 }
  ],
  "metadata": { "serves": "8" }
}`;

const EXPECTED_OUTPUT = {
  T1: EXPECTED_T1,
  T2: EXPECTED_T2,
  T3: EXPECTED_T3,
  T4: EXPECTED_T4,
};

// ---------------------------------------------------------------------
// The four turn templates
// ---------------------------------------------------------------------

const T1_READBACK = `Turn 1 of 4 — read-back. Do not write any program JSON in this turn.

You are going to turn a {kind} into a Rhylthyme program: parallel **tracks** of sequential **steps**, each with a duration and a start trigger, that one person follows against a live clock.

Plan this as a Rhylthyme {kind} and deliver a live timeline: {goal}
{constraintsLine}
{deadlineLine}

{source}

Read all of it before you answer. Then say back, in one paragraph and in your own words: what is being made, for how many (or at what scale), by when, and under what constraints — equipment that exists only once, how many people are working, anything that has to be held, rested or ready at a particular moment. If the text you were given looks truncated, or points at a section that is not here, say so instead of filling the gap.

End your reply with the same read-back as JSON in a single \`\`\`json fenced block:

\`\`\`json
${EXPECTED_T1}
\`\`\``;

const T2_MODEL_CHECK = `Turn 2 of 4 — model check. Still no program JSON.

Before extracting anything, restate the target data model in your own words, in five or six sentences:

- a **track** is one sequential line of work; steps in the same track never overlap, and anything that happens while something else happens belongs in a different track;
- a **step** has exactly one duration kind: \`fixed\` (\`seconds\`), \`variable\` (\`minSeconds\`, \`maxSeconds\`, \`defaultSeconds\`) or \`indefinite\` (runs until the person ends it);
- a **startTrigger** ties a step to the clock or to another step — \`programStart\`, \`programStartOffset\`, \`afterStep\`, \`afterStepWithBuffer\`, \`manual\`, \`onAbort\`, \`compound\`;
- \`stepId\`s are unique across the WHOLE program, not per track;
- every \`task\` a step occupies needs a matching \`resourceConstraints\` entry, and that entry's \`maxConcurrent\` is what stops two steps sharing one oven, one thermocycler or one PA;
- work repeated n times (n trays, n samples, n aircraft) is \`replicates: {count: n, mode: "serial" | "parallel" | "stagger"}\` on ONE step — never n hand-copied steps or tracks. Chain what follows each repetition with \`{"type":"afterStep","stepId":"<step>","instances":"each"}\`, give the step that waits for all of them \`{"instances":"all"}\`, and when the holding area between them only fits k at a time (a rack that holds two trays, a rotor that holds six tubes, a taxiway that holds two aircraft) set \`replicates.maxInFlight: k\` so the upstream step is held back instead of stranding the downstream one.

\`rhylthyme://guide/authoring\` is the full cheat-sheet, and \`rhylthyme://schema/program\` the schema, if you want to check a rule.

Then list the resource constraints you expect this {kind} to need — one \`task\` per line with the \`maxConcurrent\` you intend to declare and how many people are working — and end with that list as JSON in a single \`\`\`json fenced block:

\`\`\`json
${EXPECTED_T2}
\`\`\``;

const T3_EXTRACTION = `Turn 3 of 4 — extraction. Steps only: no tracks, no triggers, no program JSON.

Imagine you have to carry out this {kind} yourself, in {environment}, and everything must be ready at {deadline}. You have only the text below. Read all of it.

{source}

List every timed activity you would have to perform, in the order the text gives it, with:

- a short kebab-case \`stepId\` and a human \`name\`;
- \`task\`: the resource it occupies while it runs — the oven, a burner, the thermocycler, the PA, the bench, your own hands. Use the same name every time for the same resource;
- how long it takes: exact (\`fixed\`), a range (\`variable\`), or "until I decide" (\`indefinite\`);
- \`sourceSpan\`: the exact words in the text you took it from, as \`{"quote": "...", "occurrence": n}\`, where n says which occurrence of those words you mean (1 for the first). Quote the text verbatim — do not paraphrase it;
- \`inferred\`: \`true\` for a step the text never states but the work needs anyway (preheating, thawing, resting, cooling, labelling, sound-check), with \`"sourceSpan": null\`. Keep these few and obvious.

Split anything the text bundles into one sentence when the parts occupy different resources or different stretches of time ("brown the meat, then simmer for 40 minutes" is two activities). Do not decide yet which activities can overlap, which track they belong to, or what waits for what.

Reply with the step list as JSON in a single \`\`\`json fenced block:

\`\`\`json
${EXPECTED_T3}
\`\`\``;

const T4_RELATIONSHIPS_CORE = `Turn 4 of 4 — relationships, then the program.

Take the step list from turn 3 exactly as it stands.

**First, tracks.** Put each step in a track: one track per parallel line of work — per dish, per station, per instrument, per performer, per sample group. Steps in one track run one after another and must not overlap; anything that runs while something else runs belongs in its own track.

**Second, triggers.** Give every step a \`startTrigger\` from this vocabulary and no other:

- \`{"type":"programStart"}\` — at t = 0.
- \`{"type":"programStartOffset","offsetSeconds":n}\` — n seconds after the start; this is how a short track is delayed so it finishes with the others.
- \`{"type":"afterStep","stepId":"x"}\` — when x ends. Add \`"offsetSeconds"\` for a gap, \`"event":"start"\` to hang off x's start instead of its end, \`"instances"\` when x is replicated.
- \`{"type":"afterStepWithBuffer","stepId":"x","bufferSeconds":n}\` — n seconds after x ends.
- \`{"type":"manual"}\` — the person taps to start it: a gate that no clock can predict (guests seated, dough looks right, the surgeon is ready).
- \`{"type":"compound","logic":"all"|"any","triggers":[...]}\` — wait for all of, or the first of, several triggers.

**Third, refine the question before you answer it.** Within the scope of scheduling these activities for one person to follow, suggest a better version of the question "which activities depend on which, and which can run at the same time?" — one that would expose dependencies this text implies but does not state: things that must cool, rest, preheat, thaw, proof, be held warm, or be ready at the same moment as something else. Write your improved question out, answer it, and revise the triggers accordingly. A step the improved question reveals is added here, marked \`"inferred": true\`.

**Then emit the complete program JSON** in a single \`\`\`json fenced block: \`schemaVersion\`, \`programId\`, \`name\`, \`environmentType\`, \`actors\`, \`tracks\`, and a \`resourceConstraints\` entry for every \`task\` any step uses. Carry turn 3's provenance onto each step as \`"metadata": {"sourceSpan": ..., "inferred": ...}\`.

\`\`\`json
${EXPECTED_T4}
\`\`\``;

// The six-step tool workflow an MCP host runs after the program JSON.
// Split out so a server-side caller (rhylthyme-server's `enrich` pass,
// which has the validator in-process and no tools to hand the model)
// can render the relationship half on its own.
// T4_RELATIONSHIPS_CORE + T4_HOST_WORKFLOW_TAIL is byte-for-byte the
// T4_RELATIONSHIPS that plan_schedule has always sent.
const T4_HOST_WORKFLOW_TAIL = `

Then finish the job with the tools:
1. If the public catalog already covers this ({catalogTools}), load that instead and stop — its result already has the live URL.
2. Otherwise keep the program you just built; \`rhylthyme://guide/authoring\` is the cheat-sheet and \`rhylthyme://examples/*\` are complete programs to pattern-match.
3. Express the limits as constraints, not as copied JSON: the \`resourceConstraints\`, \`replicates\`, \`instances\` and \`maxInFlight\` you confirmed in turn 2.
4. Run validate_program and fix every error it reports.
5. Run analyze_schedule{finishAtArg} to check the makespan, critical path and resource conflicts; adjust offsets so tracks finish together. Its \`bindingConstraints\` say which limit is actually gating the makespan.
6. Call visualize_schedule and give the user the live URL plus the Gantt/itinerary from the result. Do not describe the schedule in prose.`;

const T4_RELATIONSHIPS = T4_RELATIONSHIPS_CORE + T4_HOST_WORKFLOW_TAIL;

// ---------------------------------------------------------------------
// The ordered turn list
// ---------------------------------------------------------------------

const FOUR_TURNS = [
  {
    key: "T1",
    name: "read-back",
    purpose: "Confirm the whole source was read and the goal understood, before any JSON exists.",
    template: T1_READBACK,
    expected: EXPECTED_T1,
    slots: slotsIn(T1_READBACK),
  },
  {
    key: "T2",
    name: "model check",
    purpose: "Restate the program model in the model's own words and name the resource constraints it expects to declare.",
    template: T2_MODEL_CHECK,
    expected: EXPECTED_T2,
    slots: slotsIn(T2_MODEL_CHECK),
  },
  {
    key: "T3",
    name: "extraction",
    purpose: "Scenario pattern: list every timed activity with its duration, the resource it occupies and the source span it came from. No relationships yet.",
    template: T3_EXTRACTION,
    expected: EXPECTED_T3,
    slots: slotsIn(T3_EXTRACTION),
  },
  {
    key: "T4",
    name: "relationships",
    purpose: "Assign tracks and triggers, apply the question-refinement pattern to the dependency question, then emit the program and run the tool workflow.",
    template: T4_RELATIONSHIPS,
    expected: EXPECTED_T4,
    slots: slotsIn(T4_RELATIONSHIPS),
  },
];

// ---------------------------------------------------------------------
// Slot helpers: one place that turns plan_schedule's arguments (and the
// vertical) into the words the templates expect.
// ---------------------------------------------------------------------

const KINDS = {
  generic: "process",
  kitchen: "recipe",
  lab: "protocol",
  events: "run-of-show",
  gym: "workout",
};

const PLACES = {
  generic: "the workspace the text assumes",
  kitchen: "a kitchen with one oven and two burners",
  lab: "a lab with one of each shared instrument",
  events: "a venue with one stage and one PA system",
  gym: "a gym with one set of each piece of equipment",
};

const PLACE_NAMES = {
  generic: "workspace",
  kitchen: "kitchen",
  lab: "lab",
  events: "venue",
  gym: "gym",
};

/** "recipe" / "protocol" / "run-of-show" / "workout" / "process". */
function kindFor(vertical) {
  return KINDS[vertical] || KINDS.generic;
}

/** The scenario prompt's environment phrase. */
function environmentPhrase(vertical, constraints) {
  if (constraints && String(constraints).trim()) {
    return "a " + (PLACE_NAMES[vertical] || PLACE_NAMES.generic) +
      " where you have: " + String(constraints).trim();
  }
  return PLACES[vertical] || PLACES.generic;
}

/** The scenario prompt's deadline phrase (inside a sentence). */
function deadlinePhrase(finishAt) {
  return finishAt && String(finishAt).trim()
    ? String(finishAt).trim()
    : "the earliest time the work allows";
}

/** T1's standalone "Resource limits: ..." line. */
function constraintsLine(constraints) {
  return constraints && String(constraints).trim()
    ? "Resource limits: " + String(constraints).trim() + "."
    : "Resource limits: none were given — infer them from the text and say which you assumed.";
}

/** T1's standalone deadline line. */
function deadlineLine(finishAt) {
  return finishAt && String(finishAt).trim()
    ? "Everything must be finished by " + String(finishAt).trim() + "."
    : "No finishing time was given; finish as early as the work allows.";
}

/** The source block embedded in T1 and T3. */
function sourceBlock(sourceText) {
  const text = sourceText == null ? "" : String(sourceText).trim();
  if (!text) {
    return "No source text was supplied: the goal above is all you have, so work from what it states and from what the work itself requires.";
  }
  return "Source text (read all of it):\n<<<\n" + text + "\n>>>";
}

/** T4 step 1's catalog tools, with the vertical's one-shot when it has one. */
function catalogTools(oneShot) {
  return oneShot ? "search_public_recipes or " + oneShot : "search_public_recipes";
}

/** T4 step 5's analyze_schedule argument, empty when no deadline is known. */
function finishAtArg(finishAt) {
  return finishAt && String(finishAt).trim()
    ? ' with finishAt="' + String(finishAt).trim() + '"'
    : "";
}

/**
 * Per-turn slot maps for one set of plan_schedule arguments.
 * `args`: {goal, finishAt?, constraints?, sourceText?, vertical?, oneShot?}
 */
function turnSlots(args) {
  const a = args || {};
  const vertical = a.vertical || "generic";
  const kind = kindFor(vertical);
  const source = sourceBlock(a.sourceText);
  return {
    T1: {
      kind: kind,
      goal: a.goal || "",
      constraintsLine: constraintsLine(a.constraints),
      deadlineLine: deadlineLine(a.finishAt),
      source: source,
    },
    T2: { kind: kind },
    T3: {
      kind: kind,
      environment: environmentPhrase(vertical, a.constraints),
      deadline: deadlinePhrase(a.finishAt),
      source: source,
    },
    T4: {
      catalogTools: catalogTools(a.oneShot),
      finishAtArg: finishAtArg(a.finishAt),
    },
  };
}

/** The four rendered messages, in order: [{key, name, text}, ...]. */
function renderFourTurns(args) {
  const slots = turnSlots(args);
  return FOUR_TURNS.map((turn) => ({
    key: turn.key,
    name: turn.name,
    text: render(turn.template, slots[turn.key]),
  }));
}

// ---------------------------------------------------------------------
// rhylthyme://guide/extraction -- the same four turns as prose, for hosts
// that cannot run a multi-message prompt.
// ---------------------------------------------------------------------

const GUIDE_HEAD = `# Rhylthyme extraction guide (the four turns)

\`plan_schedule\` hands a host four user messages. If your host cannot run a
multi-message prompt, run them yourself, in order, in one conversation: the
model's answer to each turn stays in the transcript and the next turn builds
on it. Do not collapse them into one message — separating extraction from
relationship inference is the point.

| turn | purpose | output |
|---|---|---|
| T1 read-back | confirm the whole source was read and the goal understood | \`{summary, servesOrScale, deadline?, constraints[]}\` |
| T2 model check | restate the program model; name the resource constraints to declare | acknowledgement + \`resourceConstraints[]\` |
| T3 extraction | every timed activity, its duration, its resource, the words it came from | flat step list with \`sourceSpan\` and \`inferred\` |
| T4 relationships | tracks, triggers, the refined dependency question, then the program | full program JSON → \`validate_program\` → \`analyze_schedule\` → \`visualize_schedule\` |

Fill the \`{slot}\` markers below from the user's goal, deadline and resource
limits, and from the source text when there is one. With no source text, T1 and
T3 carry a line saying so and the model works from the goal alone. Provenance
survives into the program: each step keeps
\`metadata.sourceSpan = {"quote": "...", "occurrence": n}\` (quoted substring
plus which occurrence of it), and a step the source never stated keeps
\`metadata.inferred = true\` — the editor shows those differently, and the
evaluation harness scores them as *unsupported* rather than wrong.
`;

function extractionGuide() {
  const parts = [GUIDE_HEAD];
  FOUR_TURNS.forEach((turn) => {
    parts.push([
      "## " + turn.key + " — " + turn.name,
      "",
      turn.purpose,
      "",
      "Slots: " + (turn.slots.length ? turn.slots.map((s) => "`{" + s + "}`").join(", ") : "none"),
      "",
      "`````",
      turn.template,
      "`````",
      "",
      "Expected output shape:",
      "",
      "`````json",
      turn.expected,
      "`````",
    ].join("\n"));
  });
  return parts.join("\n") + "\n";
}

const EXTRACTION_GUIDE = extractionGuide();

module.exports = {
  EXPECTED_OUTPUT,
  EXTRACTION_GUIDE,
  FOUR_TURNS,
  T1_READBACK,
  T2_MODEL_CHECK,
  T3_EXTRACTION,
  T4_HOST_WORKFLOW_TAIL,
  T4_RELATIONSHIPS,
  T4_RELATIONSHIPS_CORE,
  catalogTools,
  constraintsLine,
  deadlineLine,
  deadlinePhrase,
  environmentPhrase,
  finishAtArg,
  kindFor,
  render,
  renderFourTurns,
  slotsIn,
  sourceBlock,
  turnSlots,
};
