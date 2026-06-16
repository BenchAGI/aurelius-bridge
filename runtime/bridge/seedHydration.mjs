import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bridgeAgentDir, normalizePrincipal } from "./credentialStore.mjs";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function seedCachePath(options = {}) {
  return path.join(bridgeAgentDir(options), "seed-cache.json");
}

export async function hydrateBridgeSeed({
  credential,
  principal = credential?.principal,
  homeDir,
  fetchImpl = globalThis.fetch,
  signal,
  ttlMs = Number(process.env.AURELIUS_SEED_CACHE_TTL_MS || DEFAULT_TTL_MS),
} = {}) {
  if (!credential) return emptySeed("unpaired");

  const cache = await readSeedCache({ principal, homeDir });
  if (cache && Date.parse(cache.expiresAt) > Date.now()) {
    return { ...cache, source: "cache", stale: false, cachePath: seedCachePath({ principal, homeDir }) };
  }

  try {
    const fetched = await fetchSeed({ credential, fetchImpl, signal });
    const now = Date.now();
    const record = {
      seedContent: fetched.seedContent,
      skillManifest: fetched.skillManifest ?? null,
      canonHashes: fetched.canonHashes ?? null,
      trustTier: fetched.trustTier ?? null,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      source: "cloud",
      stale: false,
    };
    await writeSeedCache(record, { principal, homeDir });
    return { ...record, cachePath: seedCachePath({ principal, homeDir }) };
  } catch (error) {
    if (cache) {
      return {
        ...cache,
        source: "cache",
        stale: true,
        error: error instanceof Error ? error.message : String(error),
        cachePath: seedCachePath({ principal, homeDir }),
      };
    }
    return emptySeed("unavailable", error);
  }
}

async function fetchSeed({ credential, fetchImpl, signal }) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available in this Node runtime.");
  const url = resolveSeedUrl(credential);
  const response = await fetchImpl(url, {
    method: "GET",
    signal,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential.token}`,
      "X-OpenClaw-Machine-Id": credential.machineId,
      "X-OpenClaw-Channel": credential.channel,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Seed fetch failed (${response.status}): ${body.trim() || response.statusText}`);
  }
  const payload = await response.json();
  const seedContent = payload.agentMemory?.seedContent ?? payload.seedContent ?? "";
  return {
    seedContent: String(seedContent || ""),
    skillManifest: payload.skillManifest ?? payload.agentMemory?.skillManifest ?? null,
    canonHashes: payload.canonHashes ?? payload.agentMemory?.canonHashes ?? null,
    trustTier: payload.trustTier ?? payload.agentMemory?.trustTier ?? null,
  };
}

function resolveSeedUrl(credential) {
  if (credential.seedUrl) return new URL(credential.seedUrl);
  const base = credential.cloudBrainBaseUrl || credential.bridgeBaseUrl;
  return new URL(`/api/v1/tenants/${encodeURIComponent(credential.tenantId)}/agents/aurelius/seed`, base);
}

async function readSeedCache(options = {}) {
  try {
    return JSON.parse(await readFile(seedCachePath(options), "utf8"));
  } catch {
    return null;
  }
}

async function writeSeedCache(record, options = {}) {
  const principal = normalizePrincipal(options.principal);
  const dir = bridgeAgentDir({ ...options, principal });
  const target = seedCachePath({ ...options, principal });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  await chmod(target, 0o600);
  return target;
}

function emptySeed(source, error = null) {
  return {
    seedContent: "",
    skillManifest: null,
    canonHashes: null,
    trustTier: null,
    fetchedAt: null,
    expiresAt: null,
    source,
    stale: false,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    cachePath: null,
  };
}
