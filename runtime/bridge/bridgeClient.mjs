import { BRIDGE_VERSION, EVENTS_PATH, HEARTBEAT_PATH } from "./constants.mjs";

export class BridgeRevokedError extends Error {
  constructor(message = "Bridge credential revoked.") {
    super(message);
    this.name = "BridgeRevokedError";
  }
}

export async function sendHeartbeat(credential, { fetchImpl = globalThis.fetch, signal, status = "online" } = {}) {
  const response = await bridgeFetch(fetchImpl, new URL(HEARTBEAT_PATH, credential.bridgeBaseUrl), {
    method: "POST",
    signal,
    headers: authHeaders(credential, { accept: "application/json", contentType: "application/json" }),
    body: JSON.stringify({
      channel: credential.channel,
      machineId: credential.machineId,
      version: BRIDGE_VERSION,
      status,
      ts: new Date().toISOString(),
    }),
  });
  await assertBridgeOk(response, "heartbeat");
  return response;
}

export async function postBridgeEvent(credential, event, { fetchImpl = globalThis.fetch, signal } = {}) {
  const response = await bridgeFetch(fetchImpl, new URL(EVENTS_PATH, credential.bridgeBaseUrl), {
    method: "POST",
    signal,
    headers: authHeaders(credential, { accept: "application/json", contentType: "application/json" }),
    body: JSON.stringify({
      channel: credential.channel,
      machineId: credential.machineId,
      event,
    }),
  });
  await assertBridgeOk(response, "event post");
  return response;
}

export async function connectEventStream(credential, { fetchImpl = globalThis.fetch, signal, onEvent } = {}) {
  const url = new URL(EVENTS_PATH, credential.bridgeBaseUrl);
  url.searchParams.set("channel", credential.channel);
  url.searchParams.set("machineId", credential.machineId);
  url.searchParams.set("version", BRIDGE_VERSION);

  const response = await bridgeFetch(fetchImpl, url, {
    method: "GET",
    signal,
    headers: authHeaders(credential, { accept: "text/event-stream" }),
  });
  await assertBridgeOk(response, "event stream");
  if (!response.body) return;

  await readSse(response.body, async (event) => {
    if (event?.type === "credential.revoked" || event?.kind === "credential.revoked") {
      throw new BridgeRevokedError();
    }
    if (onEvent) await onEvent(event);
  });
}

function authHeaders(credential, { accept, contentType } = {}) {
  const headers = {
    Authorization: `Bearer ${credential.token}`,
    "X-OpenClaw-Machine-Id": credential.machineId,
    "X-OpenClaw-Channel": credential.channel,
  };
  if (accept) headers.Accept = accept;
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function bridgeFetch(fetchImpl, url, init) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this Node runtime.");
  return fetchImpl(url, init);
}

async function assertBridgeOk(response, phase) {
  if (response.status === 401 || response.status === 403) {
    throw new BridgeRevokedError(`Bridge credential rejected during ${phase}.`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Bridge ${phase} failed (${response.status}): ${body.trim() || response.statusText}`);
  }
}

async function readSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = normalizeSseLineEndings(buffer);
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await dispatchSseBlock(raw, onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  buffer = normalizeSseLineEndings(buffer);
  if (buffer.trim()) await dispatchSseBlock(buffer, onEvent);
}

function normalizeSseLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

async function dispatchSseBlock(raw, onEvent) {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return;
  await onEvent(JSON.parse(data));
}
