// Rhylthyme MCP Server (Streamable HTTP)
// Deployed at https://mcp.rhylthyme.com/mcp
// Uses @vercel/node with mcp-handler

const { z } = require("zod");

const API_BASE = "https://www.rhylthyme.com";

let handlerPromise;

function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const { createMcpHandler } = await import("mcp-handler");

      const webHandler = createMcpHandler(
        (server) => {
          server.tool(
            "visualize_schedule",
            "Create an interactive schedule visualization on rhylthyme.com. Takes a Rhylthyme program JSON with tracks, steps, durations, triggers, and resource constraints. Returns a shareable URL. Use for cooking schedules, lab protocols, event coordination, or any multi-step timed process.",
            {
              program: z.object({
                schemaVersion: z.string().default("0.1.0"),
                programId: z.string().describe("Kebab-case identifier"),
                name: z.string().describe("Human-readable name"),
                description: z.string().optional(),
                environmentType: z.string().optional(),
                actors: z.number().int().optional(),
                tracks: z.array(z.object({
                  trackId: z.string(),
                  name: z.string(),
                  description: z.string().optional(),
                  steps: z.array(z.object({
                    stepId: z.string(),
                    name: z.string(),
                    description: z.string().optional(),
                    task: z.string(),
                    duration: z.object({
                      type: z.enum(["fixed", "variable", "indefinite"]),
                      seconds: z.number().int().optional(),
                      minSeconds: z.number().int().optional(),
                      maxSeconds: z.number().int().optional(),
                      defaultSeconds: z.number().int().optional(),
                      triggerName: z.string().optional(),
                    }),
                    startTrigger: z.object({
                      type: z.enum(["programStart", "afterStep", "programStartOffset", "manual"]),
                      stepId: z.string().optional(),
                      offsetSeconds: z.number().int().optional(),
                    }),
                  })),
                })),
                resourceConstraints: z.array(z.object({
                  task: z.string(),
                  maxConcurrent: z.number().int(),
                  description: z.string().optional(),
                })).optional(),
                metadata: z.object({
                  ingredients: z.array(z.object({
                    name: z.string(),
                    measure: z.string(),
                  })).optional(),
                  serves: z.string().optional(),
                  sourceUrl: z.string().optional(),
                  attribution: z.string().optional(),
                }).optional(),
              }),
            },
            async ({ program }) => {
              try {
                const shareResp = await fetch(`${API_BASE}/api/share`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ program }),
                });

                if (shareResp.ok) {
                  const shareData = await shareResp.json();
                  const shareUrl = shareData.url || `${API_BASE}?share=${shareData.shareId}`;
                  const trackCount = program.tracks.length;
                  const stepCount = program.tracks.reduce((sum, t) => sum + t.steps.length, 0);
                  const tracksSummary = program.tracks
                    .map((t) => `  - **${t.name}**: ${t.steps.map((s) => s.name).join(", ")}`)
                    .join("\n");

                  return {
                    content: [{
                      type: "text",
                      text: `Visualization for "${program.name}" created!\n\n**URL:** ${shareUrl}\n\n**Schedule:** ${trackCount} tracks, ${stepCount} steps (${program.environmentType || "general"})\n\n**Tracks:**\n${tracksSummary}`,
                    }],
                  };
                }

                return { content: [{ type: "text", text: `Error creating share link: ${shareResp.status}` }] };
              } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message || e}` }] };
              }
            },
          );

          server.tool(
            "import_from_source",
            "Import a recipe or protocol from external sources. Sources: spoonacular (recipes, preferred), themealdb (recipes, fallback), protocolsio (lab protocols). Actions: search, import, random.",
            {
              source: z.enum(["themealdb", "protocolsio", "spoonacular"]),
              action: z.enum(["search", "import", "random"]),
              query: z.string().optional(),
            },
            async ({ source, action, query }) => {
              try {
                let url, options;
                if (action === "search") {
                  url = `${API_BASE}/api/import/search`;
                  options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, query }) };
                } else if (action === "import") {
                  url = `${API_BASE}/api/import`;
                  options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, query }) };
                } else {
                  url = `${API_BASE}/api/import/random`;
                  options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) };
                }
                const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
                if (!resp.ok) return { content: [{ type: "text", text: `Error (${resp.status}): ${await resp.text()}` }] };
                const data = await resp.json();
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
              } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message || e}` }] };
              }
            },
          );

          server.tool(
            "create_environment",
            "Create a Rhylthyme environment definition with resource constraints for a workspace (lab, kitchen, bakery, etc.).",
            {
              name: z.string(),
              type: z.enum(["kitchen", "laboratory", "bakery", "airport", "restaurant", "manufacturing", "hospital", "workshop", "general"]),
              description: z.string().optional(),
              resourceConstraints: z.array(z.object({
                task: z.string(),
                maxConcurrent: z.number().int().min(1),
                description: z.string().optional(),
              })),
            },
            async ({ name, type, description, resourceConstraints }) => {
              const envId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              const env = { environmentId: envId, name, description: description || "", type, resourceConstraints, actors: 1 };
              const summary = resourceConstraints.map((rc) => `  - ${rc.task}: max ${rc.maxConcurrent}`).join("\n");
              return {
                content: [{
                  type: "text",
                  text: `Environment "${name}" created!\n\n**Type:** ${type}\n**Resources:**\n${summary}\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\``,
                }],
              };
            },
          );
        },
        { serverInfo: { name: "rhylthyme-mcp", version: "1.0.0" } },
        { basePath: "" },
      );

      return webHandler;
    })();
  }
  return handlerPromise;
}

// Vercel serverless handler — converts Node.js req/res to Web API Request/Response
module.exports = async function handler(req, res) {
  const webHandler = await getHandler();

  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "www.rhylthyme.com";
  const url = `${protocol}://${host}${req.url}`;

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
      Object.entries(req.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
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
