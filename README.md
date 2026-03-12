# Rhylthyme MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for creating interactive schedule visualizations on [rhylthyme.com](https://www.rhylthyme.com).

Describe a multi-step process — cooking a meal, running a lab protocol, coordinating an event — and get a shareable interactive timeline with parallel tracks, dependencies, resource constraints, and a live execution timer.

## Endpoint

```
https://mcp.rhylthyme.com/mcp
```

Transport: **Streamable HTTP**

## Tools

### `visualize_schedule`

Create an interactive schedule visualization. Takes a Rhylthyme program JSON with tracks, steps, durations, triggers, and resource constraints. Returns a shareable URL on rhylthyme.com.

### `import_from_source`

Import a recipe or protocol from external sources:
- **spoonacular** — recipes (preferred)
- **themealdb** — recipes (fallback)
- **protocolsio** — lab protocols

Actions: `search`, `import`, `random`

### `create_environment`

Define a workspace with resource constraints (e.g., a kitchen with 1 oven and 2 burners, or a lab with 3 centrifuges).

## Setup

### Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rhylthyme": {
      "type": "url",
      "url": "https://mcp.rhylthyme.com/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add rhylthyme --transport http https://mcp.rhylthyme.com/mcp
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rhylthyme": {
      "url": "https://mcp.rhylthyme.com/mcp"
    }
  }
}
```

## Example

> "Schedule a Thanksgiving dinner for 12 with turkey, stuffing, three sides, and pie — we have one oven and two stove burners."

Returns an interactive timeline visualization showing parallel tracks for oven, stovetop, and prep work, with step dependencies and resource constraints. The visualization is shareable via URL and can be run as a live timer.

## Links

- [rhylthyme.com](https://www.rhylthyme.com) — Web app
- [Rhylthyme on GitHub](https://github.com/rhylthyme) — Organization
