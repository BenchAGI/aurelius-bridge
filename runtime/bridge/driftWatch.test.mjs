import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDrift, runDriftWatchTick, DEFAULT_STALE_MS } from "./driftWatch.mjs";

const T0 = 1_700_000_000_000;

function statusAt(state, ageMs) {
  return { state, paired: state !== "revoked", lastSeenAt: new Date(T0 - ageMs).toISOString() };
}

// In-memory state store + page spy bound to a fixed clock.
function harness({ status }) {
  let state = null;
  const pages = [];
  const deps = {
    now: T0,
    readStatus: async () => status,
    loadState: async () => state,
    saveState: async (s) => {
      state = s;
    },
    page: async (text) => {
      pages.push(text);
      return { ok: true };
    },
  };
  return { deps, pages, getState: () => state };
}

test("evaluateDrift: fresh = healthy, old = stale, revoked = unhealthy, null = unknown", () => {
  assert.equal(evaluateDrift(statusAt("connected", 5_000), { now: T0 }).healthy, true);
  assert.equal(evaluateDrift(statusAt("connected", DEFAULT_STALE_MS + 1), { now: T0 }).healthy, false);
  assert.equal(evaluateDrift(statusAt("revoked", 0), { now: T0 }).kind, "revoked");
  assert.equal(evaluateDrift(null, { now: T0 }).healthy, null);
});

test("fresh heartbeat does not page", async () => {
  const h = harness({ status: statusAt("connected", 3_000) });
  const r = await runDriftWatchTick({ ...h.deps });
  assert.equal(r.action, "ok");
  assert.equal(h.pages.length, 0);
});

test("stale heartbeat pages once, then suppresses within cooldown", async () => {
  const h = harness({ status: statusAt("connected", DEFAULT_STALE_MS + 10_000) });
  const r1 = await runDriftWatchTick({ ...h.deps });
  assert.equal(r1.action, "paged");
  assert.equal(r1.kind, "stale");
  assert.equal(h.pages.length, 1);
  assert.match(h.pages[0], /STALE/);

  const r2 = await runDriftWatchTick({ ...h.deps });
  assert.equal(r2.action, "suppressed");
  assert.equal(h.pages.length, 1);
});

test("revoked pages immediately", async () => {
  const h = harness({ status: statusAt("revoked", 0) });
  const r = await runDriftWatchTick({ ...h.deps });
  assert.equal(r.action, "paged");
  assert.equal(r.kind, "revoked");
  assert.match(h.pages[0], /REVOKED/);
});

test("recovery pages once when the leg returns", async () => {
  let status = statusAt("connected", DEFAULT_STALE_MS + 10_000);
  let state = null;
  const pages = [];
  const deps = () => ({
    now: T0,
    readStatus: async () => status,
    loadState: async () => state,
    saveState: async (s) => {
      state = s;
    },
    page: async (text) => {
      pages.push(text);
      return { ok: true };
    },
  });

  await runDriftWatchTick(deps()); // drift → page + set alerted
  assert.equal(pages.length, 1);

  status = statusAt("connected", 2_000); // recovered
  const r = await runDriftWatchTick(deps());
  assert.equal(r.action, "recovered");
  assert.match(pages[1], /RECOVERED/);
  assert.equal(state.alerted, false);
});

test("no status file = skip (no page on a non-bridge host)", async () => {
  const h = harness({ status: null });
  const r = await runDriftWatchTick({ ...h.deps });
  assert.equal(r.action, "skip");
  assert.equal(h.pages.length, 0);
});
