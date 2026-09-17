/**
 * Sendiment river relay.
 *
 * Three endpoints:
 *   POST /cast   { body, device, source? } -> { id, ts }
 *   POST /skip   { ref, device }           -> { ok: true }
 *   GET  /river?after=<ms>&limit=<n>       -> { pebbles: [...], now }
 *
 * Design notes:
 *  - Physics (lifespan, size) is computed client-side from ts + skip count,
 *    so this worker stays a dumb store. Same functions, one definition:
 *    see physics.js in the client.
 *  - `device` is an opaque client uuid. It exists only to enforce one skip
 *    per pebble and to stop self-skipping. It is never returned to anyone.
 *  - Nothing here is a security boundary against a determined attacker.
 *    It is a speed bump sized for an art project.
 */

const MAX_BODY = 280;
const DAY = 86400000;
const CAST_LIMIT = 20;   // per device per 24h
const SKIP_LIMIT = 200;  // per device per 24h
const GLOBAL_CAST_PER_MIN = 60;

// Surface filter. The river can decline to show what it stores.
// Keep this small and boring; expand as needed.
const BLOCKED = [
  /\bkill\s+your\s*self\b/i,
  /\bkys\b/i,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function cleanDevice(d) {
  if (typeof d !== "string") return null;
  const v = d.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  return v.length >= 8 ? v : null;
}

function cleanSource(s) {
  return s === "ai" ? "ai" : "human";
}

function cleanBody(b) {
  if (typeof b !== "string") return null;
  // Strip control chars except newline, collapse runs of whitespace.
  const v = b.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
             .replace(/[ \t]+/g, " ")
             .trim();
  if (!v || [...v].length > MAX_BODY) return null;
  if (BLOCKED.some((re) => re.test(v))) return null;
  return v;
}

async function countSince(env, device, kind, since) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM actions WHERE device = ? AND kind = ? AND ts > ?"
  ).bind(device, kind, since).first();
  return row ? row.n : 0;
}

async function cast(request, env) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

  const device = cleanDevice(payload.device);
  const body = cleanBody(payload.body);
  const source = cleanSource(payload.source);
  if (!device) return json({ error: "bad_device" }, 400);
  if (!body) return json({ error: "bad_body" }, 400);

  const now = Date.now();

  const global = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM actions WHERE kind = 'cast' AND ts > ?"
  ).bind(now - 60000).first();
  if (global && global.n >= GLOBAL_CAST_PER_MIN) {
    return json({ error: "river_busy" }, 503);
  }

  if (await countSince(env, device, "cast", now - DAY) >= CAST_LIMIT) {
    return json({ error: "rate_limited" }, 429);
  }

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pebbles (id, body, ts, device, source) VALUES (?, ?, ?, ?, ?)")
      .bind(id, body, now, device, source),
    env.DB.prepare("INSERT INTO actions (device, kind, ts) VALUES (?, 'cast', ?)")
      .bind(device, now),
  ]);

  return json({ id, ts: now });
}

async function skip(request, env) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

  const device = cleanDevice(payload.device);
  const ref = typeof payload.ref === "string" ? payload.ref.slice(0, 64) : null;
  if (!device || !ref) return json({ error: "bad_request" }, 400);

  const now = Date.now();

  const pebble = await env.DB.prepare(
    "SELECT device, ts FROM pebbles WHERE id = ? AND hidden = 0"
  ).bind(ref).first();
  if (!pebble) return json({ error: "not_found" }, 404);
  if (pebble.device === device) return json({ error: "own_pebble" }, 403);

  if (await countSince(env, device, "skip", now - DAY) >= SKIP_LIMIT) {
    return json({ error: "rate_limited" }, 429);
  }

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO skips (ref, device, ts) VALUES (?, ?, ?)")
        .bind(ref, device, now),
      env.DB.prepare("INSERT INTO actions (device, kind, ts) VALUES (?, 'skip', ?)")
        .bind(device, now),
    ]);
  } catch {
    return json({ error: "already_skipped" }, 409); // PK collision
  }

  return json({ ok: true });
}

async function river(request, env) {
  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after")) || 0;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 100);
  const now = Date.now();

  // Pull recent pebbles with their skip counts. Expiry is computed client-side
  // from ts + skips; we bound the query generously and let physics decide.
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.body, p.ts, p.source, COUNT(s.ref) AS skips
    FROM pebbles p
    LEFT JOIN skips s ON s.ref = p.id
    WHERE p.hidden = 0 AND p.ts > ? AND p.ts > ?
    GROUP BY p.id
    ORDER BY p.ts ASC
    LIMIT ?
  `).bind(after, now - 14 * DAY, limit).all();

  return json({ pebbles: results || [], now });
}

// Housekeeping: drop rows no longer needed by anything.
async function sweep(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM actions WHERE ts < ?").bind(now - 2 * DAY),
    env.DB.prepare("DELETE FROM skips WHERE ts < ?").bind(now - 30 * DAY),
    env.DB.prepare("DELETE FROM pebbles WHERE ts < ?").bind(now - 30 * DAY),
  ]);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const { pathname } = new URL(request.url);

    try {
      if (request.method === "POST" && pathname === "/cast") return await cast(request, env);
      if (request.method === "POST" && pathname === "/skip") return await skip(request, env);
      if (request.method === "GET" && pathname === "/river") return await river(request, env);
      if (request.method === "GET" && pathname === "/healthz") return json({ ok: true });
    } catch (err) {
      return json({ error: "river_error" }, 500);
    }

    return json({ error: "not_found" }, 404);
  },

  // Runs on the cron trigger in wrangler.toml.
  async scheduled(event, env) {
    await sweep(env);
  },
};
