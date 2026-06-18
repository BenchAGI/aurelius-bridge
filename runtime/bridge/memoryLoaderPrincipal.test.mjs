import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTranspiledTsModule } from "./testTranspiledTsModule.mjs";

test("buildMemoryContext hydrates cloud seed for the request principal on a generic-default server", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-memory-principal-home-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aurelius-memory-principal-workspace-"));
  await writeWorkspaceFixture(workspaceRoot);

  const seedCalls = [];
  const { buildMemoryContext } = await loadTranspiledTsModule("src/lib/server/memoryLoader.ts", {
    mocks: {
      "node:os": { homedir: () => homeDir },
      "@/lib/server/cloudSeed": {
        loadCloudSeedForPrincipal: async (principal) => {
          seedCalls.push(principal);
          return {
            seedContent: `${principal} cloud seed`,
            source: "cloud",
            stale: false,
            fetchedAt: "2026-05-10T00:00:00.000Z",
            expiresAt: "2026-05-10T00:15:00.000Z",
            cachePath: null,
          };
        },
      },
    },
  });

  const previousWorkspaceRoot = process.env.AURELIUS_WORKSPACE_ROOT;
  const previousPrincipal = process.env.AURELIUS_PRINCIPAL;
  process.env.AURELIUS_WORKSPACE_ROOT = workspaceRoot;
  process.env.AURELIUS_PRINCIPAL = "default";

  try {
    const alpha = await buildMemoryContext("hello", [], { principal: "alpha" });
    const beta = await buildMemoryContext("hello", [], { principal: "beta" });

    assert.deepEqual(seedCalls, ["alpha", "beta"]);
    assert.match(alpha.systemBlocks[0].text, /alpha cloud seed/);
    assert.match(alpha.systemBlocks[0].text, /Tier zero core/);
    assert.doesNotMatch(alpha.systemBlocks[0].text, /beta cloud seed/);
    assert.match(beta.systemBlocks[0].text, /beta cloud seed/);
    assert.notEqual(alpha.manifest.cacheKey, beta.manifest.cacheKey);
    assert.ok(
      alpha.manifest.tierAPaths.indexOf(path.join(workspaceRoot, "memory", "CORE.md")) <
        alpha.manifest.tierAPaths.indexOf(path.join(workspaceRoot, "MEMORY.md")),
    );
  } finally {
    restoreEnv("AURELIUS_WORKSPACE_ROOT", previousWorkspaceRoot);
    restoreEnv("AURELIUS_PRINCIPAL", previousPrincipal);
  }
});

async function writeWorkspaceFixture(root) {
  await mkdir(path.join(root, "agents", "aurelius"), { recursive: true });
  await mkdir(path.join(root, "memory"), { recursive: true });
  await writeFile(path.join(root, "IDENTITY.md"), "# Identity\n", "utf8");
  await writeFile(path.join(root, "SOUL.md"), "# Soul\n", "utf8");
  await writeFile(path.join(root, "memory", "CORE.md"), "# Tier zero core\n", "utf8");
  await writeFile(path.join(root, "MEMORY.md"), "# Memory\n", "utf8");
  await writeFile(path.join(root, "SYSTEMS.md"), "# Systems\n", "utf8");
  await writeFile(path.join(root, "agents", "aurelius", "skills.yaml"), "skills: []\n", "utf8");
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
