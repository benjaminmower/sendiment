-- Record which network (salted daily hash, never the IP) each skip came
-- from. Because the hash rotates daily, COUNT(DISTINCT net) on a pebble
-- measures how many distinct network-days lifted it: wide and lasting
-- in one number. Stones, when they exist, will petrify on this.
--
-- Apply with:  wrangler d1 execute sendiment --remote --file=migrations/0003_skip_net.sql
ALTER TABLE skips ADD COLUMN net TEXT;
