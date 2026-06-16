import {
  BRIDGE_VERSION,
  DEFAULT_BRIDGE_BASE_URL,
  PAIRING_PATH,
  SELF_PAIRING_PATH,
  VAULT_CHAT_CHANNEL,
} from "./constants.mjs";
import { buildCredential, normalizePrincipal, writeBridgeCredential } from "./credentialStore.mjs";
import { getMachineFingerprint } from "./fingerprint.mjs";

export async function exchangePairingCode({
  code,
  principal = "cory",
  bridgeBaseUrl = DEFAULT_BRIDGE_BASE_URL,
  homeDir,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!/^\d{8}$/.test(String(code || ""))) {
    throw new Error("Pairing code must be exactly 8 digits.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  const normalizedPrincipal = normalizePrincipal(principal);
  const fingerprint = await getMachineFingerprint();
  const url = new URL(PAIRING_PATH, bridgeBaseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      code,
      agent: "aurelius",
      principal: normalizedPrincipal,
      machineFingerprint: fingerprint.machineId,
      machineId: fingerprint.machineId,
      hostname: fingerprint.hostname,
      version: "presence-vault-v1.4",
      channel: VAULT_CHAT_CHANNEL,
    }),
  });

  if (!response.ok) {
    throw new Error(`Pairing failed (${response.status}): ${await safeResponseText(response)}`);
  }

  const payload = await response.json();
  const token = payload.jwt ?? payload.token ?? payload.bridgeJwt;
  const tenantId = payload.tenantId ?? payload.tenant ?? payload.workspaceId;
  if (!token || !tenantId) {
    throw new Error("Pairing response must include a bridge JWT/token and tenantId.");
  }

  const credential = buildCredential({
    principal: normalizedPrincipal,
    bridgeBaseUrl: bridgeBaseUrl.replace(/\/+$/, ""),
    token,
    tenantId,
    uid: payload.uid ?? payload.principalUid ?? null,
    machineId: payload.machineId ?? fingerprint.machineId,
    hostname: payload.hostname ?? fingerprint.hostname,
    channel: payload.channel ?? VAULT_CHAT_CHANNEL,
    expiresAt: payload.expiresAt ?? null,
    seedUrl: payload.seedUrl ?? null,
    cloudBrainBaseUrl: payload.cloudBrainBaseUrl ?? null,
  });

  const path = await writeBridgeCredential(credential, { homeDir });
  return { credential, path };
}

// Zero-touch pairing: the caller is already signed in to Bench, so we exchange a
// Firebase ID token for the bridge credential (no 8-digit code). Mirrors
// exchangePairingCode and writes the same canonical credential the listener reads.
export async function exchangeSelfPairing({
  idToken,
  principal = "cory",
  bridgeBaseUrl = DEFAULT_BRIDGE_BASE_URL,
  instanceId = null,
  homeDir,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!idToken || typeof idToken !== "string") {
    throw new Error(
      "Zero-touch pairing needs a Bench sign-in token (idToken). Use 'aurelius pair <code>' if you are not signed in.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  const normalizedPrincipal = normalizePrincipal(principal);
  const fingerprint = await getMachineFingerprint();
  const url = new URL(SELF_PAIRING_PATH, bridgeBaseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      machineId: fingerprint.machineId,
      machineFingerprint: fingerprint.machineId,
      displayName: fingerprint.hostname,
      platform: process.platform,
      version: BRIDGE_VERSION,
      ...(instanceId ? { instanceId } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Zero-touch pairing failed (${response.status}): ${await safeResponseText(response)}`);
  }

  const payload = await response.json();
  const token = payload.token ?? payload.jwt ?? payload.bridgeJwt;
  const tenantId = payload.tenantId ?? payload.tenant ?? payload.workspaceId;
  if (!token || !tenantId) {
    throw new Error("Pairing response must include a bridge JWT/token and tenantId.");
  }

  const credential = buildCredential({
    principal: normalizedPrincipal,
    bridgeBaseUrl: bridgeBaseUrl.replace(/\/+$/, ""),
    token,
    tenantId,
    uid: payload.principalUid ?? payload.uid ?? null,
    machineId: payload.machineId ?? fingerprint.machineId,
    hostname: fingerprint.hostname,
    channel: VAULT_CHAT_CHANNEL,
    expiresAt: payload.expiresAt ?? null,
  });

  const path = await writeBridgeCredential(credential, { homeDir });
  return { credential, path };
}

async function safeResponseText(response) {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 600) || response.statusText || "no response body";
}
