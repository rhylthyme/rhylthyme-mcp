# rhylthyme-mcp

Rhylthyme schedules multi-step work that a person carries out against a clock
(several dishes landing together, a lab protocol with overlapping incubations,
an event run-of-show, a workout) and publishes it as a live timeline with
timers.

**The Rhylthyme MCP server is hosted. Most clients need nothing from this
package**: connect to the URL.

| Endpoint | For |
|---|---|
| `https://mcp.rhylthyme.com/mcp` | anything |
| `https://mcp.rhylthyme.com/kitchen/mcp` | cooking |
| `https://mcp.rhylthyme.com/lab/mcp` | lab protocols |
| `https://mcp.rhylthyme.com/events/mcp` | events |
| `https://mcp.rhylthyme.com/gym/mcp` | workouts |

- **Claude** (claude.ai, desktop, mobile): Settings → Connectors → Add custom connector → paste a URL.
- **ChatGPT**: Settings → Apps & Connectors → Advanced settings → Developer mode → create a connector with a URL.
- **Claude Code**: `claude mcp add --transport http rhylthyme https://mcp.rhylthyme.com/mcp`
- **Cursor** and others: `{ "mcpServers": { "rhylthyme": { "url": "https://mcp.rhylthyme.com/mcp" } } }`

No account or API key is needed for the public tools (validate, analyze,
publish a timeline, search the catalog).

## What this package is

A stdio bridge, for clients that can only launch a command. It speaks MCP on
stdin/stdout and passes every request through to the hosted server, so you
always get the current tools, resources and prompts.

```bash
pip install rhylthyme-mcp        # or: pipx install rhylthyme-mcp / uvx rhylthyme-mcp
```

```json
{
  "mcpServers": {
    "rhylthyme": { "command": "rhylthyme-mcp", "args": ["kitchen"] }
  }
}
```

`args` is optional: `kitchen`, `lab`, `events`, `gym`, or nothing for the
general endpoint. `--url` (or `RHYLTHYME_MCP_URL`) points it at a server you
host yourself. `RHYLTHYME_TOKEN`, if set, is sent as a bearer token; only the
account tools (your saved programs, recorded runs, imports) need one.

## No MCP client at all

One HTTP request works, with no handshake and no account:

```bash
curl -s https://mcp.rhylthyme.com/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or the command-line tool: `pip install rhylthyme-cli-runner`, then
`rhylthyme validate`, `rhylthyme analyze --finish-at 18:00`,
`rhylthyme publish` (prints the live-timeline URL).

## Versions

0.1.2 is 0.1.1 with its license metadata corrected: the package is Apache-2.0,
like the rest of Rhylthyme.


0.1.0 was a local server with a single `visualize_schedule` tool that opened an
HTML file in your browser. 0.1.1 replaces it with the bridge: the same
`rhylthyme-mcp` command and the same client configuration, but every tool of
the hosted server, and links to live timelines instead of local files.

Docs: https://docs.rhylthyme.com/web-app/mcp/ · Source:
https://github.com/rhylthyme/rhylthyme-mcp (`python/`) · License: Apache-2.0
