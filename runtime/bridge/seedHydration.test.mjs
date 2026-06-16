import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCredential } from "./credentialStore.mjs";
import { hydrateBridgeSeed, seedCachePath } from "./seedHydration.mjs";

test("hydrateBridgeSeed fetches seedContent and caches it", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-seed-test-"));
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/tenants/tenant-seed/agents/aurelius/seed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agentMemory: { seedContent: "cloud seed content" }, trustTier: "founder" }));
      return;
    }
    res.writeHead(404).end();
  });

  await listen(server);
  try {
    const bridgeBaseUrl = `http://127.0.0.1:${server.address().port}`;
    const seed = await hydrateBridgeSeed({
      credential: buildCredential({
        principal: "seed-test",
        bridgeBaseUrl,
        token: "seed.jwt",
        tenantId: "tenant-seed",
        machineId: "1234abcd",
        hostname: "seed-host",
      }),
      principal: "seed-test",
      homeDir,
      ttlMs: 30_000,
    });

    assert.equal(seed.seedContent, "cloud seed content");
    assert.equal(seed.source, "cloud");
    assert.equal(seed.stale, false);
    const cached = JSON.parse(await readFile(seedCachePath({ principal: "seed-test", homeDir }), "utf8"));
    assert.equal(cached.seedContent, "cloud seed content");
  } finally {
    await close(server);
  }
});

test("hydrateBridgeSeed falls back to last-known seed when cloud brain is unreachable", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-seed-fallback-test-"));
  const cachePath = seedCachePath({ principal: "seed-fallback", homeDir });
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      seedContent: "last known seed",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-01T00:15:00.000Z",
      source: "cloud",
      stale: false,
    }),
  );

  const seed = await hydrateBridgeSeed({
    credential: buildCredential({
      principal: "seed-fallback",
      bridgeBaseUrl: "http://127.0.0.1:9",
      token: "seed.jwt",
      tenantId: "tenant-seed",
      machineId: "1234abcd",
      hostname: "seed-host",
    }),
    principal: "seed-fallback",
    homeDir,
    ttlMs: 1,
  });

  assert.equal(seed.seedContent, "last known seed");
  assert.equal(seed.source, "cache");
  assert.equal(seed.stale, true);
  assert.match(seed.error, /fetch failed|bad port|ECONNREFUSED/i);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
