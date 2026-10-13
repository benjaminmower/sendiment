import { test } from "node:test";
import assert from "node:assert/strict";
import server from "../server.js";
import { mintSessionId, deviceFromSession } from "../session.js";

const SECRET = "test-secret";

test("session id round-trips to a stable device and rejects tampering", async () => {
  const id = await mintSessionId(SECRET);
  const device = await deviceFromSession(SECRET, id);
  assert.match(device, /^ai-[0-9a-f]{24}$/);
  assert.equal(device, await deviceFromSession(SECRET, id));
  assert.notEqual(device, await deviceFromSession(SECRET, await mintSessionId(SECRET)));

  const [rand, sig] = id.split(".");
  assert.equal(await deviceFromSession(SECRET, `${rand}.${"0".repeat(32)}`), null);
  assert.equal(await deviceFromSession(SECRET, `${"1".repeat(32)}.${sig}`), null);
  assert.equal(await deviceFromSession("other-secret", id), null);
  assert.equal(await deviceFromSession(SECRET, null), null);
  assert.equal(await deviceFromSession(SECRET, "garbage"), null);
  assert.equal(await deviceFromSession(undefined, id), null);
});

const rpc = (body, headers = {}) =>
  new Request("https://x/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const callSkip = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "skip_thought", arguments: { id: "p1" } } };

test("end to end: initialize mints a session; skip uses it; no header means no skip", async () => {
  const sent = [];
  const env = { SESSION_SECRET: SECRET, RIVER: { fetch: async (url, i) => (sent.push({ url, body: JSON.parse(i.body) }), new Response('{"ok":true}')) } };

  const res = await server.fetch(rpc(init), env);
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid, "initialize response carries a session id");

  const withSession = await (await server.fetch(rpc(callSkip, { "mcp-session-id": sid }), env)).text();
  assert.match(withSession, /Skipped/);
  assert.match(sent[0].url, /\/skip$/);
  assert.equal(sent[0].body.source, "ai");
  assert.equal(sent[0].body.device, await deviceFromSession(SECRET, sid));

  const without = await (await server.fetch(rpc(callSkip), env)).text();
  assert.match(without, /needs a session/);
  assert.equal(sent.length, 1, "relay not called without a valid session");

  const forged = await (await server.fetch(rpc(callSkip, { "mcp-session-id": "f".repeat(32) + "." + "0".repeat(32) }), env)).text();
  assert.match(forged, /needs a session/);
});
