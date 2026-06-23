import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  maskKey,
  readGatewayProviderStatus,
  resolveGatewayAgentDir,
  setGatewayProviderKey,
} from "./gatewayAuth.mjs";

async function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), "aurelius-gw-auth-"));
}

test("writes the anthropic api_key credential with 0600 perms", async () => {
  const dir = await tmpDir();
  const result = await setGatewayProviderKey({ apiKey: "sk-ant-live-abcd1234", explicit: dir });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.replaced, false);
  const parsed = JSON.parse(await readFile(result.path, "utf8"));
  assert.deepEqual(parsed.anthropic, { type: "api_key", key: "sk-ant-live-abcd1234" });

  const mode = (await stat(result.path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("merges without clobbering existing providers/credentials", async () => {
  const dir = await tmpDir();
  const authPath = path.join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ openai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } }),
    "utf8",
  );

  const result = await setGatewayProviderKey({ apiKey: "sk-ant-xyz9876", explicit: dir });
  assert.equal(result.replaced, false);

  const parsed = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(parsed.openai.type, "oauth"); // preserved
  assert.equal(parsed.anthropic.key, "sk-ant-xyz9876");
});

test("is idempotent and reports replacement on re-set", async () => {
  const dir = await tmpDir();
  await setGatewayProviderKey({ apiKey: "sk-ant-one1111", explicit: dir });
  const second = await setGatewayProviderKey({ apiKey: "sk-ant-two2222", explicit: dir });

  assert.equal(second.replaced, true);
  const parsed = JSON.parse(await readFile(second.path, "utf8"));
  assert.equal(parsed.anthropic.key, "sk-ant-two2222");
  assert.equal(Object.keys(parsed).length, 1);
});

test("rejects an admin key and non-anthropic-shaped keys", async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => setGatewayProviderKey({ apiKey: "sk-ant-admin-secret", explicit: dir }),
    /Admin API key/,
  );
  await assert.rejects(() => setGatewayProviderKey({ apiKey: "nope", explicit: dir }), /should start with 'sk-ant-'/);
  await assert.rejects(() => setGatewayProviderKey({ apiKey: "", explicit: dir }), /required/);
});

test("status reports configured + masked key, never the full secret", async () => {
  const dir = await tmpDir();
  const absent = await readGatewayProviderStatus({ explicit: dir });
  assert.equal(absent.configured, false);

  await setGatewayProviderKey({ apiKey: "sk-ant-live-SECRET7890", explicit: dir });
  const present = await readGatewayProviderStatus({ explicit: dir });
  assert.equal(present.configured, true);
  assert.equal(present.type, "api_key");
  assert.equal(present.masked, "sk-ant-…7890");
  assert.doesNotMatch(present.masked, /SECRET/);
});

test("masks keys by shape, defensively", () => {
  assert.equal(maskKey("sk-ant-12345678"), "sk-ant-…5678");
  assert.equal(maskKey("bench_inst_abcd1234"), "bench_…1234");
  assert.equal(maskKey("abc"), "…");
  assert.equal(maskKey(undefined), "…");
});

test("accepts a Bench-metered key and rejects unknown shapes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gw-auth-bench-"));
  await setGatewayProviderKey({ apiKey: "bench_SYGSEOnNo57zf4QSmbcS_secret7890", explicit: dir });
  const present = await readGatewayProviderStatus({ explicit: dir });
  assert.equal(present.configured, true);
  assert.equal(present.masked, "bench_…7890");
  await assert.rejects(
    () => setGatewayProviderKey({ apiKey: "nope-not-a-key", explicit: dir }),
    /sk-ant-.*bench_/,
  );
});

test("resolveGatewayAgentDir honors explicit > env > default with tilde expansion", () => {
  const homeDir = "/home/test";
  assert.equal(resolveGatewayAgentDir({ explicit: "/x/y", env: {}, homeDir }), "/x/y");
  assert.equal(
    resolveGatewayAgentDir({ env: { OPENCLAW_AGENT_DIR: "~/custom/agent" }, homeDir }),
    "/home/test/custom/agent",
  );
  assert.equal(resolveGatewayAgentDir({ env: {}, homeDir }), "/home/test/.openclaw/agent");
});

test("refuses to overwrite an unparseable auth.json", async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, "auth.json"), "{not json", "utf8");
  await assert.rejects(() => setGatewayProviderKey({ apiKey: "sk-ant-ok1234", explicit: dir }), /not valid JSON/);
});
