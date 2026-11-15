// Software WebAuthn authenticator for end-to-end testing Driftwatch.
// Usage: node authn.mjs <baseUrl> <inviteFile> <outDir>
// Registers a passkey with the invite, signs in, adds an agent (127.0.0.1:7443)
// and writes outDir/agent.env, outDir/cookie.txt. Use a scratch outDir: these
// files hold test credentials.
import crypto from "node:crypto";
import fs from "node:fs";

const [base, inviteFile, outDir] = process.argv.slice(2);
const origin = new URL(base).origin;
const rpId = new URL(base).hostname;
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

// --- minimal CBOR encoder ---
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported");
}

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const credId = crypto.randomBytes(16);
const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));

function authData(flags, count, attested) {
  const c = Buffer.alloc(4); c.writeUInt32BE(count);
  const parts = [sha256(rpId), Buffer.from([flags]), c];
  if (attested) {
    const l = Buffer.alloc(2); l.writeUInt16BE(credId.length);
    parts.push(Buffer.alloc(16), l, credId, cose);
  }
  return Buffer.concat(parts);
}

// 1. Register with the invite.
const invite = fs.readFileSync(inviteFile, "utf8").trim();
const reg = await call("POST", "/api/auth/register/begin", { invite });
const cd1 = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: reg.options.challenge, origin }));
const att = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x45, 0, true)]]));
await call("POST", "/api/auth/register/finish", {
  challengeId: reg.challengeId,
  name: "e2e software key",
  credential: { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(cd1), attestationObject: b64u(att) } },
});
console.log("registered; session cookie set:", cookie.length > 0);

// 2. Invite is single use (checked without the session cookie).
{
  const saved = cookie;
  cookie = "";
  try { await call("POST", "/api/auth/register/begin", { invite }); console.log("FAIL: invite was reusable"); }
  catch { console.log("used invite rejected: true"); }
  cookie = saved;
}

// 3. Fresh sign-in with the passkey.
cookie = "";
const login = await call("POST", "/api/auth/login/begin");
const cd2 = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: login.options.challenge, origin }));
const ad = authData(0x05, 1, false);
const sig = crypto.sign("sha256", Buffer.concat([ad, sha256(cd2)]), privateKey);
await call("POST", "/api/auth/login/finish", {
  challengeId: login.challengeId,
  credential: { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(cd2), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null } },
});
console.log("signed in:", (await call("GET", "/api/auth/status")).authenticated);

// 4. Replaying the same assertion must fail.
try {
  await call("POST", "/api/auth/login/finish", { challengeId: login.challengeId, credential: {} });
  console.log("FAIL: replay accepted");
} catch (e) { console.log("replay rejected:", e.message.includes("4")); }

// 5. Add an agent and save its env for the test agent process.
const created = await call("POST", "/api/agents", { name: "Test Agent", address: "127.0.0.1", port: 7443 });
fs.writeFileSync(`${outDir}/agent.env`, created.snippet.env.split("\n").filter((l) => l.startsWith("DRIFTWATCH_")).map((l) => `export ${l}`).join("\n") + "\n", { mode: 0o600 });
fs.writeFileSync(`${outDir}/compose-agent.yaml`, created.snippet.compose);
fs.writeFileSync(`${outDir}/cookie.txt`, cookie, { mode: 0o600 });
console.log("agent created:", created.agent.id, created.agent.fingerprint.slice(0, 12));
