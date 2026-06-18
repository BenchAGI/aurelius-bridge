import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bridgeCredentialPath, readBridgeCredential } from "./credentialStore.mjs";
import { exchangePairingCode, exchangeSelfPairing } from "./pairing.mjs";

test("exchangePairingCode stores bridge credentials with mode 0600", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-pair-test-"));
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/aurelius/bridge/pair") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jwt: "mock.bridge.jwt",
          tenantId: "tenant-123",
          channel: "vault-chat",
          expiresAt: "2026-06-01T00:00:00.000Z",
        }),
      );
    });
  });

  await listen(server);
  try {
    const address = server.address();
    const bridgeBaseUrl = `http://127.0.0.1:${address.port}`;
    const result = await exchangePairingCode({
      code: "12345678",
      principal: "Fixture Operator",
      bridgeBaseUrl,
      homeDir,
    });

    assert.equal(result.credential.principal, "fixture-operator");
    assert.equal(result.credential.token, "mock.bridge.jwt");
    assert.equal(result.credential.tenantId, "tenant-123");
    assert.equal(result.credential.channel, "vault-chat");
    assert.match(result.credential.machineId, /^[0-9a-f]{8}$/);
    assert.equal(seen[0].code, "12345678");
    assert.equal(seen[0].principal, "fixture-operator");
    assert.equal(seen[0].channel, "vault-chat");

    const saved = await readBridgeCredential({ principal: "fixture-operator", homeDir });
    assert.equal(saved.token, "mock.bridge.jwt");
    assert.equal(result.path, bridgeCredentialPath({ principal: "fixture-operator", homeDir }));

    const mode = (await stat(result.path)).mode & 0o777;
    assert.equal(mode, 0o600);
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

test("aurelius pair CLI smokes against a mock bridge endpoint", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-pair-cli-test-"));
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/aurelius/bridge/pair") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: "cli.mock.jwt", tenantId: "tenant-cli", channel: "vault-chat" }));
    });
  });

  await listen(server);
  try {
    const address = server.address();
    const appRoot = fileURLToPath(new URL("../../", import.meta.url));
    const bridgeBaseUrl = `http://127.0.0.1:${address.port}`;
    const result = await execFileJson(process.execPath, [
      path.join(appRoot, "bin", "aurelius.mjs"),
      "pair",
      "87654321",
      "--principal",
      "cli-user",
      "--bridge-url",
      bridgeBaseUrl,
    ], {
      env: { ...process.env, HOME: homeDir, AURELIUS_MACHINE_UUID: "cli-test-machine" },
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Paired Aurelius/);
    const saved = await readBridgeCredential({ principal: "cli-user", homeDir });
    assert.equal(saved.token, "cli.mock.jwt");
    assert.equal(saved.tenantId, "tenant-cli");
  } finally {
    await close(server);
  }
});

function execFileJson(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

test("exchangeSelfPairing stores credentials via the zero-touch /pairing/self route", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-self-pair-test-"));
  const seen = [];
  let authHeader = null;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/aurelius/bridge/pairing/self") {
      res.writeHead(404).end();
      return;
    }
    authHeader = req.headers.authorization;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          tenantId: "tenant-self",
          principalUid: "uid-9",
          machineId: seen[0].machineId,
          token: "self.bridge.jwt",
          expiresAt: "2026-07-01T00:00:00.000Z",
        }),
      );
    });
  });

  await listen(server);
  try {
    const address = server.address();
    const bridgeBaseUrl = `http://127.0.0.1:${address.port}`;
    const result = await exchangeSelfPairing({
      idToken: "fake-firebase-id-token",
      principal: "Fixture Operator",
      bridgeBaseUrl,
      instanceId: "instance-7",
      homeDir,
    });

    assert.equal(authHeader, "Bearer fake-firebase-id-token");
    assert.equal(result.credential.principal, "fixture-operator");
    assert.equal(result.credential.token, "self.bridge.jwt");
    assert.equal(result.credential.tenantId, "tenant-self");
    assert.equal(result.credential.channel, "vault-chat");
    assert.equal(seen[0].instanceId, "instance-7");
    assert.match(result.credential.machineId, /^[0-9a-f]{8}$/);

    const saved = await readBridgeCredential({ principal: "fixture-operator", homeDir });
    assert.equal(saved.token, "self.bridge.jwt");
    assert.equal(result.path, bridgeCredentialPath({ principal: "fixture-operator", homeDir }));

    const mode = (await stat(result.path)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await close(server);
  }
});

test("exchangeSelfPairing requires an idToken", async () => {
  await assert.rejects(
    () => exchangeSelfPairing({ bridgeBaseUrl: "http://127.0.0.1:1" }),
    /sign-in token/,
  );
});
