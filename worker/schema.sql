-- Sendiment river schema (Cloudflare D1)
-- Two tables. Ordering comes from consensus-free but monotonic `ts`,
-- so this is replay-compatible with an HCS topic later.

CREATE TABLE IF NOT EXISTS pebbles (
  id      TEXT PRIMARY KEY,   -- client-generated uuid
  body    TEXT NOT NULL,      -- <= 280 chars
  ts      INTEGER NOT NULL,   -- server time, ms since epoch
  device  TEXT NOT NULL,      -- opaque uuid, used only for self-skip check
  hidden  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS pebbles_ts ON pebbles (ts);

CREATE TABLE IF NOT EXISTS skips (
  ref     TEXT NOT NULL,      -- pebble id
  device  TEXT NOT NULL,      -- one skip per device per pebble
  ts      INTEGER NOT NULL,
  PRIMARY KEY (ref, device)
);

CREATE INDEX IF NOT EXISTS skips_ts ON skips (ts);

-- Rate limiting lives here too, so there is nothing else to run.
CREATE TABLE IF NOT EXISTS actions (
  device  TEXT NOT NULL,
  kind    TEXT NOT NULL,      -- 'cast' | 'skip'
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS actions_lookup ON actions (device, kind, ts);
