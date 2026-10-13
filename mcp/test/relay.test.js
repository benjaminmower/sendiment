import { test } from "node:test";
import assert from "node:assert/strict";
import relay from "../../worker/worker.js";

const post = (path, body, headers = {}) =>
  new Request("https://relay" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const cast = { body: "a quiet thought", device: "device-12345678", source: "ai" };
const skip = { ref: "p1", device: "device-12345678", source: "ai" };

// A DB that throws proves the request got past the source check.
const reachedDb = { DB: { prepare: () => { throw new Error("db"); } } };

for (const [name, path, body] of [["cast", "/cast", cast], ["skip", "/skip", skip]]) {
  test(`${name}: source "ai" without the secret header is refused`, async () => {
    const res = await relay.fetch(post(path, body), { AI_SECRET: "shh", ...reachedDb });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "bad_source");
  });

  test(`${name}: wrong secret is refused; unset secret fails closed`, async () => {
    const wrong = await relay.fetch(post(path, body, { "x-sendiment-ai": "nope" }), { AI_SECRET: "shh", ...reachedDb });
    assert.equal(wrong.status, 403);
    const unset = await relay.fetch(post(path, body, { "x-sendiment-ai": "shh" }), { ...reachedDb });
    assert.equal(unset.status, 403);
  });

  test(`${name}: matching secret gets past the source check`, async () => {
    const res = await relay.fetch(post(path, body, { "x-sendiment-ai": "shh" }), { AI_SECRET: "shh", ...reachedDb });
    assert.equal(res.status, 500); // reached the (fake, throwing) DB
  });

  test(`${name}: human source needs no header`, async () => {
    const res = await relay.fetch(post(path, { ...body, source: undefined }), { AI_SECRET: "shh", ...reachedDb });
    assert.equal(res.status, 500);
  });
}
