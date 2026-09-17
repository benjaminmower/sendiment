# sendiment

cast your thoughts into the river of consciousness

A single text box. Type a thought, cast it in, and watch it sink — yours
and everyone else's, drifting down the same shared river. Thoughts fade
and disappear on their own; skipping one (clicking it) buys it a little
more time before it goes under.

The client (`index.html` + `physics.js`) works standalone as a private,
local-only demo. Point it at the small Cloudflare Worker in `worker/` and
it becomes a shared river everyone casts into together — see
[`worker/README.md`](worker/README.md) for the full deploy guide.

## Running locally

```
npx serve .
```

Open the printed URL. `index.html` uses an ES module import, so it needs
a real HTTP server — opening the file directly (`file://`) won't work.

## Files

- `index.html` — the client: layout, animation loop, cast/skip UI
- `physics.js` — pure functions for pebble lifespan, size, and fall speed
- `worker/` — the optional Cloudflare Worker + D1 schema for a shared backend
