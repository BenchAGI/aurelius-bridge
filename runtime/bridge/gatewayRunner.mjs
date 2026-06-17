// Gateway-loop bridge runner.
//
// Drop-in replacement for streamClaudeBridgeTurn (claudeRunner.mjs): same
// async-generator contract (yields assistant text deltas), but instead of
// spawning the local `claude` CLI on the human's Claude-Max OAuth, it streams
// the turn through the local OpenClaw gateway's OpenAI-compatible endpoint.
// The gateway runs the real agent loop (native tools / computer-use) keyed by
// its own auth.json — i.e. the Bench-provisioned per-customer Anthropic key.
//
// Convergence target: openclaw `src/gateway/openai-http.ts` ->
// `agentCommandFromIngress` (the agent runtime), not a raw model passthrough.
// `user` maps to a stable gateway sessionKey (continuity); `model` selects the
// gateway agent.

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789";
const DEFAULT_GATEWAY_MODEL = "openclaw";

export async function* streamGatewayBridgeTurn({
  messages,
  sessionId,
  seedContent = "",
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const baseUrl = (process.env.AURELIUS_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
  const token = process.env.AURELIUS_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error(
      "Gateway runner requires a gateway operator token; set AURELIUS_GATEWAY_TOKEN (or OPENCLAW_GATEWAY_TOKEN).",
    );
  }
  const model = process.env.AURELIUS_GATEWAY_MODEL || DEFAULT_GATEWAY_MODEL;

  const body = {
    model,
    stream: true,
    user: String(sessionId || "bridge"),
    messages: buildMessages(messages, seedContent),
  };

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new Error(`Gateway unreachable at ${baseUrl}; is the OpenClaw gateway running? (${describe(error)})`);
  }

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response));
  }
  if (!response.body) {
    throw new Error("Gateway returned no response body for a streaming turn.");
  }

  yield* parseSseDeltas(response.body);
}

function buildMessages(messages, seedContent) {
  const out = [];
  if (seedContent) {
    out.push({
      role: "system",
      content: `Cloud brain seed content:\n\n${seedContent}`,
    });
  }
  for (const message of messages ?? []) {
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content ?? ""),
    });
  }
  return out;
}

// Parse an OpenAI-compatible SSE stream, yielding assistant content deltas.
// Accepts any async-iterable of Uint8Array/string chunks (undici fetch body).
async function* parseSseDeltas(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of iterateChunks(stream)) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      const delta = deltaFromLine(line);
      if (delta === DONE) return;
      if (delta) yield delta;
    }
  }
  // Flush any trailing line without a newline terminator.
  const delta = deltaFromLine(buffer.trim());
  if (delta && delta !== DONE) yield delta;
}

const DONE = Symbol("sse-done");

function deltaFromLine(line) {
  if (!line || !line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === "[DONE]") return DONE;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  const content = event?.choices?.[0]?.delta?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

async function* iterateChunks(stream) {
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    yield* stream;
    return;
  }
  // Web ReadableStream fallback (no async-iterator support on this runtime).
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function errorMessageFromResponse(response) {
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = "";
  }
  if (response.status === 401 || response.status === 403) {
    return `Gateway rejected the bridge token (${response.status}); check AURELIUS_GATEWAY_TOKEN. ${detail}`.trim();
  }
  return `Gateway turn failed (${response.status}). ${detail}`.trim();
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
