/**
 * Agent identity without accounts or fingerprinting.
 *
 * At `initialize` the server mints a random session id and signs it with
 * SESSION_SECRET; compliant clients echo it back in `Mcp-Session-Id`. The
 * river's `device` for an agent is a hash of that id, so "one skip per pebble"
 * and "no self-skip" hold within a session. Nothing about the caller (IP,
 * user agent, client name) is read or stored. The transport itself stays
 * stateless: the signature is the only state, so there is no KV to run.
 */

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))).slice(0, 32);
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintSessionId(secret) {
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `${id}.${await hmac(secret, id)}`;
}

/** Returns the river device id for a valid session header, else null. */
export async function deviceFromSession(secret, header) {
  if (!secret || typeof header !== "string") return null;
  const [id, sig, extra] = header.split(".");
  if (!id || !sig || extra !== undefined || !/^[0-9a-f]{32}$/.test(id)) return null;
  if (!same(sig, await hmac(secret, id))) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("device|" + id));
  return "ai-" + hex(digest).slice(0, 24);
}
