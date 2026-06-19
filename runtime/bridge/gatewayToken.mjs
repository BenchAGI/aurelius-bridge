// On-disk resolver for the OpenClaw gateway operator token (the on-Mac
// *inference* identity used by gatewayRunner.mjs — NOT the paired-bridge JWT).
//
// Why disk, not process.env: the env snapshot taken at listener start is exactly
// what goes stale when the gateway token rotates under a long-lived bridge. The
// LIVE relay (apps/relay/relay-v3.mjs readGatewayTokenFromDiskSources) already
// reads from disk every turn for this reason; the bridge cannot import the relay,
// so this mirrors it. Gated by AURELIUS_GATEWAY_TOKEN_DISK_RESYNC in the runner —
// default OFF keeps the legacy one-shot env behavior unchanged.
import os from "node:os";
import path from "node:path";

import { decodeEnvValue, readEnvFileValue, readJsonFile } from "./envFile.mjs";

// Resolve the gateway token from ~/.openclaw/openclaw.json (gateway.auth.token)
// first, then ~/.openclaw/.env (OPENCLAW_GATEWAY_TOKEN). DELIBERATELY skips
// process.env. homeDir is injectable for tests. Returns null when neither source
// has a token.
export async function readGatewayTokenFromDisk({ homeDir = os.homedir() } = {}) {
  const config = await readJsonFile(path.join(homeDir, ".openclaw", "openclaw.json"));
  const fromConfig = decodeEnvValue(config?.gateway?.auth?.token);
  if (fromConfig) return fromConfig;

  return readEnvFileValue(
    path.join(homeDir, ".openclaw", ".env"),
    "OPENCLAW_GATEWAY_TOKEN",
  );
}
