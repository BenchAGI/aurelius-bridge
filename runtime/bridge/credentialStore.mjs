import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BRIDGE_VERSION, VAULT_CHAT_CHANNEL } from "./constants.mjs";

export function normalizePrincipal(principal) {
  return String(principal || "cory")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "cory";
}

export function bridgeAgentDir({ principal = "cory", homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".openclaw", "agents", `aurelius-${normalizePrincipal(principal)}`);
}

export function bridgeCredentialPath(options = {}) {
  return path.join(bridgeAgentDir(options), "bridge-credential.json");
}

export async function readBridgeCredential(options = {}) {
  try {
    return JSON.parse(await readFile(bridgeCredentialPath(options), "utf8"));
  } catch {
    return null;
  }
}

export async function writeBridgeCredential(credential, options = {}) {
  const dir = bridgeAgentDir({ ...options, principal: credential.principal });
  const target = bridgeCredentialPath({ ...options, principal: credential.principal });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  await writeFile(tmp, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  await chmod(target, 0o600);
  return target;
}

export function buildCredential({
  principal,
  bridgeBaseUrl,
  token,
  tenantId,
  uid = null,
  machineId,
  hostname,
  channel = VAULT_CHAT_CHANNEL,
  expiresAt = null,
  seedUrl = null,
  cloudBrainBaseUrl = null,
}) {
  const now = new Date().toISOString();
  return {
    version: BRIDGE_VERSION,
    principal: normalizePrincipal(principal),
    bridgeBaseUrl,
    token,
    tenantId,
    uid,
    machineId,
    hostname,
    channel,
    issuedAt: now,
    pairedAt: now,
    expiresAt,
    seedUrl,
    cloudBrainBaseUrl,
  };
}
