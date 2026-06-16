import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

let cachedSafeCwd = null;

export async function* streamClaudeBridgeTurn({ messages, sessionId, seedContent = "", maxBudgetUsd = 0.5 }) {
  const cliSessionId = isUuid(sessionId) ? sessionId : randomUUID();
  const systemPromptFile = await writeTempPrompt("bridge-system", renderSystemPrompt(seedContent));
  const cwd = await safeCwd();
  const args = [
    "-p",
    "--session-id",
    cliSessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--model",
    process.env.AURELIUS_CLAUDE_MODEL || DEFAULT_MODEL,
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--system-prompt-file",
    systemPromptFile,
  ];

  try {
    for await (const delta of runClaudeStream(args, renderPrompt(messages), cwd)) {
      yield delta;
    }
  } finally {
    await rm(path.dirname(systemPromptFile), { recursive: true, force: true });
  }
}

async function* runClaudeStream(args, input, cwd) {
  const child = spawn(process.env.AURELIUS_CLAUDE_BIN || "claude", args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);

  let stderr = "";
  let resultEvent = null;
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const event = parseJsonLine(line);
    if (!event) continue;

    if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
      const delta = event.event.delta;
      if (delta?.type === "text_delta" && delta.text) yield delta.text;
    }

    if (event.type === "result") resultEvent = event;
  }

  const exit = await waitForExit(child);
  if (spawnError) throw new Error("claude CLI not found or not authenticated; run `claude /login` and retry");
  if (exit.code !== 0 || resultEvent?.is_error) {
    throw new Error(errorMessageFromResult(resultEvent, stderr));
  }
}

function renderSystemPrompt(seedContent) {
  return [
    "You are Aurelius, running through the Presence Vault bridge.",
    "Every response is produced by the local Claude CLI subprocess on this machine. Do not claim cloud inference or external action.",
    "This bridge turn is conversational unless the prompt contains explicit tool output already supplied by the local runtime.",
    seedContent ? `Cloud brain seed content:\n\n${seedContent}` : "Cloud brain seed content: not loaded for this turn.",
  ].join("\n\n");
}

function renderPrompt(messages) {
  return [
    "Answer the current bridge chat turn.",
    "",
    "Conversation:",
    messages.map((message) => `${String(message.role || "user").toUpperCase()}: ${message.content ?? ""}`).join("\n\n"),
  ].join("\n");
}

async function writeTempPrompt(prefix, content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `aurelius-${prefix}-`));
  const filePath = path.join(dir, "prompt.md");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

async function safeCwd() {
  if (cachedSafeCwd) return cachedSafeCwd;
  const dir = path.join(os.tmpdir(), "aurelius-bridge-cwd");
  await mkdir(dir, { recursive: true });
  cachedSafeCwd = dir;
  return dir;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    console.warn("[aurelius-bridge:claude] non-json stdout line", line.slice(0, 200));
    return null;
  }
}

function errorMessageFromResult(result, stderr) {
  const details = [stderr.trim(), typeof result?.result === "string" ? result.result : ""].filter(Boolean).join("\n").trim();
  if (/auth|login|oauth|api key|not authenticated|credentials/i.test(details)) {
    return "claude CLI not authenticated; run `claude /login` and retry";
  }
  return details || "claude CLI failed without a detailed error.";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}
