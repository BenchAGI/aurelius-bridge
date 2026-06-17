import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizePrincipal } from "./credentialStore.mjs";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{6,160}$/;
const DEFAULT_TURN_MODEL = "claude-haiku-4-5-20251001";
const BRIDGE_SYNTHESIS_MODEL = "bridge-local-cli";
// Local date bucketing for session dirs; overridable so it isn't pinned to one region.
const BRIDGE_TZ = process.env.AURELIUS_BRIDGE_TZ || "America/Denver";

// Trust-tier principals are configured via env (comma-separated slugs), not
// hardcoded — the public package ships no operator identities.
function founderPrincipals() {
  return new Set(
    (process.env.AURELIUS_FOUNDER_PRINCIPALS || "")
      .split(",")
      .map((p) => normalizePrincipal(p))
      .filter(Boolean),
  );
}

function trustTierFor(principal) {
  return founderPrincipals().has(normalizePrincipal(principal)) ? "founder" : "prospect";
}

export function bridgeSessionsRoot({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".openclaw", "wiki", "main", "sessions");
}

export async function ensureBridgeSession({ sessionId, tenantId, principal, machineId, homeDir }) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedPrincipal = normalizePrincipal(principal);
  const dir = await bridgeSessionDir({ sessionId: normalizedSessionId, principal: normalizedPrincipal, homeDir });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(bridgeSessionsRoot({ homeDir }), 0o700).catch(() => undefined);
  await chmod(path.dirname(path.dirname(dir)), 0o700).catch(() => undefined);
  await chmod(path.dirname(dir), 0o700).catch(() => undefined);
  await chmod(dir, 0o700).catch(() => undefined);

  const manifestPath = await resolveSessionPath({
    sessionId: normalizedSessionId,
    principal: normalizedPrincipal,
    homeDir,
    fileName: "manifest.json",
  });
  if (!(await exists(manifestPath))) {
    await writeJsonAtomic(
      manifestPath,
      createBridgeManifest({
        sessionId: normalizedSessionId,
        tenantId,
        principal: normalizedPrincipal,
        machineId,
      }),
    );
    await writeTextAtomic(
      await resolveSessionPath({ sessionId: normalizedSessionId, principal: normalizedPrincipal, homeDir, fileName: "transcript.md" }),
      `# Aurelius Bridge Session ${normalizedSessionId}\n\n`,
    );
    await writeTextAtomic(
      await resolveSessionPath({ sessionId: normalizedSessionId, principal: normalizedPrincipal, homeDir, fileName: "events.ndjson" }),
      "",
    );
  }

  const memoryPath = await resolveSessionPath({
    sessionId: normalizedSessionId,
    principal: normalizedPrincipal,
    homeDir,
    fileName: "memory-in-scope.json",
  });
  if (!(await exists(memoryPath))) {
    await writeJsonAtomic(memoryPath, emptyMemoryArchive(normalizedSessionId));
  }

  return { sessionId: normalizedSessionId, dir };
}

export async function appendBridgeTurn({ sessionId, tenantId, principal, machineId, userText, assistantText, events, homeDir }) {
  const session = await ensureBridgeSession({ sessionId, tenantId, principal, machineId, homeDir });
  const normalizedPrincipal = normalizePrincipal(principal);
  const manifestPath = await resolveSessionPath({
    sessionId: session.sessionId,
    principal: normalizedPrincipal,
    homeDir,
    fileName: "manifest.json",
  });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const turnIndex = Number(manifest.turnCount ?? 0) + 1;
  const now = new Date().toISOString();

  const eventLines = events.map((event) =>
    JSON.stringify({
      ...event,
      turnIndex,
      ts: event.ts ?? now,
    }),
  );
  if (eventLines.length) {
    await appendFile(
      await resolveSessionPath({ sessionId: session.sessionId, principal: normalizedPrincipal, homeDir, fileName: "events.ndjson" }),
      `${eventLines.join("\n")}\n`,
      "utf8",
    );
  }

  await appendFile(
    await resolveSessionPath({ sessionId: session.sessionId, principal: normalizedPrincipal, homeDir, fileName: "transcript.md" }),
    renderTranscriptTurn(now, userText, assistantText),
    "utf8",
  );

  const memoryPath = await resolveSessionPath({
    sessionId: session.sessionId,
    principal: normalizedPrincipal,
    homeDir,
    fileName: "memory-in-scope.json",
  });
  const memoryArchive = await readMemoryArchive(memoryPath, session.sessionId);
  if (!memoryArchive.turns.some((turn) => turn.turnIndex === turnIndex)) {
    memoryArchive.turns.push({ turnIndex, paths: [], pinnedPortalPaths: [] });
  }
  await writeJsonAtomic(memoryPath, memoryArchive);

  manifest.turnCount = turnIndex;
  manifest.lastTurnAt = now;
  manifest.status = "open";
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

async function bridgeSessionDir({ sessionId, principal, homeDir }) {
  const date = todayLocalDate();
  const root = bridgeSessionsRoot({ homeDir });
  return path.join(root, normalizePrincipal(principal), date, normalizeSessionId(sessionId));
}

async function resolveSessionPath({ sessionId, principal, homeDir, fileName }) {
  const dir = await bridgeSessionDir({ sessionId, principal, homeDir });
  const target = path.resolve(dir, fileName);
  const relative = path.relative(dir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Bridge session write escaped the approved session directory.");
  }
  return target;
}

function createBridgeManifest({ sessionId, tenantId, principal, machineId }) {
  const now = new Date().toISOString();
  return {
    sessionId,
    startedAt: now,
    lastTurnAt: now,
    closedAt: null,
    model: {
      turn: process.env.AURELIUS_CLAUDE_MODEL || DEFAULT_TURN_MODEL,
      synthesis: BRIDGE_SYNTHESIS_MODEL,
    },
    identity: {
      osUser: process.env.USER || os.userInfo().username || "unknown",
      claudeAccount: null,
      namedIdentity: `aurelius-${principal}`,
      trustTier: trustTierFor(principal),
      principal,
    },
    agent: "aurelius",
    turnCount: 0,
    memorySnapshotPaths: [],
    pinnedPortalPaths: [],
    status: "open",
    promotion: { state: "none", canonRefs: [] },
    costUsd: { turns: 0, synthesis: 0 },
    source: "presence-vault-bridge",
    bridge: { tenantId, machineId },
  };
}

async function readMemoryArchive(filePath, sessionId) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return emptyMemoryArchive(sessionId);
  }
}

function emptyMemoryArchive(sessionId) {
  return { sessionId, turns: [] };
}

function renderTranscriptTurn(ts, userText, assistantText) {
  return [`## ${ts} user`, "", userText.trim(), "", `## ${new Date().toISOString()} assistant`, "", assistantText.trim(), ""].join(
    "\n",
  );
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(tmp, value, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeSessionId(sessionId) {
  const value = String(sessionId || randomUUID()).trim();
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error("Bridge session ID must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  return value;
}

function todayLocalDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRIDGE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
