import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readGatewayTokenFromDisk } from "./gatewayToken.mjs";

async function tmpHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aurelius-gwtoken-"));
  await mkdir(path.join(dir, ".openclaw"), { recursive: true });
  return dir;
}

test("reads gateway.auth.token from ~/.openclaw/openclaw.json", async () => {
  const home = await tmpHome();
  try {
    await writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "disk-tok-1" } } }),
    );
    assert.equal(await readGatewayTokenFromDisk({ homeDir: home }), "disk-tok-1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("falls back to OPENCLAW_GATEWAY_TOKEN in ~/.openclaw/.env (quotes stripped)", async () => {
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, ".openclaw", ".env"), "OPENCLAW_GATEWAY_TOKEN='env-tok-2'\n");
    assert.equal(await readGatewayTokenFromDisk({ homeDir: home }), "env-tok-2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("prefers openclaw.json over the .env fallback", async () => {
  const home = await tmpHome();
  try {
    await writeFile(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "json-wins" } } }),
    );
    await writeFile(path.join(home, ".openclaw", ".env"), "OPENCLAW_GATEWAY_TOKEN=env-loses\n");
    assert.equal(await readGatewayTokenFromDisk({ homeDir: home }), "json-wins");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("returns null when neither source has a token — does NOT read process.env", async () => {
  const home = await tmpHome();
  const saved = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = "should-be-ignored";
  try {
    assert.equal(await readGatewayTokenFromDisk({ homeDir: home }), null);
  } finally {
    if (saved === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = saved;
    await rm(home, { recursive: true, force: true });
  }
});
