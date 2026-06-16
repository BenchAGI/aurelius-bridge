import assert from "node:assert/strict";
import test from "node:test";

import { machineFingerprintFromParts } from "./fingerprint.mjs";

test("machineFingerprintFromParts is stable and first8 hex", () => {
  const first = machineFingerprintFromParts({
    hostname: "Cory-Mac-Studio.local",
    systemUuid: "11111111-2222-3333-4444-555555555555",
    salt: "unit-test",
  });
  const second = machineFingerprintFromParts({
    hostname: "cory-mac-studio.local",
    systemUuid: "11111111-2222-3333-4444-555555555555",
    salt: "unit-test",
  });

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}$/);
});

test("machineFingerprintFromParts changes when durable machine inputs change", () => {
  const base = machineFingerprintFromParts({
    hostname: "mac-a",
    systemUuid: "uuid-a",
    salt: "unit-test",
  });

  assert.notEqual(
    base,
    machineFingerprintFromParts({
      hostname: "mac-b",
      systemUuid: "uuid-a",
      salt: "unit-test",
    }),
  );
  assert.notEqual(
    base,
    machineFingerprintFromParts({
      hostname: "mac-a",
      systemUuid: "uuid-b",
      salt: "unit-test",
    }),
  );
});
