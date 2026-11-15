// Thin wrappers around navigator.credentials that convert between the JSON
// the server speaks (base64url strings) and the ArrayBuffers the browser wants.

import { api } from "./api";

function toBytes(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

function friendlyError(e: unknown): Error {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return new Error("The passkey prompt was cancelled or timed out.");
    if (e.name === "InvalidStateError") return new Error("This device already has a passkey for Driftwatch.");
    if (e.name === "SecurityError")
      return new Error("Passkeys need HTTPS and a URL matching DRIFTWATCH_PUBLIC_URL.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

export async function signInWithPasskey(): Promise<void> {
  const { challengeId, options } = await api.loginBegin();
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: toBytes(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: [],
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw friendlyError(e);
  }
  const r = cred.response as AuthenticatorAssertionResponse;
  await api.loginFinish(challengeId, {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : null,
    },
  });
}

export async function registerPasskey(name: string, invite?: string): Promise<void> {
  const { challengeId, options } = await api.registerBegin(invite);
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: toBytes(options.challenge),
        rp: options.rp,
        user: { ...options.user, id: toBytes(options.user.id) },
        pubKeyCredParams: options.pubKeyCredParams,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials.map((c: { id: string; type: "public-key" }) => ({
          type: c.type,
          id: toBytes(c.id),
        })),
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw friendlyError(e);
  }
  const r = cred.response as AuthenticatorAttestationResponse;
  await api.registerFinish(challengeId, name, {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
    },
  });
}

/** A reasonable default name for a new passkey, based on the browser/OS. */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${browser} on ${os}` : os;
}
