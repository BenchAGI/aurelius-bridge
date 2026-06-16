import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCredential, writeBridgeCredential } from "./credentialStore.mjs";
import { runBridgeListener } from "./listener.mjs";
import { readBridgeStatus } from "./statusStore.mjs";

test("bridge listener reconnects after a transient drop and exits cleanly on revoke", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-listener-test-"));
  let streamCount = 0;
  let heartbeatCount = 0;
  const authHeaders = [];

  const server = http.createServer((req, res) => {
    authHeaders.push(req.headers.authorization);

    if (req.method === "POST" && req.url === "/api/v1/aurelius/bridge/heartbeat") {
      heartbeatCount += 1;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/v1/aurelius/bridge/events")) {
      streamCount += 1;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      if (streamCount === 1) {
        res.write(": transient drop\n\n");
        setTimeout(() => res.end(), 10);
        return;
      }

      res.write(`data: ${JSON.stringify({ type: "credential.revoked" })}\n\n`);
      setTimeout(() => res.end(), 10);
      return;
    }

    res.writeHead(404).end();
  });

  await listen(server);
  try {
    const address = server.address();
    const bridgeBaseUrl = `http://127.0.0.1:${address.port}`;
    await writeBridgeCredential(
      buildCredential({
        principal: "listener-test",
        bridgeBaseUrl,
        token: "listener.jwt",
        tenantId: "tenant-listener",
        machineId: "abcd1234",
        hostname: "listener-host",
      }),
      { homeDir },
    );

    const code = await runBridgeListener({
      principal: "listener-test",
      homeDir,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      heartbeatIntervalMs: 20,
    });

    assert.equal(code, 2);
    assert.equal(streamCount, 2);
    assert.ok(heartbeatCount >= 1);
    assert.ok(authHeaders.every((value) => value === "Bearer listener.jwt"));

    const status = await readBridgeStatus({ principal: "listener-test", homeDir });
    assert.equal(status.state, "revoked");
    assert.equal(status.paired, false);
  } finally {
    await close(server);
  }
});

test("bridge listener exits revoked when heartbeat is rejected during an open stream", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-listener-heartbeat-revoke-test-"));
  let heartbeatCount = 0;
  let streamOpened = false;
  let streamResponse = null;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/aurelius/bridge/heartbeat") {
      heartbeatCount += 1;
      req.resume();
      if (heartbeatCount === 1) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "revoked" }));
      streamResponse?.end();
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/v1/aurelius/bridge/events")) {
      streamOpened = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      streamResponse = res;
      res.write(": waiting for heartbeat revoke\n\n");
      return;
    }

    res.writeHead(404).end();
  });

  await listen(server);
  try {
    const address = server.address();
    const bridgeBaseUrl = `http://127.0.0.1:${address.port}`;
    await writeBridgeCredential(
      buildCredential({
        principal: "heartbeat-revoke-test",
        bridgeBaseUrl,
        token: "heartbeat-revoke.jwt",
        tenantId: "tenant-heartbeat-revoke",
        machineId: "deadbeef",
        hostname: "heartbeat-revoke-host",
      }),
      { homeDir },
    );

    const code = await runBridgeListener({
      principal: "heartbeat-revoke-test",
      homeDir,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      heartbeatIntervalMs: 10,
    });

    assert.equal(code, 2);
    assert.equal(streamOpened, true);
    assert.ok(heartbeatCount >= 2);

    const status = await readBridgeStatus({ principal: "heartbeat-revoke-test", homeDir });
    assert.equal(status.state, "revoked");
    assert.equal(status.paired, false);
  } finally {
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
