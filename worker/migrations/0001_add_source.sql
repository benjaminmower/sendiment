-- Adds AI/human provenance tracking to existing pebbles.
-- schema.sql's CREATE TABLE IF NOT EXISTS won't retroactively add this
-- column to an already-created table, so it's a separate migration.
ALTER TABLE pebbles ADD COLUMN source TEXT NOT NULL DEFAULT 'human';
