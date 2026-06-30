// Tiny dotenv/JSON readers shared by the gateway-token resolver and the Slack
// pager. Async (node:fs/promises) to match the bridge's IO idiom; every reader
// returns null on a missing/garbage source rather than throwing, so callers can
// treat "absent" and "unreadable" uniformly. Mirrors the helpers in
// apps/relay/relay-v3.mjs (the bridge cannot import the relay).
import { readFile } from "node:fs/promises";

// Strip a single matching pair of surrounding quotes + trim; null when empty.
export function decodeEnvValue(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || null;
  }
  return trimmed;
}

// Read a single dotenv-style KEY=value (tolerates `export ` and quotes). Returns
// null when the file is missing or the key is absent.
export async function readEnvFileValue(filePath, key) {
  let body;
  try {
    body = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const prefix = new RegExp(`^(?:export\\s+)?${key}=`);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !prefix.test(line)) continue;
    const [, rawValue = ""] = line.split(/=(.*)/s);
    return decodeEnvValue(rawValue);
  }
  return null;
}

// Parse a JSON file; null on any read/parse failure.
export async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
