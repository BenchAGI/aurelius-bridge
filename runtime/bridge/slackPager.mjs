// Minimal Slack pager for bridge drift alerts → #harness. Posts as the Aurelius
// bot using the AUTOFIX_SLACK_TOKEN (xoxb) in the local credentials file. Token
// and fetch are injectable for tests; a machine without the credential simply
// does NOT page (no throw, no fetch) — paging is best-effort observability, never
// a hard dependency of the bridge.
import os from "node:os";
import path from "node:path";

import { readEnvFileValue } from "./envFile.mjs";

// #harness — the ops/health channel. Hard-coded on purpose: the on-disk
// autofix-slack.env default (AUTOFIX_SLACK_CHANNEL) is #the_forge (dev), which is
// NOT where a dead cloud-leg belongs.
export const HARNESS_CHANNEL_ID = "C0B9536FE4S";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

export function defaultSlackEnvPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".openclaw", "credentials", "autofix-slack.env");
}

// The Aurelius bot token (xoxb), or null when absent. Injectable path for tests.
export async function readSlackBotToken({ homeDir = os.homedir(), slackEnvPath } = {}) {
  return readEnvFileValue(slackEnvPath || defaultSlackEnvPath(homeDir), "AUTOFIX_SLACK_TOKEN");
}

// Post one message to #harness. Returns { ok, skipped, status, error }. No-op
// (skipped:true) when no token is resolvable.
export async function pageHarness(
  text,
  { token, channel = HARNESS_CHANNEL_ID, fetchImpl = globalThis.fetch, homeDir, slackEnvPath } = {},
) {
  const botToken = token || (await readSlackBotToken({ homeDir, slackEnvPath }));
  if (!botToken) {
    return { ok: false, skipped: true, reason: "no_token" };
  }
  try {
    const response = await fetchImpl(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, text }),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const ok = Boolean(response.ok && (payload ? payload.ok !== false : true));
    return { ok, skipped: false, status: response.status, slackOk: payload?.ok, error: payload?.error };
  } catch (error) {
    return { ok: false, skipped: false, error: error instanceof Error ? error.message : String(error) };
  }
}
