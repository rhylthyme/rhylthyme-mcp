#!/usr/bin/env node
// Standalone runner for the Rhylthyme MCP server.
//
//   PORT=3000 node src/index.js
//
// Serves the same handler that runs at https://mcp.rhylthyme.com on Vercel:
//   POST /mcp             generic endpoint
//   POST /kitchen/mcp     cooking vertical
//   POST /lab/mcp         laboratory vertical
//   POST /events/mcp      events vertical
//   POST /gym/mcp         training vertical
//   GET  /api/og/timeline.png?share=<id>|program=<id>   PNG preview
//        (needs SUPABASE_URL and SUPABASE_ANON_KEY; every other route does not)
//
// The tools call the public rhylthyme.com API for catalog search, sharing and
// imports; validation and timing analysis run locally in this process.
"use strict";

const http = require("http");
const handler = require("../mcp-api/index.js");

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((e) => {
    console.error("handler error:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify({ error: e && e.message ? e.message : "Internal server error" }));
  });
});

server.listen(port, () => {
  console.log(`Rhylthyme MCP server listening on http://localhost:${port}/mcp`);
  console.log("verticals: /kitchen/mcp /lab/mcp /events/mcp /gym/mcp");
});
