#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exchangePairingCode, exchangeSelfPairing } from "../runtime/bridge/pairing.mjs";
import { readBridgeCredential } from "../runtime/bridge/credentialStore.mjs";
import { runBridgeListener } from "../runtime/bridge/listener.mjs";
import { readBridgeStatus } from "../runtime/bridge/statusStore.mjs";
import { readGatewayProviderStatus, setGatewayProviderKey } from "../runtime/bridge/gatewayAuth.mjs";
import { streamGatewayBridgeTurn } from "../runtime/bridge/gatewayRunner.mjs";
import {
  driftWatchEnabled,
  runDriftWatchTick,
  startDriftWatch,
} from "../runtime/bridge/driftWatch.mjs";

const BRIDGE_LABEL = "com.benchagi.aurelius-bridge";
const DRIFT_LABEL = "com.benchagi.aurelius-drift-watch";

const usage = `Usage:
  aurelius pair <8-digit-code> [--principal <name>] [--bridge-url <url>]
  aurelius link [--id-token <token|->] [--instance <id>] [--principal <name>]
  aurelius bridge install [--principal <name>]
  aurelius bridge up | down
  aurelius bridge listen [--principal <name>]
  aurelius bridge status [--principal <name>]
  aurelius bridge drift-watch [--principal <name>]     (one drift check; launchd-driven)
  aurelius bridge drift-install [--principal <name>]   (install + start the drift-watch timer)
  aurelius bridge drift-uninstall                      (stop the drift-watch timer)
  aurelius gateway set-key [--key <sk-ant-…|->] [--agent-dir <dir>]
  aurelius gateway status [--agent-dir <dir>]
  aurelius gateway ping

Zero-touch: 'aurelius link' pairs using your Bench sign-in (no code). Supply the
Firebase ID token via --id-token, AURELIUS_BRIDGE_ID_TOKEN, or stdin (--id-token -).

'aurelius gateway set-key' places the Bench-provisioned per-customer Anthropic key
into the local OpenClaw gateway's auth.json so the gateway-loop runner bills it.
Supply the key via --key -, ANTHROPIC_API_KEY, or stdin (avoid passing secrets as
literal argv). Then: AURELIUS_BRIDGE_RUNNER=gateway aurelius bridge up.

Environment:
  AURELIUS_PRINCIPAL          Principal name, default: default
  AURELIUS_BRIDGE_URL         Bridge base URL, default: https://benchagi.com
  AURELIUS_BRIDGE_ID_TOKEN    Firebase ID token for 'aurelius link'
  OPENCLAW_AGENT_DIR          Gateway agent dir (default: ~/.openclaw/agent)
  ANTHROPIC_API_KEY           Key source for 'aurelius gateway set-key'
  AURELIUS_GATEWAY_TOKEN_DISK_RESYNC  off|on (default off): the gateway runner
                              re-reads the rotating gateway token from
                              ~/.openclaw/{openclaw.json,.env} and retries once on
                              401/403 — self-heals a mid-session token rotation.
  AURELIUS_DRIFT_WATCH        off|on (default off): page #harness when the
                              paired-Mac→cloud heartbeat goes stale/revoked. The
                              'drift-install' timer arms this for itself only.
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(usage);
    return;
  }

  const flags = parseFlags(args);
  const principal = flags.principal || process.env.AURELIUS_PRINCIPAL || "default";
  const bridgeBaseUrl = flags.bridgeUrl || process.env.AURELIUS_BRIDGE_URL || "https://benchagi.com";

  if (command === "pair") {
    const code = flags.positionals[0];
    if (!code || !/^\d{8}$/.test(code)) {
      throw new Error("Pairing code must be exactly 8 digits.");
    }

    const result = await exchangePairingCode({ code, principal, bridgeBaseUrl });
    process.stdout.write(
      [
        `Paired Aurelius for principal '${result.credential.principal}'.`,
        `Machine: ${result.credential.hostname} (${result.credential.machineId})`,
        `Channel: ${result.credential.channel}`,
        `Credential: ${result.path}`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "link") {
    const idToken = await resolveIdToken(flags);
    const instanceId = flags.instance || process.env.BENCHAGI_INSTANCE_ID || null;
    const result = await exchangeSelfPairing({ idToken, principal, bridgeBaseUrl, instanceId });
    process.stdout.write(
      [
        `Linked Aurelius for principal '${result.credential.principal}' (zero-touch).`,
        `Machine: ${result.credential.hostname} (${result.credential.machineId})`,
        `Channel: ${result.credential.channel}`,
        `Credential: ${result.path}`,
        `Next: aurelius bridge install && aurelius bridge up`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "bridge" && flags.positionals[0] === "install") {
    const target = await installBridgeLaunchAgent({ principal });
    process.stdout.write(
      [`Installed Aurelius bridge launch agent: ${target}`, `Start it with: aurelius bridge up`].join("\n") + "\n",
    );
    return;
  }

  if (command === "bridge" && (flags.positionals[0] === "up" || flags.positionals[0] === "start")) {
    launchctl(["bootstrap", `gui/${process.getuid()}`, bridgePlistPath()], { ignoreError: true });
    launchctl(["kickstart", "-k", `gui/${process.getuid()}/${BRIDGE_LABEL}`]);
    process.stdout.write("Aurelius bridge started.\n");
    return;
  }

  if (command === "bridge" && (flags.positionals[0] === "down" || flags.positionals[0] === "stop")) {
    launchctl(["bootout", `gui/${process.getuid()}/${BRIDGE_LABEL}`], { ignoreError: true });
    process.stdout.write("Aurelius bridge stopped.\n");
    return;
  }

  if (command === "bridge" && flags.positionals[0] === "listen") {
    const abortController = new AbortController();
    process.on("SIGINT", () => abortController.abort());
    process.on("SIGTERM", () => abortController.abort());
    // Optional in-process drift-watch (AURELIUS_DRIFT_WATCH=on). Convenience only:
    // it dies with the bridge, so it cannot report a hard bridge crash — the
    // standalone 'bridge drift-install' timer is the durable detector.
    const stopDriftWatch = startDriftWatch({ principal, signal: abortController.signal });
    try {
      const code = await runBridgeListener({ principal, signal: abortController.signal });
      process.exitCode = code;
    } finally {
      stopDriftWatch();
    }
    return;
  }

  if (command === "bridge" && flags.positionals[0] === "drift-watch") {
    // The launchd timer calls this every minute. Default-OFF everywhere: a tick
    // without AURELIUS_DRIFT_WATCH=on is an explicit no-op (the installed plist
    // arms the flag for itself).
    if (!driftWatchEnabled()) {
      process.stdout.write(
        "AURELIUS_DRIFT_WATCH is off — drift-watch tick is a no-op. Set AURELIUS_DRIFT_WATCH=on (the installed timer does) to arm it.\n",
      );
      return;
    }
    const result = await runDriftWatchTick({ principal });
    process.stdout.write(`drift-watch: ${result.action}${result.kind ? ` (${result.kind})` : ""}\n`);
    return;
  }

  if (command === "bridge" && flags.positionals[0] === "drift-install") {
    const target = await installDriftWatchLaunchAgent({ principal });
    launchctl(["bootstrap", `gui/${process.getuid()}`, target], { ignoreError: true });
    launchctl(["kickstart", `gui/${process.getuid()}/${DRIFT_LABEL}`], { ignoreError: true });
    process.stdout.write(
      [
        `Installed + started the Aurelius drift-watch timer: ${target}`,
        `Pages #harness when the paired-Mac→cloud heartbeat goes stale/revoked.`,
        `Default-OFF elsewhere — this plist arms AURELIUS_DRIFT_WATCH=on for the timer only.`,
        `Stop it with: aurelius bridge drift-uninstall`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "bridge" && flags.positionals[0] === "drift-uninstall") {
    launchctl(["bootout", `gui/${process.getuid()}/${DRIFT_LABEL}`], { ignoreError: true });
    process.stdout.write("Aurelius drift-watch timer stopped.\n");
    return;
  }

  if (command === "bridge" && flags.positionals[0] === "status") {
    const credential = await readBridgeCredential({ principal });
    if (!credential) {
      process.stdout.write(`Aurelius bridge is not paired for principal '${principal}'.\n`);
      process.exitCode = 1;
      return;
    }
    const status = await readBridgeStatus({ principal });
    process.stdout.write(
      [
        `Aurelius bridge paired for '${credential.principal}'.`,
        `Machine: ${credential.hostname} (${credential.machineId})`,
        `Channel: ${credential.channel}`,
        `Bridge: ${credential.bridgeBaseUrl}`,
        `State: ${status?.state ?? "unknown"}`,
        `Last seen: ${status?.lastSeenAt ?? "never"}`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "gateway" && flags.positionals[0] === "set-key") {
    const apiKey = await resolveApiKey(flags);
    const result = await setGatewayProviderKey({ apiKey, explicit: flags.agentDir || undefined });
    const status = await readGatewayProviderStatus({ explicit: flags.agentDir || undefined });
    process.stdout.write(
      [
        `${result.replaced ? "Replaced" : "Placed"} Anthropic key in gateway auth.json: ${result.path}`,
        `Key: ${status.masked}`,
        `Next: AURELIUS_BRIDGE_RUNNER=gateway aurelius bridge up`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "gateway" && flags.positionals[0] === "ping") {
    // One real turn through the gateway-loop runner — the onboarding keyed-turn
    // check (L1). Needs AURELIUS_GATEWAY_TOKEN/OPENCLAW_GATEWAY_TOKEN (and
    // AURELIUS_GATEWAY_URL if the local gateway isn't on the default port).
    process.stdout.write("Pinging the keyed gateway-loop…\n");
    let text = "";
    try {
      for await (const delta of streamGatewayBridgeTurn({
        messages: [{ role: "user", content: "Reply in five words confirming you are alive." }],
        sessionId: "aurelius-gateway-ping",
      })) {
        text += delta;
        process.stdout.write(delta);
      }
    } catch (error) {
      process.stderr.write(`\n✖ gateway ping failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n✔ streamed ${text.length} chars through the keyed gateway.\n`);
    return;
  }

  if (command === "gateway" && flags.positionals[0] === "status") {
    const status = await readGatewayProviderStatus({ explicit: flags.agentDir || undefined });
    process.stdout.write(
      status.configured
        ? `Gateway anthropic key: configured (${status.type}${status.masked ? ` ${status.masked}` : ""}) at ${status.path}\n`
        : `Gateway anthropic key: NOT configured at ${status.path}\n`,
    );
    process.exitCode = status.configured ? 0 : 1;
    return;
  }

  throw new Error(`Unknown command. ${usage}`);
}

// Secret precedence: explicit flag (non-`-`) → stdin (`-` or piped) → env.
// Prefer stdin/env over literal argv so the key never lands in shell history.
async function resolveApiKey(flags) {
  if (flags.key && flags.key !== "-") return flags.key.trim();
  if (flags.key === "-" || !process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) return piped;
  }
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  throw new Error("No Anthropic key. Pass --key <sk-ant-…|->, set ANTHROPIC_API_KEY, or pipe it on stdin.");
}

function bridgePlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${BRIDGE_LABEL}.plist`);
}

// Supervise `aurelius bridge listen` under launchd so the heartbeat + SSE
// listener stays up (auto-start on login, restart on crash) — this is what
// drives the paired Mac to `connected`.
async function installBridgeLaunchAgent({ principal }) {
  const plistPath = bridgePlistPath();
  const node = process.execPath;
  const script = fileURLToPath(new URL("aurelius.mjs", import.meta.url));
  const logDir = path.join(os.homedir(), "Library", "Logs", "Aurelius");
  const logFile = path.join(logDir, "bridge.log");
  const pathEnv = `${path.join(os.homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  await mkdir(logDir, { recursive: true });
  await mkdir(path.dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BRIDGE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>bridge</string>
    <string>listen</string>
    <string>--principal</string>
    <string>${principal}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${os.homedir()}</string>
    <key>PATH</key><string>${pathEnv}</string>
    <key>AURELIUS_PRINCIPAL</key><string>${principal}</string>
  </dict>
</dict>
</plist>
`;
  await writeFile(plistPath, plist, "utf8");
  await chmod(plistPath, 0o644).catch(() => undefined);
  return plistPath;
}

function driftPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${DRIFT_LABEL}.plist`);
}

// A lean StartInterval timer that runs `aurelius bridge drift-watch` every minute
// as its OWN launchd job — so it survives a hard bridge crash (an in-process
// watcher would die with the bridge). Arms AURELIUS_DRIFT_WATCH=on for this timer
// only; the flag stays OFF everywhere else.
async function installDriftWatchLaunchAgent({ principal, intervalSeconds = 60 }) {
  const plistPath = driftPlistPath();
  const node = process.execPath;
  const script = fileURLToPath(new URL("aurelius.mjs", import.meta.url));
  const logDir = path.join(os.homedir(), "Library", "Logs", "Aurelius");
  const logFile = path.join(logDir, "drift-watch.log");
  const pathEnv = `${path.join(os.homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  await mkdir(logDir, { recursive: true });
  await mkdir(path.dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DRIFT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>bridge</string>
    <string>drift-watch</string>
    <string>--principal</string>
    <string>${principal}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${os.homedir()}</string>
    <key>PATH</key><string>${pathEnv}</string>
    <key>AURELIUS_PRINCIPAL</key><string>${principal}</string>
    <key>AURELIUS_DRIFT_WATCH</key><string>on</string>
  </dict>
</dict>
</plist>
`;
  await writeFile(plistPath, plist, "utf8");
  await chmod(plistPath, 0o644).catch(() => undefined);
  return plistPath;
}

function launchctl(args, { ignoreError = false } = {}) {
  const result = spawnSync("launchctl", args, { stdio: "inherit" });
  if (!ignoreError && result.status !== 0) {
    throw new Error(`launchctl ${args.join(" ")} failed (status ${result.status ?? "unknown"}).`);
  }
}

// Token precedence: explicit flag → stdin (when `-` or piped) → env.
async function resolveIdToken(flags) {
  if (flags.idToken && flags.idToken !== "-") return flags.idToken.trim();
  if (flags.idToken === "-" || !process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) return piped;
  }
  if (process.env.AURELIUS_BRIDGE_ID_TOKEN) return process.env.AURELIUS_BRIDGE_ID_TOKEN.trim();
  throw new Error(
    "No Bench sign-in token. Pass --id-token <token|->, set AURELIUS_BRIDGE_ID_TOKEN, or pipe it on stdin. (Or use 'aurelius pair <code>'.)",
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseFlags(args) {
  const out = {
    positionals: [],
    principal: null,
    bridgeUrl: null,
    idToken: null,
    instance: null,
    key: null,
    agentDir: null,
  };

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg === "--principal") {
      out.principal = args[++idx] ?? "";
      continue;
    }
    if (arg === "--bridge-url") {
      out.bridgeUrl = args[++idx] ?? "";
      continue;
    }
    if (arg === "--id-token") {
      out.idToken = args[++idx] ?? "";
      continue;
    }
    if (arg === "--instance") {
      out.instance = args[++idx] ?? "";
      continue;
    }
    if (arg === "--key") {
      out.key = args[++idx] ?? "";
      continue;
    }
    if (arg === "--agent-dir") {
      out.agentDir = args[++idx] ?? "";
      continue;
    }
    out.positionals.push(arg);
  }
  return out;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
