# Smart Wallet Alerts · Asterism

Collects Solana "smart" wallets from GMGN feeds, scores them itself, sends Telegram alerts when strong wallets cluster
into one token, and shows it all on the public **Asterism** dashboard (with a 15-minute delay).

Read-only: no wallet keys, no signing, no swaps.

## Run

```bash
npm install
npm run build
npm start              # collector + HTTP on 127.0.0.1:$PORT (site and /api/public/*)
npm test
npm run stats -- 1     # collector report for the last N hours
```

`COLLECTOR=0` runs the HTTP side only (preview the site next to a live collector); `PUBLIC_DELAY_MIN=0` removes the delay for local layout work.

## Layout

- `src/gmgn/client.ts` — the only place that talks to GMGN (HTTP to `openapi.gmgn.ai`): one weighted leaky bucket with priorities, full pause until `reset_at` on 429.
- `src/collector/` — polls the smartmoney/kol feeds with an adaptive interval, normalizes multi-hop swaps, detects gaps (`poll_log`).
- `src/public.ts` — dashboard data, cut at `now − PUBLIC_DELAY_MIN`.
- `web/` — the Asterism site (static HTML/CSS/JS, no build step).
- `docs/gmgn-fields.md` — real GMGN fields and pitfalls; `fixtures/` — raw responses.

## HTTP

| path | what |
|---|---|
| `/health` | `{ ok: true }` |
| `/api/stats?window=3600` | collector and limiter stats (local only on the server) |
| `/api/public/summary`, `/sky`, `/signals`, `/wallets` | dashboard data, delayed |
