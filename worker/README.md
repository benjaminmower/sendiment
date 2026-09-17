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

## 6. Secrets (optional but recommended)

```
openssl rand -hex 32 | wrangler secret put NET_SALT
openssl rand -hex 24 | tee ~/.sendiment-modkey | wrangler secret put MOD_KEY
```

`NET_SALT` salts the per-network rate-limit hash so it can't be reversed
into an IP. `MOD_KEY` unlocks `POST /hide`. Without it the route
doesn't exist.

If you created the database before the `net` / `fp` columns existed,
apply the migration once:

```
wrangler d1 execute sendiment --remote --file=migrations/0002_abuse_limits.sql
```

## What is enforced

The device id is chosen by the client, so on its own it limits nothing.
Every per-device limit therefore has a per-network twin, keyed on a
salted hash of the caller's IP that rotates daily and is swept after two
days. The IP itself is never stored.

| Limit | Value | Where |
|---|---|---|
| Body length | 280 characters | worker, client |
| Casts per device | 20 per 24h | worker |
| Casts per network | 60 per 24h | worker |
| Skips per device | 200 per 24h | worker |
| Skips per network | 600 per 24h | worker |
| Skips per pebble | 30 per hour | worker |
| Skips that count | capped at 40 (≈12-day max life) | worker |
| Global casts | 60 per minute | worker |
| Global skips | 600 per minute | worker |
| Same thought twice | refused within 24h (normalised fingerprint) | worker |
| Links, @handles, phone numbers | refused | worker |
| Shouting | lowered to lowercase | worker |
| Keyboard mashing | refused | worker |
| One skip per pebble per device | primary key | D1 |
| Self-skip | blocked | worker |
| Blocklist | obfuscation-tolerant regex list in `worker.js` | worker |

None of it is a security boundary against a determined attacker. It is a
speed bump sized for an art project, and the shape the Hedera fee model
replaces later.

## Moderation

Hide a pebble, or everything a device has cast:

```
KEY=$(cat ~/.sendiment-modkey)
curl -X POST https://sendiment.<sub>.workers.dev/hide \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"id":"<pebble id>"}'
curl -X POST https://sendiment.<sub>.workers.dev/hide \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"device":"<device id>"}'
```

Find ids with `wrangler d1 execute sendiment --remote --command
"SELECT id, device, body FROM pebbles WHERE hidden = 0 ORDER BY ts DESC LIMIT 50"`.

Close the river to new casts without touching code:

```
echo 1 | wrangler secret put RIVER_CLOSED     # close
wrangler secret delete RIVER_CLOSED           # reopen
```

Skipping and reading keep working while closed.

## Housekeeping

`wrangler.toml` registers a daily cron that prunes rate-limit rows and
anything older than any possible lifespan. Delete the `[triggers]` block
if you would rather keep every pebble ever cast.

## Moving to Hedera later

`pebbles` and `skips` are timestamped, ordered, append-only records. To
migrate, replay them into an HCS topic in `ts` order and switch the client
to read from a mirror node. The physics module does not change, and the
river's history survives the move.
