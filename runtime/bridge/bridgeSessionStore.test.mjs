import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendBridgeTurn } from "./bridgeSessionStore.mjs";
import { loadTranspiledTsModule } from "./testTranspiledTsModule.mjs";

test("bridge sessions use canonical principal/date layout visible to sessionStore", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-bridge-session-store-test-"));
  const sessionId = "bridge-visible-123";
  const principal = "fixture-operator";
  const today = todayLocalDate();
  const sessionDir = path.join(homeDir, ".openclaw", "wiki", "main", "sessions", principal, today, sessionId);

  await appendBridgeTurn({
    sessionId,
    tenantId: "tenant-visible",
    principal: "Fixture Operator",
    machineId: "a11ce001",
    userText: "Find this canonical bridge transcript.",
    assistantText: "Visible in history.",
    events: [{ type: "chat.final", text: "Visible in history." }],
    homeDir,
  });

  const manifest = JSON.parse(await readFile(path.join(sessionDir, "manifest.json"), "utf8"));
  const memoryArchive = JSON.parse(await readFile(path.join(sessionDir, "memory-in-scope.json"), "utf8"));
  assert.equal(manifest.identity.principal, principal);
  assert.equal(manifest.agent, "aurelius");
  assert.equal(manifest.turnCount, 1);
  assert.deepEqual(manifest.promotion, { state: "none", canonRefs: [] });
  assert.deepEqual(memoryArchive, { sessionId, turns: [{ turnIndex: 1, paths: [], pinnedPortalPaths: [] }] });

  const { listSessions } = await loadSessionStore(homeDir);
  const listed = await listSessions();
  const sessions = listed.groups.flatMap((group) => group.sessions);
  assert.ok(
    sessions.some(
      (session) =>
        session.sessionId === sessionId &&
        session.principal === principal &&
        session.path === sessionDir &&
        session.title === "Find this canonical bridge transcript.",
    ),
  );
});

async function loadSessionStore(homeDir) {
  const sessionsRoot = path.join(homeDir, ".openclaw", "wiki", "main", "sessions");
  class PolicyError extends Error {
    constructor(reason, message, status = 422) {
      super(message);
      this.reason = reason;
      this.status = status;
    }
  }

  return loadTranspiledTsModule("src/lib/server/sessionStore.ts", {
    mocks: {
      "@/lib/server/claudeCli": {
        CLAUDE_CLI_SYNTHESIS_MODEL: "test-synthesis-model",
        CLAUDE_CLI_TURN_MODEL: "test-turn-model",
      },
      "@/lib/server/identity": {
        resolveIdentity: async (principal) => ({
          osUser: "test-user",
          claudeAccount: null,
          namedIdentity: `aurelius-${principal}`,
          trustTier: "founder",
          principal,
        }),
      },
      "@/lib/server/policy": {
        APPROVED_VAULT_WRITE_ROOTS: {
          sessions: sessionsRoot,
        },
        PolicyError,
        resolveVaultWritePath: async (targetPath) => targetPath,
      },
    },
  });
}

function todayLocalDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
