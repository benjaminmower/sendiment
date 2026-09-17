# Deploying the river

The client on GitHub Pages is static. One small Cloudflare Worker plus a D1
database turns everyone's private demo water into a single shared river.
Free tier throughout: 100,000 requests/day, 5 GB of D1 storage.

## 1. Install and sign in

```
npm install -g wrangler
wrangler login
```

## 2. Create the database

```
cd worker
wrangler d1 create sendiment
```

It prints a `database_id`. Paste it into `wrangler.toml`, replacing
`PASTE_DATABASE_ID_HERE`.

## 3. Create the tables

```
wrangler d1 execute sendiment --remote --file=schema.sql
```

## 4. Deploy

```
wrangler deploy
```

You get a URL like `https://sendiment.<your-subdomain>.workers.dev`.
Check it:

```
curl https://sendiment.<your-subdomain>.workers.dev/healthz
```

## 5. Point the client at it

In `index.html`, set:

```js
const API = 'https://sendiment.<your-subdomain>.workers.dev';
```

Commit and push. GitHub Pages redeploys, and every visitor now casts into
the same water. Leaving `API` empty runs the local demo instead — useful
for showing the piece with no backend at all.

## Local development

```
cd worker
wrangler dev
```

Serves the worker at `http://localhost:8787`. Point `API` there and open
`index.html` with any static server (`npx serve .` from the repo root) —
opening the file directly with `file://` will fail, because the client
uses an ES module import.

## What is enforced

| Limit | Value | Where |
|---|---|---|
| Body length | 280 characters | worker, client |
| Casts per device | 20 per 24h | worker |
| Skips per device | 200 per 24h | worker |
| Global casts | 60 per minute | worker |
| One skip per pebble per device | primary key | D1 |
| Self-skip | blocked | worker |
| Blocklist | small regex list in `worker.js` | worker |

None of it is a security boundary against a determined attacker. It is a
speed bump sized for an art project, and the shape the Hedera fee model
replaces later.

## Housekeeping

`wrangler.toml` registers a daily cron that prunes rate-limit rows and
anything older than any possible lifespan. Delete the `[triggers]` block
if you would rather keep every pebble ever cast.

## Moving to Hedera later

`pebbles` and `skips` are timestamped, ordered, append-only records. To
migrate, replay them into an HCS topic in `ts` order and switch the client
to read from a mirror node. The physics module does not change, and the
river's history survives the move.
