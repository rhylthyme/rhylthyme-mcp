// node --test mcp-api/
//
// /api/og/timeline.png?share=… reads the share through the
// get_shared_program RPC (shared_programs is not listable), falls back to the
// old table read only while the function is missing (404 / PGRST202), and
// never sends a malformed id to Supabase. fetch is stubbed: no network.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://db.example.test";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon-test-key";

const handler = require("./index.js");

const PROGRAM = {
  schemaVersion: "0.1.0", programId: "tea", name: "Tea",
  tracks: [{ trackId: "t", name: "Kettle", steps: [
    { stepId: "boil", name: "Boil", task: "kettle", duration: { type: "fixed", seconds: 120 }, startTrigger: { type: "programStart" } },
  ] }],
  resourceConstraints: [{ task: "kettle", maxConcurrent: 1 }],
};

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b; };
  return res;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function withFetch(stub, fn) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    return stub(String(url), options || {}, calls.length);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = realFetch;
  }
}

async function og(query) {
  const res = fakeRes();
  await handler({ url: `/api/og/timeline.png?${query}`, headers: { host: "www.rhylthyme.com" } }, res);
  return res;
}

test("og timeline reads a share through get_shared_program", async () => {
  await withFetch(() => jsonResponse(200, [{ share_id: "0123456789abcdef", program_json: PROGRAM }]), async (calls) => {
    const res = await og("share=0123456789abcdef");
    assert.equal(res.statusCode, 200, String(res.body));
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://db.example.test/rest/v1/rpc/get_shared_program");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_share_id: "0123456789abcdef" });
    assert.ok(!calls.some((c) => c.url.includes("/rest/v1/shared_programs")));
  });
});

test("og timeline accepts the 8-hex ids older mobile builds created", async () => {
  await withFetch(() => jsonResponse(200, [{ program_json: PROGRAM }]), async (calls) => {
    const res = await og("share=0123abcd");
    assert.equal(res.statusCode, 200, String(res.body));
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_share_id: "0123abcd" });
  });
});

test("og timeline: an unknown share is 404 and nothing else is tried", async () => {
  await withFetch(() => jsonResponse(200, []), async (calls) => {
    const res = await og("share=ffffffffffffffff");
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 1);
  });
});

test("og timeline falls back to the table read only while the RPC is missing (PGRST202)", async () => {
  await withFetch((url, _o, n) => (n === 1
    ? jsonResponse(404, { code: "PGRST202", message: "Could not find the function public.get_shared_program" })
    : jsonResponse(200, [{ program_json: PROGRAM }])), async (calls) => {
    const res = await og("share=0123456789abcdef");
    assert.equal(res.statusCode, 200, String(res.body));
    assert.equal(calls.length, 2);
    assert.equal(
      calls[1].url,
      "https://db.example.test/rest/v1/shared_programs?share_id=eq.0123456789abcdef&select=program_json&limit=1",
    );
  });
});

test("og timeline does not fall back on other RPC errors", async () => {
  for (const [status, body] of [[401, { code: "42501" }], [404, { code: "PGRST116" }], [500, { code: "XX000" }]]) {
    await withFetch(() => jsonResponse(status, body), async (calls) => {
      const res = await og("share=0123456789abcdef");
      assert.equal(res.statusCode, 502, `${status} ${body.code}`);
      assert.equal(calls.length, 1);
    });
  }
});

test("og timeline rejects malformed share ids without fetching", async () => {
  const bad = ["x*", "abc&select=*", "0123456789ABCDEF", "0123abc", "0123456789abcdef0",
    "0123456789abcdef0123456789abcdef", "0123abcd0"];
  await withFetch(() => { throw new Error("no fetch expected"); }, async (calls) => {
    for (const id of bad) {
      const res = await og(`share=${encodeURIComponent(id)}`);
      assert.equal(res.statusCode, 404, id);
    }
    assert.equal(calls.length, 0);
  });
});

test("og timeline program path is unchanged", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  await withFetch(() => jsonResponse(200, [{ program_json: PROGRAM }]), async (calls) => {
    const res = await og(`program=${id}`);
    assert.equal(res.statusCode, 200, String(res.body));
    assert.equal(
      calls[0].url,
      `https://db.example.test/rest/v1/programs?id=eq.${id}&is_public=eq.true&select=program_json&limit=1`,
    );
  });
});
