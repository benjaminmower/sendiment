-- Abuse limits that don't depend on a client-chosen device id.
--
-- actions.net  : a salted, daily-rotating hash of the caller's IP. Never
--                the IP itself. Lets the river throttle a whole network
--                that mints fresh device ids. Swept after 2 days.
-- pebbles.fp   : a fingerprint of the normalised body, so an identical
--                thought can't be cast twice in a day (copy-paste floods).
--
-- Apply with:  wrangler d1 execute sendiment --remote --file=migrations/0002_abuse_limits.sql
ALTER TABLE actions ADD COLUMN net TEXT;
ALTER TABLE pebbles ADD COLUMN fp TEXT;

CREATE INDEX IF NOT EXISTS actions_net ON actions (net, kind, ts);
CREATE INDEX IF NOT EXISTS actions_kind_ts ON actions (kind, ts);
CREATE INDEX IF NOT EXISTS pebbles_fp ON pebbles (fp, ts);
