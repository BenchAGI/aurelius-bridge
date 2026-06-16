import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { bridgeAgentDir, normalizePrincipal } from "./credentialStore.mjs";

export function bridgeStatusPath(options = {}) {
  return path.join(bridgeAgentDir(options), "bridge-status.json");
}

export async function readBridgeStatus(options = {}) {
  try {
    return JSON.parse(await readFile(bridgeStatusPath(options), "utf8"));
  } catch {
    return null;
  }
}

export async function writeBridgeStatus(status, options = {}) {
  const principal = normalizePrincipal(options.principal ?? status.principal);
  const dir = bridgeAgentDir({ ...options, principal });
  const target = bridgeStatusPath({ ...options, principal });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  await writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  await chmod(target, 0o600);
  return target;
}
