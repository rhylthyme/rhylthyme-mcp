# Changelog

## v1.3.0 (2026-09-09)

Repository synchronized with the code running at mcp.rhylthyme.com.

- Five endpoints from one implementation: `/mcp` plus `/kitchen/mcp`, `/lab/mcp`, `/events/mcp`, `/gym/mcp`, each adding a one-shot tool and a random pick
- New tools: `validate_program` (coded findings with fix hints), `analyze_schedule` (makespan, critical chain, resource-conflict windows, wall-clock anchoring), `preview_timeline`, `search_public_recipes`, `load_public_recipe`, `login`, `list_my_programs`, `load_program`, `save_program`, `get_renderer_source`
- `visualize_schedule` validates before publishing and refuses invalid programs by default (`allowInvalid` overrides); returns markdown preview, inline PNG and live URL
- `import_from_source` adds Cooklang, Opentrons and Benchling sources and explains when a token is needed
- Tools registered with titles and MCP annotations; structured output on validation, analysis, search and publication; server `instructions` at initialize
- Resources (`rhylthyme://schema/program`, `rhylthyme://guide/authoring`, five example programs) and the `plan_schedule` prompt
- Timeline renderer draws cross-track dependency arrows and marks indefinite, variable and manual steps
- Tests: SDK in-memory transport and HTTP entry point, no network
- `mcp-api/server.json` registry manifest; standalone runner, Dockerfile and `vercel.json` updated

## v1.0.0 (2026-03-11)

- Initial release
- Tools: `visualize_schedule`, `import_from_source`, `create_environment`
- Streamable HTTP transport via `mcp-handler`
- Deployable standalone or as a Vercel serverless function
