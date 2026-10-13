/**
 * Sendiment river relay.
 *
 * Endpoints:
 *   POST /cast   { body, device, source? } -> { id, ts }
 *   POST /skip   { ref, device, source? }  -> { ok: true }   (410 expired if already sunk)
 *   GET  /river?after=<ms>&limit=<n>[&order=desc][&live=1] -> { pebbles: [...], now }
 *   POST /hide   { id } | { device }       -> { ok, hidden }   (needs MOD_KEY)
 *
 * Design notes:
 *  - Physics (lifespan, size) is computed client-side from ts + skip count,
 *    so this worker stays a dumb store. Same functions, one definition:
 *    see physics.js in the client.
 *  - `device` is an opaque client uuid. It exists only to enforce one skip
 *    per pebble and to stop self-skipping. It is never returned to anyone.
 *    Because the client picks it, nothing keyed on it alone is a limit —
 *    so every per-device limit has a per-network twin keyed on a salted,
 *    daily-rotating hash of the caller's IP (the IP itself is never stored).
 *  - Nothing here is a security boundary against a determined attacker.
 *    It is a speed bump sized for an art project, and the bumps are
 *    shaped so the cheap attacks stop being worth it.
 */

import { expiresAt } from "../physics.js";

const MAX_BODY = 280;
const DAY = 86400000;
const HOUR = 3600000;

const CAST_LIMIT = 20;          // per device per 24h
const SKIP_LIMIT = 200;         // per device per 24h
const AI_SKIP_LIMIT = 20;       // per AI device per 24h (override: env.AI_SKIP_LIMIT)
const NET_CAST_LIMIT = 60;      // per network per 24h (a household, not a person)
const NET_SKIP_LIMIT = 600;     // per network per 24h
const GLOBAL_CAST_PER_MIN = 60;
const GLOBAL_SKIP_PER_MIN = 600;
const PEBBLE_SKIPS_PER_HOUR = 30;   // one pebble can only be lifted so often
const SKIP_CAP = 40;            // most skips the river will ever count for a pebble
                                // (keeps max lifespan ≈ 12 days, inside the 14-day window)
const ECHO_WINDOW = DAY;        // the same thought can't be cast twice within this

// Surface filter. The river can decline to show what it stores.
// Written tolerant of the usual dodges (spacing, 1/i, 3/e, 0/o, @/a, $/s).
const BLOCKED = [
  /\bk\s*i\s*l\s*l\s+y\s*o\s*u\s*r\s*s\s*e\s*l\s*f\b/i,
  /\bk\s*y\s*s\b/i,
  /\bn[i1!|]+[g9q]{2,}[e3]*[r5]*[sz]*\b/i,
  /\bf[a@4]+[g9]+([o0]+[t7]+)?[sz]*\b/i,
  /\bt[r]+[a@4]+[n]+[n]*[i1y]+[e3]*[sz]*\b/i,
  /\br[e3]+t[a@4]+r+d+(ed|s)?\b/i,
  /\bs[p]+[i1]+[c]+k?[sz]?\b/i,
  /\bc[h]+[i1]+n+k+[sz]?\b/i,
  /\bk[i1]+k+e+[sz]?\b/i,
];

// Links, handles and numbers to call: the river carries thoughts, not
// directions to somewhere else and not other people's details.
// Only TLDs that don't collide with English words after a missed space ("done.to").
const LINK = /(?:https?:\/\/|www\.)|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|gg|app|tv|link|site|online|shop|club|dev)\b/i;
const PHONE = /(?:\d[\s().+-]*){7,}/;
const HANDLE = /(^|\s)@[a-z0-9_]{3,}/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function digest(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Salted, daily-rotating hash of the caller's IP. Not reversible without the salt. */
async function netKey(request, env, now) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const day = new Date(now).toISOString().slice(0, 10);
  return digest(`${env.NET_SALT || "unsalted"}|${ip}|${day}`);
}

/** What a thought looks like once you stop caring how it's dressed. */
function fingerprintKey(body) {
  const k = body.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
  return k || body;
}

function cleanDevice(d) {
  if (typeof d !== "string") return null;
  const v = d.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  return v.length >= 8 ? v : null;
}

function cleanSource(s) {
  return s === "ai" ? "ai" : "human";
}

/** Returns { body } or { error }. */
function cleanBody(b) {
  if (typeof b !== "string") return { error: "bad_body" };
  let v = b.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
           .replace(/[ \t]+/g, " ")
           .replace(/\n{3,}/g, "\n\n")
           .trim();
  if (!v || [...v].length > MAX_BODY) return { error: "bad_body" };

  if (LINK.test(v)) return { error: "no_links" };
  if (HANDLE.test(v)) return { error: "no_links" };
  if (PHONE.test(v)) return { error: "no_numbers" };
  if (BLOCKED.some((re) => re.test(v))) return { error: "bad_body" };

  // Keyboard-mashing and letter floods: not a thought. Judge variety on
  // what was typed, then trim any run that's still longer than four.
  const chars = [...v.replace(/\s/g, "")];
  if (chars.length >= 12 && new Set(chars).size < 4) return { error: "bad_body" };
  v = v.replace(/(.)\1{4,}/gsu, "$1$1$1$1");

  // The river speaks quietly. Shouting is lowered, not refused.
  const letters = v.match(/\p{L}/gu) || [];
  const upper = v.match(/\p{Lu}/gu) || [];
  if (letters.length >= 12 && upper.length / letters.length >= 0.8) v = v.toLowerCase();

  return { body: v };
}

async function count(env, sql, ...binds) {
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return row ? row.n : 0;
}

const countDevice = (env, device, kind, since) =>
  count(env, "SELECT COUNT(*) AS n FROM actions WHERE device = ? AND kind = ? AND ts > ?", device, kind, since);
const countNet = (env, net, kind, since) =>
  count(env, "SELECT COUNT(*) AS n FROM actions WHERE net = ? AND kind = ? AND ts > ?", net, kind, since);
const countGlobal = (env, kind, since) =>
  count(env, "SELECT COUNT(*) AS n FROM actions WHERE kind = ? AND ts > ?", kind, since);

async function cast(request, env) {
  if (env.RIVER_CLOSED) return json({ error: "river_closed" }, 503);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

  const device = cleanDevice(payload.device);
  if (!device) return json({ error: "bad_device" }, 400);
  const cleaned = cleanBody(payload.body);
  if (cleaned.error) return json({ error: cleaned.error }, 400);
  const body = cleaned.body;
  const source = cleanSource(payload.source);

  const now = Date.now();
  const net = await netKey(request, env, now);

  if (await countGlobal(env, "cast", now - 60000) >= GLOBAL_CAST_PER_MIN) {
    return json({ error: "river_busy" }, 503);
  }
  if (await countDevice(env, device, "cast", now - DAY) >= CAST_LIMIT) {
    return json({ error: "rate_limited" }, 429);
  }
  if (await countNet(env, net, "cast", now - DAY) >= NET_CAST_LIMIT) {
    return json({ error: "rate_limited" }, 429);
  }

  const fp = await digest(fingerprintKey(body));
  const echo = await env.DB.prepare(
    "SELECT 1 AS n FROM pebbles WHERE fp = ? AND ts > ? LIMIT 1"
  ).bind(fp, now - ECHO_WINDOW).first();
  if (echo) return json({ error: "echo" }, 409);

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pebbles (id, body, ts, device, source, fp) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, body, now, device, source, fp),
    env.DB.prepare("INSERT INTO actions (device, kind, ts, net) VALUES (?, 'cast', ?, ?)")
      .bind(device, now, net),
  ]);

  return json({ id, ts: now });
}

async function skip(request, env) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

  const device = cleanDevice(payload.device);
  const ref = typeof payload.ref === "string" ? payload.ref.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) : null;
  if (!device || !ref) return json({ error: "bad_request" }, 400);
  const source = cleanSource(payload.source);

  const now = Date.now();
  const net = await netKey(request, env, now);

  const pebble = await env.DB.prepare(
    `SELECT p.device, p.ts, (SELECT COUNT(*) FROM skips WHERE ref = p.id) AS skips
     FROM pebbles p WHERE p.id = ? AND p.hidden = 0`
  ).bind(ref).first();
  if (!pebble) return json({ error: "not_found" }, 404);
  if (pebble.device === device) return json({ error: "own_pebble" }, 403);
  // A pebble that has already sunk can't be lifted back; rows linger until the sweep.
  if (expiresAt(pebble.ts, Math.min(pebble.skips, SKIP_CAP)) <= now) return json({ error: "expired" }, 410);

  if (await countGlobal(env, "skip", now - 60000) >= GLOBAL_SKIP_PER_MIN) {
    return json({ error: "river_busy" }, 503);
  }
  const skipLimit = source === "ai" ? (Number(env.AI_SKIP_LIMIT) || AI_SKIP_LIMIT) : SKIP_LIMIT;
  if (await countDevice(env, device, "skip", now - DAY) >= skipLimit) {
    return json({ error: "rate_limited" }, 429);
  }
  if (await countNet(env, net, "skip", now - DAY) >= NET_SKIP_LIMIT) {
    return json({ error: "rate_limited" }, 429);
  }
  // A single pebble can only be lifted so many times an hour, whoever is lifting.
  if (await count(env, "SELECT COUNT(*) AS n FROM skips WHERE ref = ? AND ts > ?", ref, now - HOUR) >= PEBBLE_SKIPS_PER_HOUR) {
    return json({ error: "pebble_resting" }, 429);
  }

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO skips (ref, device, ts, net, source) VALUES (?, ?, ?, ?, ?)")
        .bind(ref, device, now, net, source),
      env.DB.prepare("INSERT INTO actions (device, kind, ts, net) VALUES (?, 'skip', ?, ?)")
        .bind(device, now, net),
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
  const newestFirst = url.searchParams.get("order") === "desc";
  const liveOnly = url.searchParams.get("live") === "1";
  const now = Date.now();

  // Pull recent pebbles with their skip counts. Expiry is computed client-side
  // from ts + skips; we bound the query generously and let physics decide.
  // Skips are capped here so no amount of lifting makes a pebble immortal.
  // live=1 applies that same expiry here for callers that don't run physics
  // (the MCP server); it scans the full page, then trims to `limit`.
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.body, p.ts, p.source, MIN(COUNT(s.ref), ?) AS skips
    FROM pebbles p
    LEFT JOIN skips s ON s.ref = p.id
    WHERE p.hidden = 0 AND p.ts > ? AND p.ts > ?
    GROUP BY p.id
    ORDER BY p.ts ${newestFirst ? "DESC" : "ASC"}
    LIMIT ?
  `).bind(SKIP_CAP, after, now - 14 * DAY, liveOnly ? 100 : limit).all();

  let pebbles = results || [];
  if (liveOnly) pebbles = pebbles.filter((p) => expiresAt(p.ts, p.skips) > now).slice(0, limit);

  return json({ pebbles, now });
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Moderation. Hide one pebble by id, or everything a device ever cast.
 * Needs `Authorization: Bearer <MOD_KEY>`; with no MOD_KEY set, the route
 * doesn't exist.
 */
async function hide(request, env) {
  if (!env.MOD_KEY) return json({ error: "not_found" }, 404);
  const auth = request.headers.get("Authorization") || "";
  if (!timingSafeEqual(auth, `Bearer ${env.MOD_KEY}`)) return json({ error: "forbidden" }, 403);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

  let res;
  if (typeof payload.id === "string" && payload.id) {
    res = await env.DB.prepare("UPDATE pebbles SET hidden = 1 WHERE id = ?").bind(payload.id.slice(0, 64)).run();
  } else if (typeof payload.device === "string" && payload.device) {
    res = await env.DB.prepare("UPDATE pebbles SET hidden = 1 WHERE device = ?").bind(payload.device.slice(0, 64)).run();
  } else {
    return json({ error: "bad_request" }, 400);
  }
  return json({ ok: true, hidden: res.meta?.changes ?? 0 });
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
      if (request.method === "POST" && pathname === "/hide") return await hide(request, env);
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
