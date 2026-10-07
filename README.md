# Asterism · Smart Wallet Alerts

Solana smart-money alerts that only fire **when strong wallets agree**.

Asterism watches every wallet GMGN labels as smart money or KOL, throws out the bots, ranks the rest by
how their buys actually performed, and sends a Telegram alert when several high-ranked wallets buy the
same token within 30 minutes. A public dashboard shows the same data with a 15-minute delay.

- **Dashboard:** https://solasterism.xyz (mirror: https://asterism-pi.vercel.app)
- **Telegram bot:** [@solasterismbot](https://t.me/solasterismbot)
- **X:** [@useAsterism](https://x.com/useAsterism)
- **Public API:** https://solasterism.xyz/api/public/summary

Read-only by design: no wallet keys, no signing, no swaps. Not investment advice.

## How it works

```
GMGN feeds ──► collector ──► trades ─┬─► signals ──► Telegram
(smartmoney 12–30 s, kol 60 s)       │      ▲
                                     │      │ tiers A/B/C
GMGN trending + top traders ──► discovery ──► wallets ──► scorer ◄── buy outcomes (klines)
                                     │
                                     └─► public API (−15 min) ──► Asterism dashboard
```

| module | what it does | when |
|---|---|---|
| `collector` | Polls the smartmoney and KOL feeds, normalises multi-hop swaps, stores trades idempotently, detects gaps between polls and adapts the interval to the feed's turnover | 12–30 s / 60 s |
| `discovery` | Finds winner tokens (≤ 30 days old, ATH ≥ $1M), scans their top traders and keeps early profitable buyers (entry ≤ 10% of ATH) and GMGN-tagged smart money / KOLs that made ≥ $1k; backfills the history of the strongest ones | hourly |
| `scorer` | Excludes bots by tag and behaviour, computes metrics and assigns tiers A (top 15%), B (next 25%), C | every 6 h |
| `outcomes` | Price 1 h / 24 h after each tracked buy and the 24 h max, one kline call per token, for `hit_rate_2x_24h` | every 15 min |
| `signals` | Cluster, cluster + KOL, A-wallet first entry and exit cluster; risk filters; anti-spam that edits the alert when a cluster grows | every new batch of trades |
| `tracker` | Signal results at 15 m / 1 h / 4 h / 24 h, 24 h max and min; `/stats` and a daily summary | every 5 min |
| `retention` | Drops old noise trades, route legs and data older than 30 days | daily |
| `http` | Dashboard, `/api/public/*` (delayed), `/health`, `/api/stats` (local only) | — |

### Ranking

```
score = 0.45·hit + 0.25·rank(pnl_30d) + 0.20·winrate + 0.10·freshness
```

- `hit` is the share of a wallet's buys that reached 2× within 24 h (needs ≥ 10 resolved buys). Until
  that exists, discovery evidence (early entries into winners) stands in for it.
- Missing components are dropped and the remaining weights renormalised.
- Wallets seen in the live feeds and discovery-only wallets are ranked as two cohorts: only feed wallets
  can form a live cluster today, and discovery evidence would otherwise take every A/B slot.
- Excluded: tags `wash_trader`, `arbitrager` (except for KOLs, where GMGN sets it on almost every
  wallet), `dex_bot`, `bundler`, `rat_trader`, `sandwich_bot`, lone `sniper`; more than 300 trades a day;
  median hold under 60 s. Inactive for 14 days → one tier down. KOLs dumping ≥ 30% of buys within an
  hour → at most C.

### Signals

| type | condition | strength |
|---|---|---|
| `cluster` | ≥ 3 distinct A/B wallets buy ≥ $300 of one token within 30 min | strong; ≥ 5 very strong |
| `cluster_kol` | cluster + a non-dumping KOL (tier ≥ C) in the same window | very strong |
| `a_first_entry` | an A wallet buys a token for the first time, ≥ $1,000 | medium |
| `exit_cluster` | ≥ 3 A/B wallets fully exit a token that had a signal in the last 48 h | warning |

Filters (GMGN token info + security, cached 5 min): market cap $30k–$20M, liquidity ≥ $15k, age ≥ 10 min,
mint and freeze authority renounced, bundler share ≤ 30%. The same signal type for a token is sent at
most once per hour; a growing cluster edits the original message.

## GMGN: what we learned

The full field reference with raw samples is in [`docs/gmgn-fields.md`](docs/gmgn-fields.md) and
[`fixtures/`](fixtures). The traps that shaped the code:

- The plan allows roughly **10 weight units per minute**, not per second. One leaky bucket with
  priorities guards every call; background work leaves headroom for the feeds; expensive routes
  (`wallet_activity`, `wallet_profits`, `token_top_traders`, `market/rank`, klines) get their own spacing,
  and a 429 pauses everything until `reset_at`.
- The smartmoney feed turns over 100 trades in as little as 13–25 s, so peak hours can still leave gaps.
- `is_open_or_close` is `1` for a full open or close and `0` for a partial add or reduce (confirmed on
  thousands of trades; the original spec had it backwards).
- Multi-hop swaps produce two records per transaction (`SOL → cbBTC → meme`); known route tokens are
  always route legs, others are learned from the data.
- `portfolio stats` ignores all but the first wallet of a batch; `portfolio profits` batches correctly.
- `market kline` returns at most 100 candles; `token security` has no `rug_ratio`; `market/rank` nests its
  payload one level deeper (`data.data.rank`); GMGN answers over IPv4 only.

## Telegram bot

`/start` subscribes the chat, `/stop` unsubscribes. `/stats` — signal results for 7 days. `/top` — top 20
A wallets. `/wallet <address>` — tier and metrics. `/token <CA>` — which base wallets traded it in 24 h.
`/mute <CA> [hours]`. Alerts go only to chats that subscribed.

## Dashboard

Static HTML/CSS/JS in [`web/`](web), no build step. A live sky where every star is a real wallet, a
delayed trade tape replayed at its real pace, a scroll story of the method, a 24 h activity chart, the
signal log with outcomes, and the wallet directory with full addresses. Every trade links to Solscan.

## Run

```bash
npm install
npm run build
npm test                  # 40 tests: parsing, dedup, gaps, limiter, discovery, signals, scoring, retention
npm start                 # collector + discovery + scorer + signals + bot + HTTP on 127.0.0.1:$PORT
```

| command | |
|---|---|
| `npm run stats -- 1` | collector report for the last N hours |
| `npm run score` | recompute tiers offline from stored data (no GMGN calls) |
| `npm run report:wallets` | tier distribution, top 20 A wallets, exclusion reasons |
| `./deploy.sh` | build, test and deploy to the VPS (keeps the server `.env` and database) |
| `npm run deploy:vercel` | deploy the dashboard to Vercel, proxying `/api` to the VPS |
| `npm run deploy:vercel:snapshot` | deploy the dashboard with a static data snapshot instead |

Environment (see [`.env.example`](.env.example)): `GMGN_API_KEY` (falls back to `~/.config/gmgn/.env`),
`TELEGRAM_BOT_TOKEN`, thresholds (`CLUSTER_MIN_WALLETS`, `MIN_BUY_USD`, `MC_MIN`, `LIQ_MIN`, …),
`PUBLIC_DELAY_MIN`, `PORT`, `DATA_DIR`. `COLLECTOR=0` runs the HTTP side only.

## Layout

```
src/
  gmgn/         client.ts (the only GMGN caller), limiter.ts, types.ts
  collector/    feed polling, normalisation, storage
  discovery/    winner tokens and early buyers
  scorer/       metrics, tiers, buy outcomes
  signals/      engine, risk filters, alert format, outcome tracker
  telegram.ts   bot API client     bot.ts  commands
  public.ts     dashboard API      retention.ts  clean-up
web/            dashboard
deploy/         systemd unit, nginx template
docs/           GMGN field reference
fixtures/       raw GMGN responses used by the tests
```

## Status

Live on a VPS since 2026-10-06. Tiers are interim until enough 24-hour buy outcomes exist for `hit`.
Next: own on-chain listener (Helius / Yellowstone) for discovery wallets that never appear in GMGN feeds.
