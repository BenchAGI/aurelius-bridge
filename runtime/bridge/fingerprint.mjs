import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

export const FINGERPRINT_SALT = "openclaw:presence-vault:v1.4:tethered-kestrel";

export function first8Sha256(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export function machineFingerprintFromParts({ hostname, systemUuid, salt = FINGERPRINT_SALT }) {
  const normalizedHost = String(hostname || "unknown-host").trim().toLowerCase();
  const normalizedUuid = String(systemUuid || "unknown-system").trim().toLowerCase();
  const normalizedSalt = String(salt || FINGERPRINT_SALT).trim();
  return first8Sha256([normalizedHost, normalizedUuid, normalizedSalt].join("\0"));
}

export async function getMachineFingerprint() {
  const hostname = os.hostname();
  const systemUuid = await getSystemUuid();
  return {
    machineId: machineFingerprintFromParts({ hostname, systemUuid }),
    hostname,
    systemUuid,
    salt: FINGERPRINT_SALT,
  };
}

export async function getSystemUuid() {
  if (process.env.AURELIUS_MACHINE_UUID) return process.env.AURELIUS_MACHINE_UUID;

  if (process.platform === "darwin") {
    const uuid = await darwinPlatformUuid();
    if (uuid) return uuid;
  }

  if (process.platform === "linux") {
    const uuid = await readFirstExistingFile(["/etc/machine-id", "/var/lib/dbus/machine-id"]);
    if (uuid) return uuid;
  }

  return `${os.platform()}:${os.arch()}:${os.userInfo().username}:${os.homedir()}`;
}

async function darwinPlatformUuid() {
  const output = await execFileText("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).catch(() => "");
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

async function readFirstExistingFile(files) {
  for (const file of files) {
    try {
      const value = (await readFile(file, "utf8")).trim();
      if (value) return value;
    } catch {
      // Continue through platform fallbacks.
    }
  }
  return null;
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
