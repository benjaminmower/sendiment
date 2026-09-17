/**
 * Sendiment physics. One definition of the rules, imported by the client.
 * Keep this pure — no clock reads, no I/O. Everything takes explicit inputs.
 *
 * PHYSICS VERSION: 1
 * Bump this (and say so in the commit) if the constants change. Stones, when
 * they exist, record the version they petrified under.
 */

export const PHYSICS_VERSION = 1;

export const DAY = 86400000;

/**
 * How long a pebble stays on the surface, in ms.
 * Base 24h; skip N extends by 24h / sqrt(N). Sublinear on purpose:
 * early skips matter a lot, mass skipping buys less and less.
 */
export function lifespanMs(skips) {
  let total = DAY;
  for (let n = 1; n <= skips; n++) total += DAY / Math.sqrt(n);
  return total;
}

/** When a pebble sinks, given when it was cast and how often it was skipped. */
export function expiresAt(ts, skips) {
  return ts + lifespanMs(skips);
}

/** Render scale. Logarithmic — a pebble grows, but never dominates. */
export function sizeOf(skips) {
  return 1 + 0.35 * Math.log(1 + skips);
}

/** Fall speed in px/s. Bigger pebbles fall slower, so they are seen longer. */
export function speedOf(skips, base = 42) {
  return base / sizeOf(skips);
}
