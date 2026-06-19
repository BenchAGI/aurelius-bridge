// KQ-4 invariant: the paired-bridge JWT (credential.token, the cloud identity)
// is decoupled from the gateway operator token (the on-Mac inference identity).
// authHeaders() must carry ONLY credential.token, never a gateway token — so a
// gateway-token rotation can never revoke the cloud leg.
import assert from "node:assert/strict";
import test from "node:test";

import { buildCredential } from "./credentialStore.mjs";
import { sendHeartbeat } from "./bridgeClient.mjs";

function withGatewayTokens(values, fn) {
  const saved = {
    a: process.env.AURELIUS_GATEWAY_TOKEN,
    o: process.env.OPENCLAW_GATEWAY_TOKEN,
  };
  process.env.AURELIUS_GATEWAY_TOKEN = values.a;
  process.env.OPENCLAW_GATEWAY_TOKEN = values.o;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved.a === undefined) delete process.env.AURELIUS_GATEWAY_TOKEN;
      else process.env.AURELIUS_GATEWAY_TOKEN = saved.a;
      if (saved.o === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = saved.o;
    });
}

function cred(token = "paired-jwt-xyz") {
  return buildCredential({
    principal: "default",
    bridgeBaseUrl: "https://benchagi.com",
    token,
    tenantId: "t1",
    machineId: "m1",
    hostname: "host",
  });
}

test("credential.token (paired JWT) is independent of the gateway operator token", async () => {
  await withGatewayTokens({ a: "gw-aaa", o: "gw-bbb" }, () => {
    const c = cred("paired-jwt-xyz");
    assert.equal(c.token, "paired-jwt-xyz");
    assert.notEqual(c.token, process.env.AURELIUS_GATEWAY_TOKEN);
    assert.notEqual(c.token, process.env.OPENCLAW_GATEWAY_TOKEN);
  });
});

test("the cloud-leg auth header carries the paired JWT, never a gateway token", async () => {
  await withGatewayTokens({ a: "gw-should-not-appear", o: "gw-should-not-appear-2" }, async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, async text() { return "{}"; } };
    };
    await sendHeartbeat(cred("paired-jwt-only"), { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, "Bearer paired-jwt-only");
    // The whole header set must not leak any gateway token.
    assert.ok(!JSON.stringify(calls[0].init.headers).includes("gw-should-not-appear"));
  });
});
