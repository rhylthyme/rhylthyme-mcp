#!/usr/bin/env node
// Stdio runner for the Rhylthyme MCP server: the same tools, resources and
// prompts as the HTTP endpoints, for clients that start a local process
// (Claude Desktop, mcp-proxy, Glama's inspector).
//
//   node src/stdio.js                  generic server
//   node src/stdio.js kitchen          cooking vertical (also lab, events, gym)
//   RHYLTHYME_VERTICAL=lab node src/stdio.js
//
// stdout carries the protocol, so anything else goes to stderr.
"use strict";

console.log = console.error;

const api = require("../mcp-api/index.js");

const requested = process.argv[2] || process.env.RHYLTHYME_VERTICAL || "generic";
const vertical = api._VERTICALS[requested] ? requested : "generic";
if (vertical !== requested) console.error(`Unknown vertical "${requested}"; serving the generic server.`);

(async () => {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(
    async () => {
      const server = new McpServer(api._serverInfoFor(vertical), {
        instructions: api._serverInstructions(vertical),
      });
      api._registerAll(server, vertical);
      return server;
    },
    { onerror: (e) => console.error("mcp stdio error:", e) },
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
