import { BridgeRevokedError, connectEventStream, sendHeartbeat } from "./bridgeClient.mjs";
import { readBridgeCredential } from "./credentialStore.mjs";
import { appendBridgeTurn, ensureBridgeSession } from "./bridgeSessionStore.mjs";
import { postBridgeEvent } from "./bridgeClient.mjs";
import { hydrateBridgeSeed } from "./seedHydration.mjs";
import { streamClaudeBridgeTurn } from "./claudeRunner.mjs";
import { streamGatewayBridgeTurn } from "./gatewayRunner.mjs";
import { writeBridgeStatus } from "./statusStore.mjs";

// Runner selection. Default = the local `claude` CLI subprocess (legacy,
// human OAuth, conversational only). `gateway` routes the turn through the
// local OpenClaw gateway agent loop keyed by the per-customer Anthropic key
// (the L1 convergence). Flag-gated so the keyed path can land before it is
// flipped on by default.
function selectBridgeRunner() {
  return (process.env.AURELIUS_BRIDGE_RUNNER || "claude").toLowerCase() === "gateway"
    ? streamGatewayBridgeTurn
    : streamClaudeBridgeTurn;
}

export async function runBridgeListener({
  principal = process.env.AURELIUS_PRINCIPAL || "default",
  homeDir,
  fetchImpl = globalThis.fetch,
  signal,
  heartbeatIntervalMs = 25_000,
  minBackoffMs = 1_000,
  maxBackoffMs = 30_000,
  onBridgeEvent = defaultBridgeEventHandler,
} = {}) {
  const credential = await readBridgeCredential({ principal, homeDir });
  if (!credential) {
    throw new Error(`No bridge credential found for principal '${principal}'. Run 'aurelius pair <code>' first.`);
  }

  let backoffMs = minBackoffMs;
  await writeBridgeStatus({ ...baseStatus(credential), state: "connecting" }, { principal, homeDir });

  while (!signal?.aborted) {
    let heartbeatTimer = null;
    const cycleAbort = linkedAbortController(signal);
    const cycleSignal = cycleAbort.controller.signal;
    const cycleOptions = { principal, homeDir, fetchImpl, signal: cycleSignal };
    let heartbeatRevoked = false;
    let heartbeatRevokedError = null;
    try {
      await markOnline(credential, cycleOptions);
      let rejectHeartbeatFailure = null;
      const heartbeatFailure = new Promise((_, reject) => {
        rejectHeartbeatFailure = reject;
      });
      heartbeatFailure.catch(() => undefined);

      heartbeatTimer = setInterval(() => {
        markOnline(credential, cycleOptions).catch((error) => {
          if (error instanceof BridgeRevokedError) {
            heartbeatRevoked = true;
            heartbeatRevokedError = error;
            cycleAbort.controller.abort();
            rejectHeartbeatFailure?.(error);
            return;
          }
          if (!cycleSignal.aborted && !signal?.aborted) {
            console.warn(`[aurelius-bridge] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }, heartbeatIntervalMs);

      const stream = connectEventStream(credential, {
        fetchImpl,
        signal: cycleSignal,
        onEvent: (event) => onBridgeEvent(event, { credential, principal, homeDir, fetchImpl, signal: cycleSignal }),
      });
      await Promise.race([
        stream.catch((error) => {
          if (heartbeatRevoked && isAbortError(error)) return;
          throw error;
        }),
        heartbeatFailure,
      ]);
      if (heartbeatRevoked) throw heartbeatRevokedError ?? new BridgeRevokedError();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      backoffMs = minBackoffMs;
      await writeBridgeStatus({ ...baseStatus(credential), state: "reconnecting" }, { principal, homeDir });
      await sleep(backoffMs, signal);
    } catch (error) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (signal?.aborted) break;

      if (error instanceof BridgeRevokedError) {
        await writeBridgeStatus(
          { ...baseStatus(credential), paired: false, state: "revoked", lastError: error.message },
          { principal, homeDir },
        );
        return 2;
      }

      await writeBridgeStatus(
        {
          ...baseStatus(credential),
          state: "disconnected",
          lastError: error instanceof Error ? error.message : String(error),
        },
        { principal, homeDir },
      );
      await sleep(backoffMs, signal);
      backoffMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, backoffMs * 2));
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      cycleAbort.controller.abort();
      cycleAbort.cleanup();
    }
  }

  await writeBridgeStatus({ ...baseStatus(credential), state: "stopped" }, { principal, homeDir });
  return 0;
}

async function markOnline(credential, options) {
  await sendHeartbeat(credential, options);
  await writeBridgeStatus({ ...baseStatus(credential), state: "connected" }, options);
}

function baseStatus(credential) {
  return {
    paired: true,
    lastSeenAt: new Date().toISOString(),
    channel: credential.channel,
    version: credential.version,
    bridgeBaseUrl: credential.bridgeBaseUrl,
    machineId: credential.machineId,
    principal: credential.principal,
  };
}

function linkedAbortController(signal) {
  const controller = new AbortController();
  if (!signal) return { controller, cleanup: () => undefined };
  if (signal.aborted) {
    controller.abort();
    return { controller, cleanup: () => undefined };
  }
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener("abort", abort),
  };
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function memoryPathsForSeed(seed) {
  const paths = [];
  if (seed?.cachePath) paths.push(seed.cachePath);
  const skillEntries = seed?.skillManifest?.skills ?? seed?.skillManifest?.entries ?? [];
  if (Array.isArray(skillEntries)) {
    for (const entry of skillEntries) {
      if (typeof entry === "string") paths.push(entry);
      else if (entry && typeof entry.path === "string") paths.push(entry.path);
      else if (entry && typeof entry.skillPath === "string") paths.push(entry.skillPath);
    }
  }
  return paths;
}

export async function handleBridgeChatEvent(event, { credential, principal, homeDir, fetchImpl, signal }) {
  const chat = normalizeChatEvent(event);
  if (!chat) return false;

  const outboundEvents = [];
  const emit = async (outbound) => {
    outboundEvents.push(outbound);
    await postBridgeEvent(credential, outbound, { fetchImpl, signal });
  };

  let assistantText = "";
  await ensureBridgeSession({
    sessionId: chat.sessionId,
    tenantId: credential.tenantId,
    principal,
    machineId: credential.machineId,
    homeDir,
  });

  try {
    const seed = await hydrateBridgeSeed({ credential, principal, homeDir, fetchImpl, signal });
    await emit({ type: "chat.started", sessionId: chat.sessionId, turnId: chat.turnId, ts: new Date().toISOString() });
    await emit({
      type: "memory.in_scope",
      sessionId: chat.sessionId,
      turnId: chat.turnId,
      headline: `Cloud seed · ${seed.source}${seed.stale ? " · stale" : ""}`,
      detail: JSON.stringify(memoryPathsForSeed(seed)),
      ts: new Date().toISOString(),
    });
    const runTurn = selectBridgeRunner();
    for await (const delta of runTurn({ messages: chat.messages, sessionId: chat.sessionId, seedContent: seed.seedContent, signal, fetchImpl })) {
      assistantText += delta;
      await emit({ type: "chat.token", sessionId: chat.sessionId, turnId: chat.turnId, token: delta });
    }
    await emit({
      type: "chat.final",
      sessionId: chat.sessionId,
      turnId: chat.turnId,
      text: assistantText,
      ts: new Date().toISOString(),
    });
    await appendBridgeTurn({
      sessionId: chat.sessionId,
      tenantId: credential.tenantId,
      principal,
      machineId: credential.machineId,
      userText: chat.userText,
      assistantText,
      events: outboundEvents,
      homeDir,
    });
  } catch (error) {
    await emit({
      type: "chat.error",
      sessionId: chat.sessionId,
      turnId: chat.turnId,
      message: error instanceof Error ? error.message : String(error),
      ts: new Date().toISOString(),
    });
  }

  return true;
}

async function defaultBridgeEventHandler(event, context) {
  const handled = await handleBridgeChatEvent(event, context);
  if (!handled) console.info(`[aurelius-bridge] event ignored: ${event?.type ?? event?.kind ?? "unknown"}`);
}

function normalizeChatEvent(event) {
  const type = event?.type ?? event?.kind;
  if (type !== "chat.message" && type !== "vault.chat.message") return null;

  const sessionId = String(event.sessionId || event.session_id || "");
  const turnId = String(event.turnId || event.eventId || event.id || `${Date.now()}`);
  const messages = Array.isArray(event.messages)
    ? event.messages.map((message) => ({ role: normalizeRole(message.role), content: String(message.content ?? "") }))
    : [{ role: "user", content: String(event.text ?? event.userText ?? "") }];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");

  if (!sessionId) throw new Error("Bridge chat event missing sessionId.");
  if (!lastUser?.content.trim()) throw new Error("Bridge chat event missing user text.");

  return {
    sessionId,
    turnId,
    messages,
    userText: lastUser.content,
  };
}

function normalizeRole(role) {
  return role === "assistant" ? "assistant" : "user";
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
