# GMGN: actual response fields (Solana)

Captured 2026-10-06 with `gmgn-cli` 1.6.6. Sample responses are in `fixtures/`.
Everything below was verified against raw responses. If a field is not described here, we do not guess its meaning.

## Transport

- The CLI is a thin wrapper over `https://openapi.gmgn.ai`. Regular routes (track kol/smartmoney, token, market, portfolio):
  `X-APIKEY` header, with `timestamp` (unix sec, the server allows ±5 s) and `client_id` (UUID, a repeat within 7 s is rejected) in the query.
- On `429` the server returns an `x-ratelimit-reset` header (unix sec) and the body `{code:429, error:"RATE_LIMIT_EXCEEDED"|"RATE_LIMIT_BANNED", message, reset_at}`.
- `--raw` prints a single line of JSON, which is the `data` of the API response (for `market trending` the wrapper `{code,data:{rank},message,reason}` is kept).

## Limits: they differ from the skill

The skill says "rate=10, capacity=10", i.e. ~10 weight units per second. In practice:

- The sequence trending(1) → info(1) → security(1) → traders(5) → traders(5), run in ~3 s,
  got `429 RATE_LIMIT_EXCEEDED` on the second `traders`, and the next `kline` (about 1 s later) got `RATE_LIMIT_BANNED` for ~35 s.
- So the capacity really is ~10, but the refill is slower than stated, and a request made at the moment of a 429 extends the ban.
- Conclusion for the client: use our own leaky bucket with a conservative rate (initially 1 unit/s, capacity 8) and **stop all requests completely
  until `reset_at`** after any 429. We measure the exact refill rate in stage 1 from the client logs.

## `track smartmoney` / `track kol`

Response: `{ list: Trade[] }`, sorted by `timestamp` descending. `--limit 100` → exactly 100 records.

| field | meaning (verified) |
|---|---|
| `transaction_hash` | transaction hash. **Not unique in the feed**: a multi-hop swap yields 2 records for one transaction (31 of 100 in smartmoney) |
| `maker` | wallet |
| `side` | `buy` / `sell` |
| `base_address`, `base_token.{symbol,logo,total_supply,launchpad}` | the token of this record (`launchpad` = `pump`, `""`, …) |
| `amount_usd` | trade amount, USD (= `quote_amount` for USD pairs) |
| `token_amount` = `base_amount` | token quantity |
| `price_usd` (= `price`) | token price in USD at the time of the trade |
| `buy_cost_usd` | for `sell`, the cost basis of the sold part; for `buy`, `0` |
| `is_open_or_close` | see below |
| `timestamp` | unix sec |
| `balance` | always `0` in the sample, so we do not use it |
| `maker_info.{tags,twitter_username,twitter_name,name,avatar}` | the wallet's tags and X account |

The fields `price_now` and `price_change` are **not present** in these feeds (they exist only in `follow-wallet`).

### `is_open_or_close`: the spec's description is wrong

The spec says: "0 is open/add, 1 is close/reduce". The data contains `buy` with `1` (22 of 73 smartmoney buys, 12 of 76 for KOL),
and every such record has `buy_cost_usd = 0`. Distribution: `buy:0 51, buy:1 22, sell:0 14, sell:1 13`.
Working interpretation (as in `follow-wallet`): **`1` = full event**: opening a new position (`buy`) or a full exit (`sell`);
**`0` = partial**: adding to a position or a partial sale. Direction is taken only from `side`.
**Confirmed 2026-10-06 on ~2000 collector trades:**
- a wallet's first observed buy of a token is `1` in 78% of cases, the last sell is `1` in 76%;
- of 172 repeat buys with `1`, 158 (92%) were preceded by a full exit `sell:1`, i.e. a position re-opening;
  for repeat buys with `0` this happens in only 16 of 230 cases.

### Multi-hop and "intermediate" tokens

A single `SOL → cbBTC → SIRIUS` transaction yields two records, `buy SIRIUS` and `buy cbBTC`, with the same amount.
There are also pairs where the quote token is itself a memecoin (`PUP/PUMP`, `Trannie/DJT`).
Normalization rule: within one `(tx, maker)`, drop the leg with the "routing" token
(a static list: WSOL, USDC, USDT, USD1, cbBTC, …, plus tokens that often appear as the second leg across different pairs, computed from accumulated data).

### Feed coverage

| feed | 2026-10-02 (spec) | 2026-10-06 00:24 MSK |
|---|---|---|
| smartmoney, 100 trades | ~2 min, 39 wallets | **25 s**, 40 wallets, 21 tokens |
| kol, 100 trades | ~9 min, 15 wallets | ~4 min, 16 wallets, 25 tokens |

Polling smartmoney every 25 s **is guaranteed to miss trades** at peak hours. An adaptive interval (8–30 s) based on actual coverage is needed.

### Quality of GMGN lists

- smartmoney: the `arbitrager` tag on 57 of 100 trades; bot groups: 5 wallets bought SIRIUS within the same second, $44–53 each.
- kol: `wash_trader` on 65 of 100 trades, `arbitrager` on 94.
- So the `smart_degen`/`kol` tag alone guarantees nothing; the filter and ranking are our own.

## `market trending`

`{ code, data: { rank: Item[] } }`. 100 items. The full field list is in the fixture; the key ones:
`address, symbol, market_cap, liquidity, history_highest_market_cap, creation_timestamp, open_timestamp, launchpad_platform,
rug_ratio, is_wash_trading, bundler_rate, smart_degen_count, renowned_count, renounced_mint, renounced_freeze_account`.

- `--interval 24h --order-by history_highest_market_cap`: 65 of 100 tokens are younger than 30 days with ATH ≥ $1M.
- **Anomalous ATH**: `DOTF` has an ATH of $1.1B at a current market cap of $5.4k. Discovery needs an ATH check
  (for example, ATH ≤ 200× the current cap and confirmation from 1h candles).

## `token info`

Key fields (verified): `price` is an **object**, not a number: `{price, price_1m, price_5m, price_1h, price_6h, price_24h,
buys_*, sells_*, volume_*, buy_volume_*, sell_volume_*, swaps_*}`, with all prices and volumes as strings.
`circulating_supply`, `total_supply`, `liquidity` (USD, number), `creation_timestamp`, `open_timestamp`, `migrated_timestamp`,
`ath_price`, `launchpad`, `launchpad_platform`, `launchpad_status`, `holder_count`,
`stat.{top_10_holder_rate, top_bundler_trader_percentage, top_rat_trader_percentage, top_entrapment_trader_percentage, bot_degen_rate, fresh_wallet_rate, dev_team_hold_rate, creator_hold_rate}` (strings 0–1),
`wallet_tags_stat.{smart_wallets, renowned_wallets, sniper_wallets, bundler_wallets, rat_trader_wallets, fresh_wallets, whale_wallets}`.

- Market cap = `Number(price.price) × circulating_supply`.
- `ath_price × total_supply` ≈ `history_highest_market_cap` from trending (30.8M vs 31.0M), so ATH can be taken from `token info`.

## `token security`

`renounced_mint`, `renounced_freeze_account` are boolean. `burn_status` (`"burn"`), `burn_ratio`, `top_10_holder_rate` (string),
`buy_tax`/`sell_tax` (strings), `lock_summary`.
**The response for this token has no `rug_ratio`, `is_wash_trading`, `bundler_trader_amount_rate`**, contrary to the skill.
Sources for signal filters:
- `rug_ratio`, `is_wash_trading`, `bundler_rate` are in `market trending`/`trenches` (may be absent for tokens outside the trending lists);
- bundler share: `token info → stat.top_bundler_trader_percentage`.

## `token traders`

`{ list: Trader[] }`, up to 100. Fields match the skill. Useful for discovery:
- `avg_cost` (USD per token), `history_bought_cost`, `profit`, `realized_profit`, `unrealized_profit`, `start_holding_at`, `buy_tx_count_cur`.
- `tags` (platform-level: `fomo`, `fresh_wallet`, `sandwich_bot`, `axiom`, …) and `maker_token_tags` (per token: `bundler`, `whale`, `transfer_in`, `diamond_hands`, `paper_hands`).
- **Early entry without extra requests**: `avg_cost × circulating_supply / ATH`. If the average entry price is ≤ 10% of ATH,
  then at least one buy was ≤ 10% of ATH. On the Agency token, 69 of 100 profitable traders pass this
  before filters (`sandwich_bot`, `bundler`, `transfer_in`, anomalous `start_holding_at`).
  `portfolio activity --token` is needed only for borderline cases.

## `market kline`

`{ list: Candle[] }`, ascending by `time` (ms). Fields: `time, open, high, low, close, volume (USD), amount (tokens), source`, with numbers as strings.
**Returns at most 100 candles**: a 24 h request at 5m returned the last 8 h 20 min.
Consequence for `outcomes`: take the 24 h maximum in one request at **15m** resolution (96 candles); `high` still catches the peak.
The price after 1 h is the `close` of the candle containing `buy_ts + 3600`.

## `portfolio stats`: batch does not work

The CLI passes wallets as a repeated query parameter `wallet_address`, but the server returns **a single object for the first wallet only**.
Conclusion: `stats` is called one wallet at a time (weight 3). Fields (all amounts are strings):

| field | meaning |
|---|---|
| `realized_profit` | realized profit for the period, USD |
| `realized_profit_pnl` | return on realized profit (`realized_profit / cost`); there is no `pnl` field |
| `buy`, `sell` | number of buys/sells in the period |
| `bought_cost`, `sold_income`, `total_cost`, `bought_fee`, `sold_fee` | turnover, USD |
| `last_timestamp` | time of last activity |
| `pnl_stat.winrate` | share of profitable tokens (there is no top-level `winrate`) |
| `pnl_stat.token_num` | number of tokens in the period |
| `pnl_stat.pnl_lt_nd5_num / pnl_nd5_0x_num / pnl_0x_2x_num / pnl_2x_5x_num / pnl_gt_5x_num` | distribution of tokens by return: < −50%, −50…0%, 0…+100%, 2–5×, > 5× |
| `pnl_stat.avg_holding_period` | average holding period, sec |
| `common.tags`, `common.twitter_username`, `common.twitter_fans_num`, `common.created_at` | profile |
| `common.fund_from_address`, `common.fund_amount`, `common.fund_from_ts` | **who funded the wallet**, for linking sybils |

`unrealized_profit` is not in `stats`; it is in `profits`.

## `portfolio profits`: batch works (POST `/v1/user/wallet_profits`)

`{ list: [...] }`, one record per wallet (verified with 5). Periods `1d / 7d / 30d / all`. Fields (strings):
`wallet_address, realized_profit, realized_profit_cost, unrealized_profit, unrealized_profit_cost, total_realized_profit,
total_realized_profit_cost, total_profit, total_cost, buy, sell`. No winrate.

In total for metrics: `pnl_7d/pnl_30d` come as a batch via `profits` (up to 100 wallets, one request);
`winrate_30d`, the return distribution and the funder come via `stats` one wallet at a time, for candidates only.

## `portfolio activity`

`{ activities: Activity[], next }`, 50 records per page, newest first. Fields: `wallet, tx_hash, timestamp, event_type (buy/sell/…),
token.{address,symbol,total_supply}, token_amount, quote_amount, cost_usd, buy_cost_usd, price_usd, is_open_or_close,
quote_address, quote_token, gas_usd, dex_usd, priority_fee, tip_fee, launchpad, launchpad_platform`.
For a wallet with 150 trades in a token, the first buy is on page 3, which is expensive (weight 3 × pages). Use rarely.

## Quality observations (sample of 5 "smartmoney" wallets without the arbitrager tag)

| wallet | buys in 30 d | winrate | return | conclusion |
|---|---|---|---|---|
| AJcX…M4gs | 3 193 | 45% | +1.3% on $470k turnover | arbitrage/market making |
| 72NW…     | 34 981 | — | +0.7% on $7.2M | bot |
| 8hSh…     | 9 004 | — | +1% on $3.5M | bot |

The spec's "> 300 trades per day" filter would cut these out, but metrics must be computed from `buy` in `stats`, not only from our own records.

## Later findings (2026-10-06, production)

- **Rate limit is about 10 weight units per minute**, not per second. Every 429 so far followed ~11 units
  inside a minute. A fresh process cannot see what the previous one spent, so the client starts with a
  full bucket.
- **Expensive routes look limited on their own.** `wallet_activity`, `wallet_profits` and `market/rank`
  drew 429s while the shared budget was well under the limit. The client keeps a minimum gap per route
  (20 s / 20 s / 15 s, plus 10 s for `token_top_traders` and 5 s for klines) and doubles it after a 429 on
  that route. A 429 on a background route no longer slows the feeds.
- **Any 429 bans the whole IP briefly** (`RATE_LIMIT_BANNED`, 30–36 s): requests from other routes during
  that window fail too and extend the ban.
- **`market/rank` nests its payload**: `json.data.data.rank` (the CLI prints `json.data`, which hides it).
- **Successful responses carry no rate-limit headers**; only 429 bodies have `reset_at`.
- **Known route tokens are route legs even as single trades** (a lone WSOL "buy" is never a signal).
