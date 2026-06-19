import assert from "node:assert/strict";
import test from "node:test";

import { streamGatewayBridgeTurn } from "./gatewayRunner.mjs";

const TOKEN_KEYS = [
  "AURELIUS_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "AURELIUS_GATEWAY_URL",
  "AURELIUS_GATEWAY_MODEL",
  "AURELIUS_GATEWAY_TOKEN_DISK_RESYNC",
];

function withEnv(overrides, fn) {
  const saved = new Map();
  for (const key of TOKEN_KEYS) saved.set(key, process.env[key]);
  for (const key of TOKEN_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of TOKEN_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function sseChunk(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

// A fetch double whose response can flip per call (drives the 401→retry path).
function scriptedFetch(steps) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (!step.ok) {
      return { ok: false, status: step.status, text: async () => step.errorText || "", body: null };
    }
    const chunks = step.chunks || [sseChunk("ok"), "data: [DONE]\n\n"];
    return {
      ok: true,
      status: 200,
      text: async () => chunks.join(""),
      body: (async function* () {
        for (const c of chunks) yield c;
      })(),
    };
  };
  return { fetchImpl, calls };
}

async function collect(gen) {
  const out = [];
  for await (const d of gen) out.push(d);
  return out;
}

test("flag OFF (default): uses the env token, never reads disk", async () => {
  await withEnv({ AURELIUS_GATEWAY_TOKEN: "env-tok" }, async () => {
    const { fetchImpl, calls } = scriptedFetch([{ ok: true, chunks: [sseChunk("hi"), "data: [DONE]\n\n"] }]);
    let diskReads = 0;
    const deltas = await collect(
      streamGatewayBridgeTurn({
        messages: [{ role: "user", content: "x" }],
        sessionId: "s",
        fetchImpl,
        readDiskToken: async () => {
          diskReads += 1;
          return "disk-tok";
        },
      }),
    );
    assert.deepEqual(deltas, ["hi"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.authorization, "Bearer env-tok");
    assert.equal(diskReads, 0);
  });
});

test("flag ON: prefers the disk token over a stale env token", async () => {
  await withEnv(
    { AURELIUS_GATEWAY_TOKEN: "stale-env", AURELIUS_GATEWAY_TOKEN_DISK_RESYNC: "on" },
    async () => {
      const { fetchImpl, calls } = scriptedFetch([{ ok: true, chunks: [sseChunk("yo"), "data: [DONE]\n\n"] }]);
      const deltas = await collect(
        streamGatewayBridgeTurn({
          messages: [{ role: "user", content: "x" }],
          sessionId: "s",
          fetchImpl,
          readDiskToken: async () => "fresh-disk",
        }),
      );
      assert.deepEqual(deltas, ["yo"]);
      assert.equal(calls[0].init.headers.authorization, "Bearer fresh-disk");
    },
  );
});

test("flag ON: 401 then re-reads disk and retries once with the rotated token", async () => {
  await withEnv({ AURELIUS_GATEWAY_TOKEN_DISK_RESYNC: "on" }, async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { ok: false, status: 401, errorText: "unauthorized" },
      { ok: true, chunks: [sseChunk("recovered"), "data: [DONE]\n\n"] },
    ]);
    let read = 0;
    const tokens = ["rotated-old", "rotated-new"]; // first resolve, then refresh
    const deltas = await collect(
      streamGatewayBridgeTurn({
        messages: [{ role: "user", content: "x" }],
        sessionId: "s",
        fetchImpl,
        readDiskToken: async () => tokens[Math.min(read++, tokens.length - 1)],
      }),
    );
    assert.deepEqual(deltas, ["recovered"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers.authorization, "Bearer rotated-old");
    assert.equal(calls[1].init.headers.authorization, "Bearer rotated-new");
  });
});

test("flag ON: 401 but the disk token is unchanged → no retry, surfaces the error", async () => {
  await withEnv({ AURELIUS_GATEWAY_TOKEN_DISK_RESYNC: "on" }, async () => {
    const { fetchImpl, calls } = scriptedFetch([{ ok: false, status: 401, errorText: "nope" }]);
    await assert.rejects(
      () =>
        collect(
          streamGatewayBridgeTurn({
            messages: [{ role: "user", content: "x" }],
            sessionId: "s",
            fetchImpl,
            readDiskToken: async () => "same-tok",
          }),
        ),
      /rejected the bridge token \(401\)/,
    );
    assert.equal(calls.length, 1);
  });
});
