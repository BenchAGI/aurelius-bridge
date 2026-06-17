import assert from "node:assert/strict";
import test from "node:test";

import { streamGatewayBridgeTurn } from "./gatewayRunner.mjs";

const TOKEN_KEYS = [
  "AURELIUS_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "AURELIUS_GATEWAY_URL",
  "AURELIUS_GATEWAY_MODEL",
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

// A fetch double that returns a streaming SSE body from the given chunks and
// records the single call it received.
function sseFetch(chunks, { ok = true, status = 200, errorText = "" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (!ok) {
      return { ok: false, status, text: async () => errorText, body: null };
    }
    return {
      ok: true,
      status,
      text: async () => chunks.join(""),
      body: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    };
  };
  return { fetchImpl, calls };
}

function sseChunk(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

async function collect(gen) {
  const out = [];
  for await (const delta of gen) out.push(delta);
  return out;
}

test("streams gateway SSE deltas and posts the keyed agent-turn contract", async () => {
  await withEnv({ AURELIUS_GATEWAY_TOKEN: "tok-123" }, async () => {
    const { fetchImpl, calls } = sseFetch([
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
      sseChunk("Hello"),
      sseChunk(", world"),
      "data: [DONE]\n\n",
    ]);

    const deltas = await collect(
      streamGatewayBridgeTurn({
        messages: [{ role: "user", content: "hi" }],
        sessionId: "sess-abc",
        seedContent: "SEED",
        fetchImpl,
      }),
    );

    assert.deepEqual(deltas, ["Hello", ", world"]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:18789/v1/chat/completions");
    assert.equal(calls[0].init.headers.authorization, "Bearer tok-123");

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.stream, true);
    assert.equal(body.user, "sess-abc");
    assert.equal(body.model, "openclaw");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /SEED/);
    assert.deepEqual(body.messages[1], { role: "user", content: "hi" });
  });
});

test("requires a gateway token", async () => {
  await withEnv({}, async () => {
    await assert.rejects(
      () =>
        collect(
          streamGatewayBridgeTurn({ messages: [{ role: "user", content: "hi" }], sessionId: "s", fetchImpl: async () => {
            throw new Error("should not be called");
          } }),
        ),
      /requires a gateway operator token/,
    );
  });
});

test("surfaces a clear error when the gateway rejects the token", async () => {
  await withEnv({ AURELIUS_GATEWAY_TOKEN: "bad" }, async () => {
    const { fetchImpl } = sseFetch([], { ok: false, status: 401, errorText: "unauthorized" });
    await assert.rejects(
      () => collect(streamGatewayBridgeTurn({ messages: [{ role: "user", content: "hi" }], sessionId: "s", fetchImpl })),
      /rejected the bridge token \(401\)/,
    );
  });
});

test("reassembles SSE events split across chunk boundaries", async () => {
  await withEnv({ AURELIUS_GATEWAY_TOKEN: "tok" }, async () => {
    const full = sseChunk("split-delta");
    const mid = Math.floor(full.length / 2);
    const { fetchImpl } = sseFetch([full.slice(0, mid), full.slice(mid), "data: [DONE]\n\n"]);

    const deltas = await collect(
      streamGatewayBridgeTurn({ messages: [{ role: "user", content: "hi" }], sessionId: "s", fetchImpl }),
    );
    assert.deepEqual(deltas, ["split-delta"]);
  });
});

test("honors AURELIUS_GATEWAY_URL and AURELIUS_GATEWAY_MODEL overrides", async () => {
  await withEnv(
    { AURELIUS_GATEWAY_TOKEN: "t", AURELIUS_GATEWAY_URL: "http://gw.local:9999/", AURELIUS_GATEWAY_MODEL: "aurelius" },
    async () => {
      const { fetchImpl, calls } = sseFetch(["data: [DONE]\n\n"]);
      await collect(streamGatewayBridgeTurn({ messages: [{ role: "user", content: "hi" }], sessionId: "s", fetchImpl }));
      assert.equal(calls[0].url, "http://gw.local:9999/v1/chat/completions");
      assert.equal(JSON.parse(calls[0].init.body).model, "aurelius");
    },
  );
});
