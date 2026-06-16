import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { connectEventStream } from "./bridgeClient.mjs";
import { buildCredential } from "./credentialStore.mjs";

test("connectEventStream parses CRLF-separated SSE frames", async () => {
  const events = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/v1/aurelius/bridge/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`data: ${JSON.stringify({ type: "chat.message", sessionId: "crlf-session" })}\r\n\r\n`);
      res.write("data: [DONE]\r\n\r\n");
      res.end();
      return;
    }

    res.writeHead(404).end();
  });

  await listen(server);
  try {
    await connectEventStream(
      buildCredential({
        principal: "crlf-test",
        bridgeBaseUrl: `http://127.0.0.1:${server.address().port}`,
        token: "crlf.jwt",
        tenantId: "tenant-crlf",
        machineId: "f00dbabe",
        hostname: "crlf-host",
      }),
      {
        onEvent: (event) => events.push(event),
      },
    );

    assert.deepEqual(events, [{ type: "chat.message", sessionId: "crlf-session" }]);
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
