# Rhylthyme MCP server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
schedules that a person executes: cooking several dishes so they finish
together, running a bench protocol with overlapping incubations, calling
an event, running a workout. An agent describes the process, the server
validates and analyzes the resulting program, and publishes it as a live
timeline on [rhylthyme.com](https://www.rhylthyme.com) that the person
follows on their phone.

This repository is the source of the server that runs at
`mcp.rhylthyme.com`. It is the same code as `mcp-api/` in the
rhylthyme-server application, copied here with the static assets it
needs so it can be read, tested and self-hosted.

## Endpoints

| URL | Server name | Adds |
|---|---|---|
| `https://mcp.rhylthyme.com/mcp` | `rhylthyme-mcp` | generic scheduler |
| `https://mcp.rhylthyme.com/kitchen/mcp` | `rhylthyme-kitchen-mcp` | `cook_recipe`, `whats_for_dinner` |
| `https://mcp.rhylthyme.com/lab/mcp` | `rhylthyme-lab-mcp` | `run_protocol`, `random_protocol`, Benchling import |
| `https://mcp.rhylthyme.com/events/mcp` | `rhylthyme-events-mcp` | `plan_event`, `random_event_template` |
| `https://mcp.rhylthyme.com/gym/mcp` | `rhylthyme-gym-mcp` | `start_workout`, `surprise_workout` |

Transport: Streamable HTTP, stateless. No sign-in is needed for the public
catalog or the pure tools; account tools take a per-user token from the
`login` tool. Server `instructions` describing the workflow are sent at
`initialize`.

## Connect

**Claude Code**

```bash
claude mcp add --transport http rhylthyme https://mcp.rhylthyme.com/mcp
claude mcp add --transport http rhylthyme-kitchen https://mcp.rhylthyme.com/kitchen/mcp
```

**Claude Desktop / claude.ai**: Settings → Connectors → *Add custom
connector* → paste one of the URLs above. Public tools work immediately;
run `login` only to save to your own account.

**Cursor** (`.cursor/mcp.json`):

```json
{ "mcpServers": { "rhylthyme": { "url": "https://mcp.rhylthyme.com/kitchen/mcp" } } }
```

**Claude API** (MCP connector, one request):

```python
import anthropic
client = anthropic.Anthropic()
resp = client.beta.messages.create(
    model="claude-opus-5", max_tokens=16000,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{"type": "url", "url": "https://mcp.rhylthyme.com/kitchen/mcp", "name": "rhylthyme"}],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "rhylthyme"}],
    messages=[{"role": "user", "content": "Plan Thanksgiving for 8 with one oven, dinner at 6pm."}],
)
```

## Tools

| Tool | Annotations | What it does |
|---|---|---|
| `validate_program` | read-only, pure | Structural and scheduling checks (duplicate/missing ids, dangling references, cycles, within-track overlaps, tasks without a resource constraint, unparseable durations, choice references). Every finding carries a `code`, `message` and `fix` hint. Structured output. |
| `analyze_schedule` | read-only, pure | Resolved start/end per step, makespan, the dependency chain that determines it, resource-conflict windows, per-track slack, peak concurrency vs. declared actors. Pass `finishAt` or `startAt` (ISO 8601) for wall-clock start times. Structured output. |
| `visualize_schedule` | publishes | Validates (refuses invalid programs unless `allowInvalid`), creates a share record, returns a markdown preview (cover image, equipment, ingredients, ASCII Gantt, itinerary, schedule check), an inline PNG of the timeline and the live URL. Structured output. |
| `preview_timeline` | publishes a share record | PNG of the timeline only, no prose. |
| `search_public_recipes` | read-only | Keyword search over the public catalog; `environment` selects kitchen (default), laboratory, event or gym. Structured output. |
| `load_public_recipe` | read-only | Full summary and live URL for one catalog entry. |
| `cook_recipe` / `run_protocol` / `plan_event` / `start_workout` | read-only | One-shot on each vertical: top catalog match → live URL. |
| `whats_for_dinner` / `random_protocol` / `random_event_template` / `surprise_workout` | read-only | Random catalog pick on each vertical. |
| `import_from_source` | read-only | Spoonacular, TheMealDB, protocols.io, Cooklang, Opentrons Protocol API scripts, Benchling → validated program JSON. `search` needs no token; `import` and `random` need the user's token. |
| `create_environment` | pure | Equipment limits and actor types → environment JSON. |
| `login` | — | Returns the sign-in URL, then verifies a pasted token. |
| `list_my_programs`, `load_program`, `save_program` | account | The user's own library; `save_program` validates first. |
| `get_renderer_source` | read-only | Source of the Apache-2.0 timeline renderer, for HTML artifacts whose sandbox blocks external scripts. |

Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) are set on every tool; four tools also declare an
`outputSchema` and return `structuredContent`. Failures set `isError`
and say what to do next.

## Resources and prompt

- `rhylthyme://schema/program`: the program JSON Schema (0.2.0-alpha)
- `rhylthyme://guide/authoring`: one-page authoring rules, trigger vocabulary, how to make tracks finish together, choice branching
- `rhylthyme://examples/{breakfast_schedule, lab_experiment, stir_fry_with_choice, hiit_cardio_workout, corporate_presentation}`: complete valid programs
- prompt `plan_schedule(goal, finishAt?, constraints?)`: walks the model through search → build → validate → analyze → visualize

## What a program looks like

```json
{
  "schemaVersion": "0.1.0",
  "programId": "eggs-and-toast",
  "name": "Eggs and toast",
  "tracks": [
    { "trackId": "eggs", "name": "Eggs", "steps": [
      { "stepId": "whisk", "name": "Whisk", "task": "prep",
        "duration": { "type": "fixed", "seconds": 60 },
        "startTrigger": { "type": "programStart" } },
      { "stepId": "cook", "name": "Cook", "task": "stove",
        "duration": { "type": "variable", "minSeconds": 120, "maxSeconds": 240, "defaultSeconds": 180 },
        "startTrigger": { "type": "afterStep", "stepId": "whisk" } } ] },
    { "trackId": "toast", "name": "Toast", "steps": [
      { "stepId": "toast", "name": "Toast", "task": "toaster",
        "duration": { "type": "fixed", "seconds": 180 },
        "startTrigger": { "type": "afterStep", "stepId": "cook", "event": "start", "offsetSeconds": 60 } } ] }
  ],
  "resourceConstraints": [
    { "task": "prep", "maxConcurrent": 1 },
    { "task": "stove", "maxConcurrent": 2 },
    { "task": "toaster", "maxConcurrent": 1 }
  ]
}
```

Steps in one track run sequentially; parallel work goes in separate
tracks; every `task` needs a resource constraint; durations and offsets
take seconds or strings like `"5m"`. Triggers: `programStart`,
`programStartOffset`, `afterStep` (end or `event: "start"`, signed offset),
`afterStepWithBuffer`, `manual`, `onAbort`, or `{logic: all|any, triggers}`.
Durations: `fixed`, `variable` (ended early by the executor), `indefinite`
(ended by the executor).

## Self-hosting

```bash
git clone https://github.com/rhylthyme/rhylthyme-mcp
cd rhylthyme-mcp
npm install            # Node 20 or newer
npm test                 # SDK in-memory + HTTP entry-point tests, no network
PORT=3000 npm start      # http://localhost:3000/mcp and the four vertical paths
```

Docker: `docker build -t rhylthyme-mcp . && docker run -p 3000:3000 rhylthyme-mcp`.
Vercel: `vercel` in the repository root; `vercel.json` rewrites the endpoint
paths to the function.

What self-hosting does and does not give you: validation, timing analysis,
the renderer, resources and prompts run in your process. Catalog search,
sharing (`visualize_schedule`), imports and account tools call the public
API at `https://www.rhylthyme.com` (`API_BASE` in `mcp-api/index.js`), so
those still depend on the hosted service. The PNG preview route
`/api/og/timeline.png` additionally needs `SUPABASE_URL` and
`SUPABASE_ANON_KEY` for read access to shared programs; nothing else does.

## Layout

- `mcp-api/index.js`: tool, resource and prompt registration; vertical detection; OG-image route; Vercel handler
- `mcp-api/schedule.js`: validator and analyzer (pure)
- `static/js/timeline-render.js`: timing engine and SVG Gantt (also published as [`@rhylthyme/timeline`](https://github.com/rhylthyme/rhylthyme-timeline))
- `static/schema/`, `static/examples/`: the resources
- `src/index.js`: standalone HTTP runner
- `mcp-api/server.json`: MCP registry manifest

## Known limitations

- `login` hands the user a URL and expects a pasted, short-lived access token that then travels as a tool argument; it is outside MCP's OAuth 2.1 flow. Hosts that require OAuth for authenticated servers can still use every public tool.
- `search_public_recipes` searches one environment at a time; the generic endpoint defaults to kitchen.
- Tool annotations are self-declared hints; hosts may ignore them.

## License

MIT (this repository). The renderer in `static/js/timeline-render.js`
carries its own Apache-2.0 header.
