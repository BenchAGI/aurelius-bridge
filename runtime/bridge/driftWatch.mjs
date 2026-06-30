// Bridge cloud-leg drift watcher. Reads the bridge-status.json the listener
// stamps every heartbeat; if the heartbeat goes stale or the credential is
// revoked, it pages #harness so a dead paired-Mac→cloud leg is DETECTED instead
// of silently dropping Relay turns. Pages at most once per drift onset (then at
// most once per cooldown while it persists) and once on recovery — page-dedupe
// state is persisted to disk so it survives across one-shot launchd ticks.
//
// Gated by AURELIUS_DRIFT_WATCH (default OFF). Every port (status reader, state
// store, pager, clock) is injectable for tests.
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { bridgeAgentDir, normalizePrincipal } from "./credentialStore.mjs";
import { readBridgeStatus } from "./statusStore.mjs";
import { pageHarness } from "./slackPager.mjs";

// Listener heartbeat is 25s; 3 missed beats = drift.
export const DEFAULT_STALE_MS = 75_000;
// Re-page no more than this often while a drift persists.
export const DEFAULT_PAGE_COOLDOWN_MS = 15 * 60_000;
// Standalone (launchd) tick cadence.
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

export function driftWatchStatePath(options = {}) {
  return path.join(bridgeAgentDir(options), "drift-watch-state.json");
}

export function driftWatchEnabled() {
  return (process.env.AURELIUS_DRIFT_WATCH || "off").toLowerCase() === "on";
}

// Pure classifier for a bridge-status doc. revoked is terminal; otherwise the
// lastSeenAt clock decides. connecting/reconnecting are NOT special-cased — the
// staleness clock alone governs them, so normal reconnect backoff never pages.
export function evaluateDrift(status, { now, staleMs = DEFAULT_STALE_MS } = {}) {
  if (!status) return { healthy: null, kind: "no_status" };
  if (status.state === "revoked" || status.paired === false) {
    return { healthy: false, kind: "revoked", ageMs: null };
  }
  const lastSeen = Date.parse(status.lastSeenAt);
  if (!Number.isFinite(lastSeen)) {
    return { healthy: false, kind: "stale", ageMs: null };
  }
  const ageMs = now - lastSeen;
  if (ageMs > staleMs) return { healthy: false, kind: "stale", ageMs };
  return { healthy: true, kind: "ok", ageMs };
}

function ageNote(verdict) {
  return verdict.ageMs != null ? ` (last seen ${Math.round(verdict.ageMs / 1000)}s ago)` : "";
}

function driftMessage(principal, status, verdict) {
  const stateNote = status?.state ? ` state=${status.state}` : "";
  if (verdict.kind === "revoked") {
    return `:rotating_light: Aurelius bridge cloud-leg REVOKED — principal \`${principal}\`.${stateNote} The paired-Mac→cloud credential was rejected; Relay turns from this machine will not deliver until it re-pairs.`;
  }
  return `:rotating_light: Aurelius bridge cloud-leg STALE — principal \`${principal}\`.${stateNote}${ageNote(verdict)} The heartbeat has stopped; Relay turns from this machine may be dropping silently.`;
}

function recoveryMessage(principal, status, verdict) {
  return `:white_check_mark: Aurelius bridge cloud-leg RECOVERED — principal \`${principal}\` back to \`${status?.state ?? "connected"}\`${ageNote(verdict)}.`;
}

async function defaultLoadState(options) {
  try {
    return JSON.parse(await readFile(driftWatchStatePath(options), "utf8"));
  } catch {
    return null;
  }
}

async function defaultSaveState(state, options = {}) {
  const dir = bridgeAgentDir(options);
  const target = driftWatchStatePath(options);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
  return target;
}

// One evaluation tick. Returns { action: ok|paged|suppressed|recovered|skip, ... }.
export async function runDriftWatchTick({
  principal = process.env.AURELIUS_PRINCIPAL || "default",
  homeDir,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  cooldownMs = DEFAULT_PAGE_COOLDOWN_MS,
  readStatus = readBridgeStatus,
  loadState = defaultLoadState,
  saveState = defaultSaveState,
  page = pageHarness,
} = {}) {
  const principalNorm = normalizePrincipal(principal);
  const opts = { principal: principalNorm, homeDir };
  const status = await readStatus(opts);
  const verdict = evaluateDrift(status, { now, staleMs });

  // No status file: the bridge may simply not run on this machine. Do not page
  // (avoids false alarms on non-bridge hosts). A started-then-died bridge leaves
  // a stale/revoked file and IS caught below.
  if (verdict.healthy === null) {
    return { action: "skip", reason: "no_status" };
  }

  const prior = (await loadState(opts)) || { alerted: false, lastPagedAt: 0, kind: null };

  if (!verdict.healthy) {
    const dueAgain = now - (prior.lastPagedAt || 0) >= cooldownMs;
    if (!prior.alerted || dueAgain) {
      const paged = await page(driftMessage(principalNorm, status, verdict), { homeDir });
      await saveState({ alerted: true, lastPagedAt: now, kind: verdict.kind }, opts);
      return { action: "paged", kind: verdict.kind, paged };
    }
    return { action: "suppressed", kind: verdict.kind };
  }

  // Healthy.
  if (prior.alerted) {
    const paged = await page(recoveryMessage(principalNorm, status, verdict), { homeDir });
    await saveState({ alerted: false, lastPagedAt: now, kind: null }, opts);
    return { action: "recovered", paged };
  }
  return { action: "ok" };
}

// In-process watcher (gated) — a convenience for `bridge listen`. It dies WITH
// the bridge, so it cannot report a hard bridge crash; the standalone launchd
// timer (aurelius bridge drift-install) is the durable detector. Returns stop().
export function startDriftWatch({ principal, homeDir, signal, intervalMs = DEFAULT_TICK_INTERVAL_MS } = {}) {
  if (!driftWatchEnabled()) return () => {};
  const timer = setInterval(() => {
    runDriftWatchTick({ principal, homeDir }).catch((error) => {
      console.warn(`[aurelius-drift-watch] tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  const stop = () => clearInterval(timer);
  if (signal) signal.addEventListener("abort", stop, { once: true });
  return stop;
}
