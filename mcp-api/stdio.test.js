// src/stdio.js: a real client over stdio sees the same server as over HTTP.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");

async function connect(args) {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "stdio.js"), ...args],
    cwd: ROOT,
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  return client;
}

test("stdio: lists the tools, resources and prompt, and validates a program", async () => {
  const client = await connect([]);
  try {
    assert.strictEqual(client.getServerVersion().name, "rhylthyme-mcp");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["validate_program", "analyze_schedule", "visualize_schedule", "search_public_recipes"]) {
      assert.ok(tools.includes(name), name);
    }
    assert.ok((await client.listResources()).resources.length > 0);
    assert.ok((await client.listPrompts()).prompts.some((p) => p.name === "plan_schedule"));
    const program = {
      programId: "tea", name: "Tea",
      tracks: [{ trackId: "k", name: "Kettle", steps: [
        { stepId: "boil", name: "Boil", task: "kettle", duration: 180, startTrigger: { type: "programStart" } },
        { stepId: "steep", name: "Steep", task: "kettle", duration: "4m", startTrigger: { type: "afterStep", stepId: "boil" } },
      ] }],
      resourceConstraints: [{ task: "kettle", maxConcurrent: 1 }],
    };
    const result = await client.callTool({ name: "validate_program", arguments: { program } });
    assert.match(result.content[0].text, /valid/i);
    assert.ok(!result.isError);
  } finally {
    await client.close();
  }
});

test("stdio: a vertical argument serves that vertical", async () => {
  const client = await connect(["kitchen"]);
  try {
    assert.strictEqual(client.getServerVersion().name, "rhylthyme-kitchen-mcp");
  } finally {
    await client.close();
  }
});
