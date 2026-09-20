# Rhylthyme MCP server

Real-time, multi-track scheduling for Claude and other MCP clients.
A Rhylthyme *program* is JSON describing parallel **tracks** of timed
**steps** with dependencies and shared-resource limits; the server
validates it, resolves it onto the clock, and publishes it as a live
timeline (timers, cues, itinerary, DAG) at rhylthyme.com.

| Endpoint | Server name | Adds |
|---|---|---|
| `https://mcp.rhylthyme.com/mcp` | `rhylthyme-mcp` | generic scheduler (anything) |
| `https://mcp.rhylthyme.com/kitchen/mcp` | `rhylthyme-kitchen-mcp` | `cook_recipe`, `whats_for_dinner` |
| `https://mcp.rhylthyme.com/lab/mcp` | `rhylthyme-lab-mcp` | `run_protocol`, `random_protocol`, Benchling import |
| `https://mcp.rhylthyme.com/events/mcp` | `rhylthyme-events-mcp` | `plan_event`, `random_event_template` |
| `https://mcp.rhylthyme.com/gym/mcp` | `rhylthyme-gym-mcp` | `start_workout`, `surprise_workout` |

Transport: Streamable HTTP, stateless, no auth required for the public
catalog and all pure tools. Account tools take a per-user token from the
`login` tool.

## Connect

**Claude Code**

```bash
claude mcp add --transport http rhylthyme https://mcp.rhylthyme.com/mcp
# or a vertical:
claude mcp add --transport http rhylthyme-kitchen https://mcp.rhylthyme.com/kitchen/mcp
```

**Claude Desktop / claude.ai** — Settings → Connectors → *Add custom
connector* → paste one of the URLs above. No OAuth screen: public tools
work immediately; run the `login` tool when you want to save to your own
account.

**Claude API (MCP connector)** — the API can call the server directly
from a Messages request:

```python
import anthropic

client = anthropic.Anthropic()
resp = client.beta.messages.create(
    model="claude-opus-5",
    max_tokens=16000,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{"type": "url", "url": "https://mcp.rhylthyme.com/kitchen/mcp", "name": "rhylthyme"}],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "rhylthyme"}],
    messages=[{"role": "user", "content": "Plan Thanksgiving for 8 with one oven, dinner at 6pm."}],
)
```

**Claude Agent SDK** — `mcpServers: { rhylthyme: { type: "http", url: "https://mcp.rhylthyme.com/mcp" } }`.

**Local stdio server** (Python, `pip install -e "./rhylthyme-server[mcp]"`,
command `rhylthyme-mcp`) — same core tools plus `browse_instrument_catalog`
and a `hosting: "local"` mode that writes a self-contained HTML file.

## Tools

| Tool | Annotations | What it does |
|---|---|---|
| `validate_program` | read-only, pure | Structural + scheduling checks with `code` / `message` / `fix` per finding; structured output. Mirrors `rhylthyme validate`. |
| `analyze_schedule` | read-only, pure | Resolved start/end per step, makespan, critical path, `bindingConstraints`, kind-tagged conflict windows, in-flight windows, per-track slack (per instance sub-track), peak concurrency. Pass `finishAt` or `startAt` for ISO wall-clock times ("start the potatoes at 17:12"). See [analyze_schedule output](#analyze_schedule-output). Pass `history` (or `program_id` + `token`) for predicted durations beside the planned ones, and `useDurations: "predicted"` to replan on them — see [analyze_schedule prediction](#analyze_schedule-prediction). |
| `visualize_schedule` | publishes | Validates, then creates a shareable live-timeline URL. Returns cover photo, equipment, ingredients, ASCII Gantt, itinerary, schedule check, PNG image block; structured `{url, shareId, imageUrl, makespanSeconds, warnings}`. Refuses invalid programs unless `allowInvalid`. |
| `preview_timeline` | publishes (share row) | PNG Gantt only, no prose. Pass a recorded `run` for a planned-vs-actual picture (ghost bar = the plan) — see [Execution history](#execution-history). |
| `search_public_recipes` | read-only | Keyword search over the public catalog (kitchen / laboratory / event / gym). Structured results with view URLs. |
| `load_public_recipe` | read-only | Full summary + live URL for one catalog entry. |
| `cook_recipe` / `run_protocol` / `plan_event` / `start_workout` | read-only | One-shot: top catalog match → live URL. |
| `whats_for_dinner` / `random_protocol` / … | read-only | Random catalog pick. |
| `import_from_source` | read-only | Spoonacular, TheMealDB, protocols.io, Cooklang, Opentrons, Benchling → program JSON (validated). `import`/`random` need `token`. `enrich: true` splits the import into tracks — see [`import_from_source.enrich`](#import_from_sourceenrich). `llm-text` takes pasted text instead of a URL; prefer the dedicated [`import_text`](#import_text) tool for that. |
| `import_text` | read-only | Pasted free text (no URL, no supported service) → validated multi-track program, plus the source span every step came from. Runs all four turns of `plan_schedule` server-side. Needs `token`; capped per day — see [`import_text`](#import_text). |
| `create_environment` | pure | Equipment limits → environment JSON / resourceConstraints. |
| `login` | — | Returns the sign-in URL; verifies a pasted token. |
| `list_my_programs`, `load_program`, `save_program` | account | Personal library. `save_program` validates first. |
| `list_runs`, `load_run` | account | Execution history: recorded runs of one saved program, and the planned-vs-actual detail of one run. See [Execution history](#execution-history). |
| `list_public_runs` | read-only | The runs other people contributed for one exact program version, with the variance factors each was recorded with. No login. See [Execution history](#execution-history). |
| `calibrate_program` | read-only | Durations proposed from the caller's recorded runs, with the evidence per step and the makespan effect. Never saves; `accept` hands back the calibrated program for `save_program`. See [Calibration](#calibration). |
| `get_renderer_source` | read-only | Source of the Apache-2.0 timeline renderer for HTML artifacts. |

### Execution history

A **run record** (`runs` schema 0.1.0-alpha,
`rhylthyme-spec/.../runs_schema_0.1.0-alpha.json`) is what a runtime writes
when a program has been executed: the timings the program planned, frozen at
run start, beside the timings that actually happened, plus what ended each
step and how long the clock was paused. The web player writes one per run to
`program_runs` (owner-only RLS, `sql/program_runs.sql`); the CLI runner
writes the same document to `~/.rhylthyme/runs/`.

| tool | arguments | returns |
|---|---|---|
| `list_runs` | `program_id` (UUID), `token` | The program's runs newest first: start time, outcome, actual vs planned makespan with the deviation, pauses and non-unit speeds, and the run id |
| `load_run` | `run_id` (UUID), `token` | One run: header (program, version hash, outcome, runtime, makespan, recorded variance factors) plus a per-step planned-vs-actual table with `endedBy` and `pausedSeconds` |
| `list_public_runs` | `program_hash` **or** `program`, `limit` | The contributed runs of one exact program version, newest first, with each run's variance factors and the median actual total against the planned one. **No token** |
| `preview_timeline` | `program`, `run` (a record, e.g. `load_run`'s `run`) | A PNG of the run against its plan: the actual bar over a thin ghost bar at the planned position, outlined by the sign of each step's end deviation. **No token** |
| `calibrate_program` | `program_id` and/or `program`, `history?`, `k?`, `since?`, `accept?`, `token` | Proposed durations from the recorded runs — see [Calibration](#calibration) |

`list_runs` and `load_run` are thin wrappers over
`GET /api/mcp/programs/<program_id>/runs` and `GET /api/mcp/runs/<run_id>`,
called with the user's own JWT, so RLS decides what comes back: runs are
private to the person who ran them even when the program is public. Both are
login-gated — without `token` they return the `login` instructions rather
than a 401.

`list_public_runs` wraps `GET /api/public/runs?programHash=…`, which needs no
authentication at all, because the rows it reads belong to nobody. Publishing
a run is opt-in per run (the checkbox beside "Save this run" in the player);
what is stored is a copy with `steps[].notes` removed, `context` reduced to
`serves`, `actors`, `environmentType` and `userTags`, and no user id and no
program id — the canonical program hash is the only key
(`sql/public_runs.sql`, `rhylthyme_server.rhylthyme.run_privacy`). Pass either
`program_hash` (`sha256:` plus 64 hex characters, as a record's
`programVersion`) or the `program` JSON, which the tool hashes with the same
canonical hash the runtimes use — so an edited program has no contributed
history until somebody runs the edit.

Only a step that a person ended (`endedBy: "executor"`), with no pauses, at
speed 1, in a `completed` run, measures how long the work really takes. A
`timer` ending only says the timer expired. Calibration (Phase 5 of
`plans/execution-history-duration-prediction.md`) applies exactly that
filter.

### Calibration

`calibrate_program` turns those measurements into proposed durations. It
is **read-only**: the tool returns a proposal, and passing `accept`
returns the *calibrated program* as a value — nothing is written to the
library either way. Keeping it is a separate, explicit `save_program`
call, so the user sees the change before it lands.

| input | meaning |
|---|---|
| `program_id` | The library program (UUID) whose recorded runs are the evidence. With no `program`, its saved JSON is also what gets calibrated, so the usual call is just an id and a token. |
| `program` | The program JSON to calibrate, when it differs from what is saved (the editor sends the buffer it is showing). |
| `history` | Run records to use instead of the ones stored against `program_id`. |
| `k` | Measurements a step needs before it gets a proposal (default 5). Under it the step is reported as `skipped` with `reason: "insufficient-runs"` *and* its statistics, never silently dropped. |
| `since` | Only runs started on or after this date — "calibrate on last month's cooks". |
| `accept` | `"all"`, or the step ids to write. The result then also carries `program`. |
| `token` | Required: the runs are private to whoever ran them. |

The rules, per step:

- **`variable`** — `defaultSeconds` becomes the observed median;
  `minSeconds`/`maxSeconds` become P10/P90, **widened** to contain the
  author's own range, the new default and any `optimalSeconds`. A
  proposed range is never narrower than the author's on either side; the
  low bound is floored and the high one ceiled so rounding cannot narrow
  it either.
- **`indefinite`** — `defaultSeconds` becomes the median and nothing
  else. An indefinite step ends when the executor says so, which is not a
  bound the plan should pretend to know.
- **`fixed`** — never a value. A fixed step's observed length only
  confirms its timer, so history can only say how *late* its planned end
  really was: the lag, measured at the moment its successor was released.
  Above `max(60 s, 10 % of planned)` the step gets
  `status: "note"`, `note: "consider variable"` and the lag — a fixed
  step that always overruns is one the author modelled wrongly, and only
  the author can decide that.

The result renders as the same table `rhylthyme calibrate` prints — step,
type, n, current, proposed, median, IQR, delta, note — followed by the
**effect if accepted**: the planned makespan before and after and whether
the critical path moves. `structuredContent` carries the whole proposal
(`{proposal, program?, accepted?, saved: false}`) for a UI to render.

Accepted values are written with their provenance beside them:

```jsonc
"duration": {
  "type": "indefinite", "defaultSeconds": 1179,
  "calibratedFrom": { "runs": 20, "asOf": "2026-09-14T00:00:00Z",
                      "programVersion": "sha256:935c4ca9…" }
}
```

`programVersion` is the plan the *measurements* were taken against, not
the one that received them: the provenance question is "which plan
produced these numbers".

The tool wraps `POST /api/mcp/calibrate` (sign-in required), which is
`rhylthyme_server.rhylthyme.calibrate` plus the I/O: it loads the
caller's `program_runs` rows when the client sent no `history`, and its
`accept` branch returns the calibrated program without saving it. That
module is a *port* of `rhylthyme_cli_runner.history.calibrate` —
rhylthyme-server must not import rhylthyme-cli-runner — pinned to it by
`rhylthyme-server/tests/fixtures/calibrate/thanksgiving-proposal.json`,
proposals the CLI produced for the Thanksgiving example that
`tests/test_calibrate_server.py` replays here.

The web editor's "Calibrate from my runs" button is the same endpoint:
it renders the proposal with a checkbox per step and, on Apply, POSTs the
accepted ids and then sends the returned program to `/api/mcp/save`.

### `import_from_source.enrich`

An importer reads structure, not meaning, so protocols.io, Cooklang and
the rest return **one track** of steps chained head-to-tail. The optional
boolean `enrich` (with `action: "import"`) sends that step list through
**turn 4 of `plan_schedule`** server-side — the same template text, from
the same `prompts.js`, rendered without its six-step tool tail — and
returns a multi-track program instead.

```jsonc
{ "source": "protocolsio", "action": "import",
  "query": "https://www.protocols.io/view/western-and-dot-blot-j569cq9h7",
  "token": "<from login>", "enrich": true }
```

What it does and does not change:

- **Kept as imported:** every `stepId`, its name, task and duration, the
  program's `programId`, `name` and `metadata.source`.
- **Inferred:** track membership and every `startTrigger`. A step the
  model adds that the source never stated (a preheat, a warm-up, a
  cooling wait) is marked `metadata.inferred = true` with
  `metadata.sourceSpan: null`; an imported step keeps
  `metadata.sourceSpan = {"quote", "occurrence"}` taken from the source
  sentence the importer preserved.
- **Recorded:** `metadata.source.enriched = true`,
  `metadata.source.enrichModel`, `metadata.source.enrichedAt`.

The result is validated with the same validator as `validate_program`,
with a bounded fix loop (at most two correction rounds). Cost and limits:
one model call (plus up to two fix calls), sign-in required like every
import, and its own rate-limit kind `enrich` at 20/day per user.
**A failed enrichment never loses the import** — the tool returns the
un-enriched program and says why, as `enrichment: {error}` on the HTTP
response and as a one-line note in the tool result.

Demonstration (plans/agent-prompt-structure.md Phase 5): protocols.io
`western-and-dot-blot-j569cq9h7`, 32 steps, 1 track on import → 3 tracks
(main western blot / sequential detergent extraction / dot blots) joined
by a cross-track `afterStep` trigger, validating unchanged. The before
and after programs are checked in at
`rhylthyme-server/tests/fixtures/enrich/{before,after}.json` and asserted
offline by `tests/test_import_enrich.py`.

### `import_text`

`import_from_source` needs a source that has structure to read. When the
user simply *has the text* — a recipe off a card, a method copied out of
a PDF, a run sheet in an email — `import_text` runs the whole four-turn
structure server-side and hands back a program with provenance.

```jsonc
{ "text": "Saturday Brunch for Four\n\nEverything on the table at ten…",
  "environmentType": "kitchen",
  "deadline": "10:00",
  "hints": "one oven, two burners, one cook",
  "token": "<from login>" }
```

| argument | required | what it does |
|---|---|---|
| `text` | yes | The source itself. Paste all of it: turn 1 reads it back, and a long source is extracted in chunks. |
| `environmentType` | yes | `kitchen` / `lab` / `events` / `gym` / `generic`. Fills the scenario prompt's environment slot and becomes the program's `environmentType`. |
| `deadline` | no | When everything must be finished. Reaches turn 1's deadline line and turn 3's "everything must be ready at …". |
| `hints` | no | Equipment and people limits in the user's words. Becomes the scenario prompt's environment phrase and the constraints turn 2 expects to declare. |
| `token` | yes | The user's Rhylthyme access token from `login`. |

**What runs.** The four turns of `plan_schedule`, from the same
`prompts.js` the prompt ships, as one conversation:

1. **T1 read-back** — the whole source, read back in a paragraph. Scored
   2 (first time) / 1 (after one retry) / 0 (never), and a 0 is recorded,
   not fatal.
2. **T2 model check** — the program model restated, and the resource
   constraints the model expects to declare. Scored the same way.
3. **T3 extraction** — the flat step list, each step carrying the exact
   words it came from. Run **once per chunk** when the source is long
   (over ~6k tokens) or when T1's read-back never mentioned the end of
   it; the step lists are then merged, deduplicated by source span, in
   chunk order.
4. **T4 relationships** — tracks, triggers and the question-refinement
   pattern, as a forced `submit_program` tool call, then the same bounded
   validator fix loop `enrich` uses.

**What comes back.** `{program, steps, turns, chunks, tokens}`:

- `program` — validated, multi-track, with
  `metadata.source = {type: "llm-text", importer, imported_at, model, turns, chunks}`
  and `metadata.importSteps` carrying the span list.
- `steps` — `[{stepId, name, sourceSpan, inferred, spanVerified}]`.
  **Every step has a `sourceSpan` or `inferred: true`**; a `sourceSpan`
  is a quoted substring plus which occurrence of it is meant, and
  `spanVerified` says whether that quote was found verbatim in the
  source (an unverified span is kept and flagged, not discarded).
- `turns` — `{t1_score, t2_score}`, the 2/1/0 scores.
- `chunks` — how many parts turn 3 was run over.
- `tokens` — `{input, output}` for the whole run.

The tool result renders the program summary, the turn scores and a
step → span table, so the user can see which words each step came from
and which steps the model inferred.

**Cost and limits.** Four model calls minimum; up to two more for the
turn retries, one more per extra chunk, and up to two validator fix
rounds. Sign-in is required, the daily cap is its own limiter kind
`import_text` at 20/day per user, and a per-call ceiling of 40k output
tokens aborts a run that is looping rather than letting it spend. A
failure answers with the turn that failed (`stage: "T1" | "T2" | "T3" |
"T4"`) and the scores and tokens spent so far.

Demonstration (plans/agent-prompt-structure.md Phase 6): the two kitchen
gold sources run through Haiku, saved at
`rhylthyme-server/tests/fixtures/import_text/*.json` and asserted offline
by `tests/test_import_text.py`. Both produced validated multi-track
programs whose every quoted span is found verbatim in the source.

### `analyze_schedule` output

```jsonc
{
  "programId": "cookies-three-trays", "name": "Three trays, one oven",
  "makespanSeconds": 4440, "makespan": "1h 14m",
  "tracks": [
    // one row per track; instance sub-tracks carry parentTrackId
    { "trackId": "cookies--bake-r1", "name": "Cookies - Bake tray (1 of 3)",
      "parentTrackId": "cookies", "startSeconds": 1620, "endSeconds": 2520,
      "busySeconds": 900, "idleSeconds": 0, "slackBeforeFinishSeconds": 1920, "steps": 1 }
  ],
  "steps": [
    { "stepId": "cool-r1", "name": "Cool on rack (1 of 3)", "trackId": "cookies--bake-r1",
      "parentTrackId": "cookies", "instanceOf": "cool", "instanceIndex": 1, "task": "rack",
      "startSeconds": 1620, "endSeconds": 2520, "durationSeconds": 900,
      "startClock": "27:00", "critical": true, "resolved": true }
  ],
  "criticalPath": ["mix", "bake-r1", "cool-r1", "bake-r3", "cool-r3", "box"],

  // One entry per critical-path edge, saying what gates it.
  // kind: "inFlight" | "maxConcurrent" | "offset" | "dependency"
  "bindingConstraints": [
    { "from": "cool-r1", "to": "bake-r3", "kind": "inFlight",
      "task": "rack", "limit": 2, "inFlightOf": "bake" }
  ],

  // Every item carries `kind`.
  //   "maxConcurrent" — more steps claim a task at one instant than its cap
  //   "inFlight"      — more instances are between a replicated step and its
  //                     barrier than `replicates.maxInFlight` allows
  "resourceConflicts": [
    { "kind": "maxConcurrent", "task": "rack", "maxConcurrent": 2, "demand": 3,
      "startSeconds": 3060, "endSeconds": 3420,
      "steps": ["cool-r1", "cool-r2", "cool-r3"], "fix": "…" },
    { "kind": "inFlight", "task": "rack", "inFlightOf": "bake", "maxInFlight": 2,
      "demand": 3, "startSeconds": 2340, "endSeconds": 2520,
      "steps": ["bake-r1", "bake-r2", "bake-r3"], "fix": "…" }
  ],

  // In-flight windows per capped replicated step: instance i runs from the
  // start of X-r<i> until the last of its "each" leaves ends.
  "inFlight": [
    { "inFlightOf": "bake", "maxInFlight": 2, "count": 3, "task": "rack",
      "leafSteps": ["cool"], "gatedSteps": ["bake-r3"],
      "peakInFlight": 2, "peakAtSeconds": 1620,
      "windows": [
        { "instanceIndex": 1, "stepId": "bake-r1", "leafStepIds": ["cool-r1"],
          "startSeconds": 900, "endSeconds": 2520 }
      ] }
  ],

  "actorPeak": { "concurrentSteps": 2, "atSeconds": 1620, "declaredActors": null },
  "wallClock": null,
  "validation": { "valid": true, "errors": [], "warnings": [] }
}
```

The text half of the result is the same content as a digest:

```
**Makespan:** 1h 14m across 4 tracks, 8 steps.
**Critical path:** Mix dough → Bake tray (1 of 3) → Cool on rack (1 of 3) → Bake tray (3 of 3) → Cool on rack (3 of 3) → Box cookies
**Binding constraints:** `rack` (in-flight ≤ 2) gates `bake-r3`.
**Peak concurrency:** 2 steps at 27:00.
**Resource conflicts:** none.

**In-flight windows (1):**
- `bake` ×3 through `rack`: maxInFlight 2, peak 2 at 27:00 — #1 15:00–42:00, #2 27:00–54:00, #3 42:00–1:09:00
```

`bindingConstraints` is what answers "why is this schedule 74 minutes?":
on the cookie example the third bake is held by the cooling **rack**
(`replicates.maxInFlight: 2`), not by the single **oven**. With no
in-flight cap declared, `inFlight` is `[]` and every edge reads
`"kind": "dependency"`.

The pure helpers `inFlightGroups(expandedProgram)`,
`inFlightWindows(expandedProgram, timings)` and
`inFlightConflicts(expandedProgram, timings)` are exported from
`schedule.js` for planners that need the same windows.

### `analyze_schedule` prediction

Every duration in a program is the author's guess. When the program has
run before, `analyze_schedule` can say what its own history says
instead. Three optional inputs turn it on:

| input | shape | meaning |
|---|---|---|
| `history` | array of run records (the `runs` schema), or a path to a runs directory / file (Python server only) | The executions to learn from. Foreign programs, abandoned runs, simulated clocks and time-scaled runs are ignored. |
| `predictionContext` | `{environmentId, userTags, userId, programVersion, minIdentical, minModel, corrThreshold, verdicts}` | The context being planned for. `userTags` are the answers to `metadata.varianceFactors`. |
| `useDurations` | `"planned"` (default) or `"predicted"` | Which durations the makespan, itinerary, critical path, conflicts and binding constraints are computed from. |
| `program_id` + `token` | a library program UUID and an access token | Convenience for "analyse this against my own history": with no `history`, the caller's recorded runs of that program are loaded (`GET /api/mcp/programs/<id>/runs?full=1`) and used. The text result says how many were found. Without a token nothing is loaded and the analysis is the plan, as ever. |

With no `history` the output is exactly what it was before prediction
existed — no extra keys — so the default answer to an agent-authored
program is still what the program says.

With history, each step that has any gets a `predicted` object, every
step gets `plannedDurationSeconds`, and four keys appear at the top:

```jsonc
{
  "makespanSeconds": 14100, "makespan": "3h 55m",   // the durations actually used
  "durationsUsed": "planned",                        // "planned" | "predicted"
  "plannedMakespanSeconds": 14100, "plannedMakespan": "3h 55m",
  "predictedMakespanSeconds": 6931, "predictedMakespan": "1h 55m",
  "predictedCriticalPath": ["stuffing-prep"],
  "steps": [
    { "stepId": "turkey-roast", "name": "Roast until 74°C",
      "durationSeconds": 9900,            // predicted when useDurations: "predicted"
      "plannedDurationSeconds": 9900,     // always what the program says
      "predicted": {
        "seconds": 1230.577, "low": 1134.873, "high": 1304.177,
        "basis": "model",        // "identical" | "model" | "none"
        "method": "ols",         // "ols" | "median"
        "n": 20,                 // measurements, not runs
        "source": "all",         // "user" | "all"
        "factors": [{ "key": "turkeyKg", "coef": 86.861 }]
      } }
  ]
}
```

**The lookup order** follows Badosa et al. (2019) §3 — identical
executions first, similar ones second:

1. **`basis: "identical"`** — runs of the same `programVersion`, the same
   `environmentId` and the same answers to every declared variance
   factor. The median of their measurements is `seconds` and P10/P90 are
   `low`/`high`. Needs `minIdentical` measurements (default 3). When
   `userId` is given and *that person* has enough of their own,
   `source` is `"user"`: one cook's kitchen is a more relevant
   distribution than 200 kitchens (PRD open question 3).
2. **`basis: "model"`** — otherwise, every usable measurement of the same
   program. Numeric factors (`userTags` numbers plus `context.serves`
   and `context.actors`) and one-hot enum factors are filtered by
   `|Pearson r| >= corrThreshold` (default 0.3), then fitted by ordinary
   least squares and evaluated at the caller's factor values; residual
   P10/P90 give the interval. `factors` lists what survived, with its
   coefficient per second. Below `minModel` measurements (default 8),
   when no factor survives, when the fit is singular, or when the caller
   cannot supply a surviving factor's value, the same basis falls back to
   the median of the measurements and says `method: "median"` with
   `factors: []`.
3. **`basis: "none"`** — the step is in `verdicts` as
   `executor-controlled`, so `seconds` is `null` and `reason` says why.
   `rhylthyme runs report` produces those verdicts; a step whose observed
   durations scatter is the person's choice, not a measurement, and
   predicting it would be a forecast of a decision. A step with no
   measurements at all simply has no `predicted` key.

Only steps the executor ended are measurements, so `fixed` steps are
never predicted — their observed length confirms a timer, nothing more.
Replicate instances pool onto their authored `stepId`, and one prediction
applies to every instance of it.

`useDurations: "predicted"` replans: the makespan, wall-clock itinerary,
critical path, resource conflicts and binding constraints all come from a
copy of the program whose durations are the predicted ones (steps with no
prediction keep theirs). This is the answer to "when do I start if we eat
at six?" once the history knows how long the roast really takes. The
planned numbers are still reported per step, so nothing is lost.

The pure helpers are exported from `schedule.js`:
`predictDurations(program, records, context)`,
`predictedSeconds(predictions)` and
`withDurations(program, {stepId: seconds})`. The lookup itself lives in
`history.js` beside the usable-run filter; its Python twin is
`rhylthyme_server/rhylthyme/predict.py`, and the two are pinned by
`rhylthyme-cli-runner/tests/fixtures/history/predict-cases.json`.

## Tool definition budget

A host pastes every tool definition into the model's context on every turn,
so `tools/list` is kept small: about 3,600 tokens of name, description and
input schema for 18 tools (it was about 9,300). Three rules keep it there, and
`index.test.js` enforces them:

- **Descriptions are one to three sentences** (400 characters at most) that
  say what the tool is for in words a user would say. The long forms live in
  `LONG_DESC` and are served, per vertical, as `rhylthyme://guide/tools`, with
  the arguments the list only names (`predictionContext`, `calibrate_program`'s
  options) spelled out.
- **No tool inlines the program JSON Schema.** Programs are accepted as loose
  objects and the validator reports problems with a code and a fix, which is
  more use to a model than a zod rejection. The shape is written out once, as a
  paragraph on `validate_program`'s `program` argument; the full schema is the
  `rhylthyme://schema/program` resource.
- **The account token is described once** (`TOKEN_DESC`) and optional
  everywhere; a connected account needs none.

When adding a tool: put the short text in `SHORT`, the long text in
`LONG_DESC`, and run `npm test`; the budget test names the tool that went over.

## Resources and prompts

- `rhylthyme://schema/program` — full JSON Schema (0.3.0-alpha; adds
  `instances: "each" | "all" | "any"` on step-referencing triggers, and
  still validates 0.1.0 / 0.2.0-alpha programs)
- `rhylthyme://guide/authoring` — one-page authoring cheat-sheet.
- `rhylthyme://guide/tools` — the long form of every tool description, per vertical (see *Tool definition budget* below).
  Its "Repeating work: per-instance chains, barriers and in-flight
  limits" section documents `replicates` (`count` / `mode` / `delay`),
  `instances: "each" | "all" | "any"`, `maxInFlight` versus
  `maxConcurrent` ("hold upstream, don't strand downstream"), the
  three-trays worked example, and the validator codes an author sees
- `rhylthyme://examples/<name>` — complete valid programs
  (`breakfast_schedule`, `lab_experiment`, `stir_fry_with_choice`,
  `hiit_cardio_workout`, `corporate_presentation`,
  `cookies_three_trays` — the 0.3.0-alpha per-instance example)
- `rhylthyme://guide/extraction` — the four turns of `plan_schedule` as
  prose, with each turn's expected output shape, for hosts that cannot
  run a multi-message prompt. Also the definition of
  `metadata.sourceSpan` (`{"quote": "...", "occurrence": n}`) and
  `metadata.inferred`
- prompt `plan_schedule(goal, finishAt?, constraints?, sourceText?)` —
  **four user messages**, not one (`mcp-api/prompts.js`):

  | turn | asks for | output shape |
  |---|---|---|
  | T1 read-back | what is being made, for how many, by when, under what limits — before any JSON exists | `{summary, servesOrScale, deadline?, constraints[]}` |
  | T2 model check | the program model restated in the model's own words, and the resource constraints it expects to declare | acknowledgement + `resourceConstraints[]` |
  | T3 extraction | every timed activity with its duration, the resource it occupies and the words it came from — no tracks, no triggers | flat step list with `sourceSpan` and `inferred` |
  | T4 relationships | tracks, triggers, a refined version of the dependency question, then the program and the tool workflow | full program JSON |

  `sourceText` is optional; when given it is embedded in T1 and T3 (the
  turns that read the source) and nowhere else, so the model reads it
  once for the read-back and once for the extraction. Without it the
  steps are extracted from `goal` alone. T2 names `replicates`,
  `instances: "each"`/`"all"` and `maxInFlight`, so "12 samples, the
  rotor holds 6" produces one replicated step rather than twelve copied
  ones. T4's tail keeps the search → build → validate → analyze →
  visualize workflow.

The templates, their slots and the renderer live in
`mcp-api/prompts.js`; `prompts.test.js` covers them, and the evaluation
harness in `rhylthyme-cli-runner` keeps parity-checked Python copies so
the prompt it measures is the prompt that ships.

The server also sends `instructions` at `initialize` describing the
workflow, so hosts that surface them need no extra system prompt. Phase 3
shortened them: the four turns live in the prompt and in
`rhylthyme://guide/extraction`, and the instructions point at both guides
rather than repeating them.

## Recommended workflow (what the instructions tell the model)

1. Existing content: `search_public_recipes` → `load_public_recipe`
   (or the one-shot). Done — the result has the URL.
2. New content: build → `validate_program` (fix every error) →
   `analyze_schedule` (optional, wall clock / conflicts) →
   `visualize_schedule`.
3. `login` only for the personal library and imports.

## Development

```bash
cd rhylthyme-server
npm install
npm test            # node --test mcp-api/  (SDK in-memory + HTTP entry-point tests, no network)
```

Layout:

- `mcp-api/index.js` — Vercel function: vertical detection, tool /
  resource / prompt registration, OG-image endpoint.
- `mcp-api/schedule.js` — validator + analyzer (pure).
- `static/js/timeline-render.js` — timing engine + SVG Gantt (shared with
  the OG image and published as a CDN asset).
- `static/schema/`, `static/examples/` — bundled resources.

Routing lives in `vercel.json` (`/mcp`, `/<vertical>/mcp` and
`/api/og/timeline.png` rewrite to `/mcp-api`). The function needs
`SUPABASE_URL` and `SUPABASE_ANON_KEY` for the OG image only; every tool
goes through `https://www.rhylthyme.com/api/*`.

## Usage analytics

`analytics.js` writes one row per JSON-RPC request (not notifications or
pings) to the Supabase `mcp_events` table after the response has been
sent. A row holds the endpoint, method, tool/resource/prompt name, the
client's self-reported `clientInfo` from `initialize`, success or error
code, latency, the Vercel country header, and a few non-content argument
fields (`source`, `action`, `environmentType`, `enrich`, which argument
keys were present). It never stores IP addresses, argument values,
program JSON, pasted text or tokens.

The server is stateless, so there is no session id. Distinct clients are
counted by `client_hash`, a salted SHA-256 of IP + User-Agent (salt:
`MCP_ANALYTICS_SALT`, falling back to the service-role key; rotating the
salt resets client identity). `user_id` is the unverified `sub` of a
login token, used only to recognise and exclude the operator's own
clients.

Recording is on when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
set; set `MCP_ANALYTICS_DISABLED=1` to turn it off. Failed inserts log a
warning and never affect the MCP response.

Setup and reporting:

```bash
# once: create the table and reporting views in the Supabase SQL editor
cat sql/mcp_events.sql

# any time: daily clients, MCP clients, tools, funnel, returning clients
.venv/bin/python rhylthyme-server/scripts/mcp_usage_report.py --days 30
```

In the SQL editor, `mcp_daily_usage`, `mcp_tool_usage_30d` and
`mcp_clients_30d` give the same numbers. All views read
`mcp_external_events`, which drops every client that ever presented the
operator's user id.

## Authorization (OAuth 2.1)

The server follows the MCP authorization spec (2025-06-18) as an OAuth
*resource server*. The *authorization server* is Supabase Auth's OAuth 2.1
server for the project, the same one that signs users in with Google, Apple
and email, so an access token is an ordinary Supabase user JWT and
www.rhylthyme.com's API validates it the way it validates the web app's.
`oauth.js` verifies no signatures and mints nothing.

| What | Where |
|---|---|
| Protected-resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource[/<path>]`, e.g. `.../lab/mcp` |
| Authorization-server metadata (RFC 8414) | Supabase: `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1`; mirrored at `/.well-known/oauth-authorization-server` for clients written against the 2025-03-26 spec |
| Consent screen | `https://www.rhylthyme.com/oauth/consent?authorization_id=...` (Flask, `oauth_consent_page`) |
| Credential | `Authorization: Bearer <token>`; tools read it through `OAuth.resolveToken()` |

**Step-up, not a wall.** The public tools (search, validate, analyze,
visualize, the one-shots) never ask for anything. Only a `tools/call` that
needs an account (`list_my_programs`, `load_program`, `save_program`,
`list_runs`, `load_run`, `calibrate_program`, `import_text`, and
`import_from_source` with `action: import|random` or the Benchling source)
and carries no credential at all is answered with `401` and
`WWW-Authenticate: Bearer resource_metadata="..."`, which is what makes an
OAuth-capable host open its Connect flow. An expired bearer token gets the
same with `error="invalid_token"` so the host refreshes it.

**The pasted-token path still works.** A `token` argument wins over the
header, so the `login` tool, the `rhylthyme` CLI and hosts without OAuth are
unaffected.

**One-time Supabase setup** (dashboard): Authentication > OAuth Server:
enable it, set the authorization path to `/oauth/consent`, and allow dynamic
client registration (hosts such as Claude register themselves). Add
`https://www.rhylthyme.com/oauth/consent` to Authentication > URL
Configuration > Redirect URLs. Asymmetric JWT signing keys are recommended.
Until that switch is on, no challenge is sent: the server probes the
authorization server's metadata before its first 401 (cached for a minute
while it fails, an hour once it works) and otherwise lets the tool answer with
the pasted-token instructions, so a host is never sent into a Connect flow
that cannot finish. Turning the switch on takes effect within a minute, with
no deploy.
`MCP_OAUTH_ISSUER` overrides the issuer; `MCP_OAUTH_DISABLED=1` turns the
challenge and the metadata off. `rhylthyme mcp-test -k oauth -k login-gate`
checks the whole chain, including whether Supabase's side is enabled.

## Preview images

`/api/og/timeline.png` and the inline image blocks rasterise
`renderTimelineSvg(program, { style: "web" })` with `@resvg/resvg-js`.
Serverless hosts have no system fonts and resvg draws no text without
one, so `mcp-api/fonts/` bundles DejaVu Sans (regular and bold, see
`LICENSE_DEJAVU`) and `vercel.json` ships it with the function
(`includeFiles`). The SVG names that face and passes
`fontWidthFactor: 1.14` so labels are fitted to its wider glyphs. A test
renders with system fonts off and fails if the text stops drawing.

## Errors and alerts

Every failed request is one JSON line in the function log, whether or not
analytics rows are being written. In Vercel > Logs, filter on `mcp-error`
(something is broken) or `mcp-warn` (a client mistake or an expected
refusal):

```
[mcp-error] {"endpoint":"lab","method":"tools/call","tool":"import_text","code":"tool_error","status":200,"ms":28114,"message":"Text import failed (failed at T4) (502): ...","client":"12b78a","ua":"claude-ai","country":"US"}
```

`mcp-error` lines are also posted to `MCP_ALERT_WEBHOOK_URL` (a Slack
incoming webhook; falls back to `SLACK_FEEDBACK_WEBHOOK_URL`). They cover
tool errors, 5xx responses, internal RPC errors and `tools/call` requests
whose arguments the input schema rejected. Alerts are throttled to one
per endpoint + tool + code every 15 minutes (the next one says how many
were suppressed) and never more than one every 20 seconds per instance.
Login-required and expired-token refusals, unknown methods from crawlers,
4xx probes and `rhylthyme mcp-test` traffic are logged but not alerted.
Set `MCP_ALERTS_DISABLED=1` to turn alerts off. The error message stays in
the log and the alert; it is never written to `mcp_events`.

To check the server end to end, run `rhylthyme mcp-test` (from
`rhylthyme-cli-runner`); add `--publish` to include a real share.

The lab, events and gym catalogs are seeded from `rhylthyme-examples` by
`scripts/seed_vertical_catalog.py` (idempotent; `--remove` undoes it).


`server.json` in this directory is the registry manifest. Publish with
the `mcp-publisher` CLI after verifying the `com.rhylthyme` namespace
(DNS TXT record on rhylthyme.com):

```bash
mcp-publisher login dns --domain rhylthyme.com --private-key <key>
mcp-publisher publish mcp-api/server.json
```

## Known limitations / next steps

- **Auth.** OAuth 2.1 is supported (see Authorization above); the copy-paste `login` token remains as the fallback for hosts that cannot connect accounts, and expires after about an hour.
- `search_public_recipes` searches one environment at a time (the
  catalog API has no "all" mode); the generic endpoint defaults to
  `kitchen` and says so.
- Four example programs in `rhylthyme-examples/programs` fail the
  validator (real within-track overlaps / unconstrained tasks):
  `academy_awards_ceremony`, `corporate_conference`,
  `software_product_launch`, `comprehensive_manual_demo`.
