import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCredential, writeBridgeCredential } from "./credentialStore.mjs";
import { runBridgeListener } from "./listener.mjs";

test("simulated bridge chat event invokes Claude CLI and streams tokens upstream", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "aurelius-chat-path-test-"));
  const cliLog = path.join(homeDir, "mock-cli.json");
  const mockCli = path.join(homeDir, "mock-claude.cjs");
  await writeMockClaude(mockCli, cliLog);

  const postedEvents = [];
  let sseRes = null;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/aurelius/bridge/heartbeat") {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/aurelius/bridge/events") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        postedEvents.push(payload.event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        if (payload.event?.type === "chat.final" && sseRes) {
          sseRes.write(`data: ${JSON.stringify({ type: "credential.revoked" })}\n\n`);
          setTimeout(() => sseRes.end(), 10);
        }
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/v1/aurelius/bridge/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      sseRes = res;
      res.write(
        `data: ${JSON.stringify({
          type: "chat.message",
          sessionId: "bridge-session-123",
          turnId: "turn-1",
          messages: [{ role: "user", content: "Say hello through the bridge." }],
        })}\n\n`,
      );
      return;
    }

    res.writeHead(404).end();
  });

  await listen(server);
  const previousCliBin = process.env.AURELIUS_CLAUDE_BIN;
  try {
    const address = server.address();
    const bridgeBaseUrl = `http://127.0.0.1:${address.port}`;
    process.env.AURELIUS_CLAUDE_BIN = mockCli;
    await writeBridgeCredential(
      buildCredential({
        principal: "chat-test",
        bridgeBaseUrl,
        token: "chat.jwt",
        tenantId: "tenant-chat",
        machineId: "facefeed",
        hostname: "chat-host",
      }),
      { homeDir },
    );

    const code = await runBridgeListener({
      principal: "chat-test",
      homeDir,
      minBackoffMs: 5,
      maxBackoffMs: 10,
      heartbeatIntervalMs: 20,
    });

    assert.equal(code, 2);
    assert.deepEqual(
      postedEvents.map((event) => event.type),
      ["chat.started", "chat.token", "chat.token", "chat.final"],
    );
    assert.equal(postedEvents.filter((event) => event.type === "chat.token").map((event) => event.token).join(""), "Hello bridge.");
    assert.equal(postedEvents.find((event) => event.type === "chat.final")?.text, "Hello bridge.");

    const cliInvocation = JSON.parse(await readFile(cliLog, "utf8"));
    assert.ok(cliInvocation.args.includes("--output-format"));
    assert.match(cliInvocation.stdin, /Say hello through the bridge/);

    const transcript = await findTranscript(homeDir, "bridge-session-123");
    assert.match(transcript, /Say hello through the bridge/);
    assert.match(transcript, /Hello bridge\./);
  } finally {
    if (previousCliBin === undefined) delete process.env.AURELIUS_CLAUDE_BIN;
    else process.env.AURELIUS_CLAUDE_BIN = previousCliBin;
    await close(server);
  }
});

async function writeMockClaude(filePath, logPath) {
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      filePath,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => input += String(chunk));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), stdin: input }));
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } }));
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "bridge." } } }));
  console.log(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
});
`,
      "utf8",
    ),
  );
  await chmod(filePath, 0o700);
}

async function findTranscript(homeDir, sessionId) {
  const sessionsRoot = path.join(homeDir, ".openclaw", "wiki", "main", "sessions");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return readFile(path.join(sessionsRoot, "chat-test", today, sessionId, "transcript.md"), "utf8");
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
