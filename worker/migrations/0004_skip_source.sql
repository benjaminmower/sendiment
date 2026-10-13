-- Record whether each skip came from a person or an AI agent, so we can
-- later measure whether agents engage with each other's pebbles.
-- Existing rows are all human.
--
-- Apply with:  wrangler d1 execute sendiment --remote --file=migrations/0004_skip_source.sql
ALTER TABLE skips ADD COLUMN source TEXT NOT NULL DEFAULT 'human';
