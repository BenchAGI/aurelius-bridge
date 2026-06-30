import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pageHarness, HARNESS_CHANNEL_ID, readSlackBotToken } from "./slackPager.mjs";

test("posts to #harness with the bearer token and message", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const res = await pageHarness("drift!", { token: "xoxb-test", fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].init.headers.authorization, "Bearer xoxb-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.channel, HARNESS_CHANNEL_ID);
  assert.equal(body.channel, "C0B9536FE4S");
  assert.equal(body.text, "drift!");
});

test("no-op (no fetch) when no token is resolvable", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const res = await pageHarness("x", { fetchImpl, slackEnvPath: "/nonexistent/autofix-slack.env" });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "no_token");
  assert.equal(called, false);
});

test("reads AUTOFIX_SLACK_TOKEN from the credentials file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aurelius-slack-"));
  try {
    const file = path.join(dir, "autofix-slack.env");
    await writeFile(file, "AUTOFIX_SLACK_TOKEN=xoxb-from-file\nAUTOFIX_SLACK_CHANNEL=C0AT09Y1HT3\n");
    assert.equal(await readSlackBotToken({ slackEnvPath: file }), "xoxb-from-file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("surfaces a Slack API error (ok:false payload)", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: "channel_not_found" }),
  });
  const res = await pageHarness("x", { token: "xoxb", fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.error, "channel_not_found");
});
