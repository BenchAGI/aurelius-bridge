// L2 — per-customer key placement into the local OpenClaw gateway's auth.json.
//
// The gateway resolves provider keys from `<agentDir>/auth.json` as `api_key`
// credentials (openclaw src/agents/sessions/auth-storage.ts -> getApiKey). So
// placing the Bench-provisioned per-customer Anthropic key here is all that's
// needed for the L1 gateway-loop runner to bill the customer's key — no gateway
// code change. We merge (never clobber other providers / OAuth creds) and write
// atomically with 0600 perms, mirroring the gateway's own FileAuthStorageBackend.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PROVIDER = "anthropic";

export function resolveGatewayAgentDir({ explicit, env = process.env, homeDir = os.homedir() } = {}) {
  const raw = explicit || env.OPENCLAW_AGENT_DIR;
  if (raw) return expandTilde(raw, homeDir);
  return path.join(homeDir, ".openclaw", "agent");
}

function gatewayAuthPath(opts = {}) {
  return path.join(resolveGatewayAgentDir(opts), "auth.json");
}

// Anthropic inference keys are `sk-ant-…`; admin keys are `sk-ant-admin…` and
// CANNOT run inference, so reject them to fail loudly at placement time.
function assertUsableAnthropicKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Anthropic API key is required.");
  }
  const key = apiKey.trim();
  if (key.startsWith("sk-ant-admin")) {
    throw new Error("That is an Admin API key (sk-ant-admin…); the gateway needs a workspace inference key (sk-ant-…).");
  }
  if (!key.startsWith("sk-ant-")) {
    throw new Error("Anthropic API key should start with 'sk-ant-'.");
  }
  return key;
}

export async function setGatewayProviderKey({
  apiKey,
  provider = DEFAULT_PROVIDER,
  explicit,
  env = process.env,
  homeDir = os.homedir(),
}) {
  const key = provider === "anthropic" ? assertUsableAnthropicKey(apiKey) : requireKey(apiKey);
  const agentDir = resolveGatewayAgentDir({ explicit, env, homeDir });
  const authPath = path.join(agentDir, "auth.json");

  await mkdir(agentDir, { recursive: true, mode: 0o700 });

  const current = await readAuthJson(authPath);
  const replaced = Boolean(current[provider]);
  const merged = { ...current, [provider]: { type: "api_key", key } };

  await writeAuthJsonAtomic(authPath, merged);
  return { path: authPath, provider, replaced };
}

export async function readGatewayProviderStatus({
  provider = DEFAULT_PROVIDER,
  explicit,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const authPath = gatewayAuthPath({ explicit, env, homeDir });
  const current = await readAuthJson(authPath);
  const cred = current[provider];
  if (!cred) {
    return { path: authPath, provider, configured: false };
  }
  return {
    path: authPath,
    provider,
    configured: true,
    type: cred.type ?? "unknown",
    masked: cred.type === "api_key" ? maskKey(cred.key) : undefined,
  };
}

export function maskKey(key) {
  if (typeof key !== "string" || key.length < 8) return "sk-ant-…";
  return `sk-ant-…${key.slice(-4)}`;
}

function requireKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("API key is required.");
  return apiKey.trim();
}

async function readAuthJson(authPath) {
  let raw;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`Existing auth.json at ${authPath} is not valid JSON; refusing to overwrite.`);
  }
}

async function writeAuthJsonAtomic(authPath, data) {
  const dir = path.dirname(authPath);
  const tmp = path.join(dir, `auth.json.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, authPath);
  await chmod(authPath, 0o600).catch(() => undefined);
  // Best-effort: tighten the agent dir too.
  await chmod(dir, 0o700).catch(() => undefined);
  await stat(authPath); // surface write failures
}

function expandTilde(value, homeDir) {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}
