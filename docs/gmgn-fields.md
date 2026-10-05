# GMGN: реальные поля ответов (Solana)

Снято 2026-10-06 с `gmgn-cli` 1.6.6. Образцы ответов лежат в `fixtures/`.
Всё, что ниже, проверено на сырых ответах. Если поле не описано здесь, его смысл не угадываем.

## Транспорт

- CLI — тонкая обёртка над `https://openapi.gmgn.ai`. Обычные маршруты (track kol/smartmoney, token, market, portfolio):
  заголовок `X-APIKEY`, в query `timestamp` (unix сек, сервер допускает ±5 с) и `client_id` (UUID, повтор в течение 7 с отклоняется).
- При `429` сервер отдаёт заголовок `x-ratelimit-reset` (unix сек) и тело `{code:429, error:"RATE_LIMIT_EXCEEDED"|"RATE_LIMIT_BANNED", message, reset_at}`.
- `--raw` печатает одну строку JSON — это `data` из ответа API (у `market trending` обёртка `{code,data:{rank},message,reason}` сохраняется).

## Лимиты — расходятся со скиллом

Скилл говорит «rate=10, capacity=10», то есть ~10 единиц веса в секунду. На деле:

- Последовательность trending(1) → info(1) → security(1) → traders(5) → traders(5), выполненная за ~3 с,
  получила `429 RATE_LIMIT_EXCEEDED` на втором `traders`, а следующий `kline` (через ~1 с) — уже `RATE_LIMIT_BANNED` на ~35 с.
- Значит, ёмкость действительно ~10, но пополнение медленнее заявленного, а запрос в момент 429 продлевает бан.
- Вывод для клиента: свой leaky bucket с консервативной скоростью (стартово 1 ед./с, ёмкость 8) и **полная остановка всех запросов
  до `reset_at`** после любого 429. Точную скорость пополнения меряем в этапе 1 по логам клиента.

## `track smartmoney` / `track kol`

Ответ: `{ list: Trade[] }`, отсортирован по `timestamp` по убыванию. `--limit 100` → ровно 100 записей.

| поле | смысл (проверено) |
|---|---|
| `transaction_hash` | хэш транзакции. **Не уникален в ленте**: мульти-хоп свап даёт 2 записи на одну транзакцию (31 из 100 в smartmoney) |
| `maker` | кошелёк |
| `side` | `buy` / `sell` |
| `base_address`, `base_token.{symbol,logo,total_supply,launchpad}` | токен этой записи (`launchpad` = `pump`, `""`, …) |
| `amount_usd` | сумма сделки, USD (= `quote_amount` у пар к USD) |
| `token_amount` = `base_amount` | количество токенов |
| `price_usd` (= `price`) | цена токена в USD на момент сделки |
| `buy_cost_usd` | у `sell` — себестоимость проданной части; у `buy` — `0` |
| `is_open_or_close` | см. ниже |
| `timestamp` | unix сек |
| `balance` | всегда `0` в выборке — не используем |
| `maker_info.{tags,twitter_username,twitter_name,name,avatar}` | теги и X-аккаунт кошелька |

Полей `price_now` и `price_change` в этих лентах **нет** (они есть только у `follow-wallet`).

### `is_open_or_close` — описание в ТЗ неверно

В ТЗ: «0 — открытие/добавление, 1 — закрытие/сокращение». В данных встречается `buy` c `1` (22 из 73 покупок smartmoney, 12 из 76 у KOL),
и у всех таких записей `buy_cost_usd = 0`. Распределение: `buy:0 51, buy:1 22, sell:0 14, sell:1 13`.
Рабочая трактовка (как у `follow-wallet`): **`1` = полное событие** — открытие новой позиции (`buy`) или полный выход (`sell`);
**`0` = частичное** — докупка или частичная продажа. Направление берём только из `side`.
Проверим на часе данных в этапе 1 (первая покупка кошелька в токене должна быть `buy:1`).

### Мульти-хоп и «промежуточные» токены

Одна транзакция `SOL → cbBTC → SIRIUS` даёт две записи `buy SIRIUS` и `buy cbBTC` с одинаковой суммой.
Также встречаются пары, где котировочный токен — сам мемкоин (`PUP/PUMP`, `Trannie/DJT`).
Правило нормализации: внутри одной `(tx, maker)` отбрасываем ногу с «маршрутным» токеном
(статический список: WSOL, USDC, USDT, USD1, cbBTC, …, плюс токены, которые часто встречаются второй ногой у разных пар — считается по накопленным данным).

### Покрытие ленты

| лента | 2026-10-02 (ТЗ) | 2026-10-06 00:24 МСК |
|---|---|---|
| smartmoney, 100 сделок | ~2 мин, 39 кошельков | **25 с**, 40 кошельков, 21 токен |
| kol, 100 сделок | ~9 мин, 15 кошельков | ~4 мин, 16 кошельков, 25 токенов |

Опрос smartmoney раз в 25 с **гарантированно даёт пропуски** в пиковые часы. Нужен адаптивный интервал (8–30 с) по фактическому покрытию.

### Качество списков GMGN

- smartmoney: тег `arbitrager` у 57 из 100 сделок; бот-группы — 5 кошельков купили SIRIUS в одну секунду на $44–53 каждый.
- kol: `wash_trader` у 65 из 100 сделок, `arbitrager` у 94.
- Значит, тег `smart_degen`/`kol` сам по себе ничего не гарантирует; фильтр и рейтинг — свои.

## `market trending`

`{ code, data: { rank: Item[] } }`. 100 элементов. Полный список полей — в фикстуре; ключевые:
`address, symbol, market_cap, liquidity, history_highest_market_cap, creation_timestamp, open_timestamp, launchpad_platform,
rug_ratio, is_wash_trading, bundler_rate, smart_degen_count, renowned_count, renounced_mint, renounced_freeze_account`.

- `--interval 24h --order-by history_highest_market_cap`: 65 из 100 токенов моложе 30 дней с ATH ≥ $1M.
- **Аномальные ATH**: `DOTF` — ATH $1.1B при текущей капитализации $5.4k. Для discovery нужна проверка ATH
  (например, ATH ≤ 200× текущей капы и подтверждение по свечам 1h).

## `token info`

Ключевые поля (проверено): `price` — **объект**, а не число: `{price, price_1m, price_5m, price_1h, price_6h, price_24h,
buys_*, sells_*, volume_*, buy_volume_*, sell_volume_*, swaps_*}` — все цены и объёмы строками.
`circulating_supply`, `total_supply`, `liquidity` (USD, число), `creation_timestamp`, `open_timestamp`, `migrated_timestamp`,
`ath_price`, `launchpad`, `launchpad_platform`, `launchpad_status`, `holder_count`,
`stat.{top_10_holder_rate, top_bundler_trader_percentage, top_rat_trader_percentage, top_entrapment_trader_percentage, bot_degen_rate, fresh_wallet_rate, dev_team_hold_rate, creator_hold_rate}` (строки 0–1),
`wallet_tags_stat.{smart_wallets, renowned_wallets, sniper_wallets, bundler_wallets, rat_trader_wallets, fresh_wallets, whale_wallets}`.

- Капитализация = `Number(price.price) × circulating_supply`.
- `ath_price × total_supply` ≈ `history_highest_market_cap` из trending (30.8M против 31.0M) — ATH можно брать из `token info`.

## `token security`

`renounced_mint`, `renounced_freeze_account` — boolean. `burn_status` (`"burn"`), `burn_ratio`, `top_10_holder_rate` (строка),
`buy_tax`/`sell_tax` (строки), `lock_summary`.
**В ответе для этого токена нет `rug_ratio`, `is_wash_trading`, `bundler_trader_amount_rate`** — вопреки скиллу.
Источники для фильтров сигналов:
- `rug_ratio`, `is_wash_trading`, `bundler_rate` — есть в `market trending`/`trenches` (по токенам вне трендов может не быть);
- доля бандлеров — `token info → stat.top_bundler_trader_percentage`.

## `token traders`

`{ list: Trader[] }`, до 100. Поля совпадают со скиллом. Полезное для discovery:
- `avg_cost` (USD за токен), `history_bought_cost`, `profit`, `realized_profit`, `unrealized_profit`, `start_holding_at`, `buy_tx_count_cur`.
- `tags` (платформенные: `fomo`, `fresh_wallet`, `sandwich_bot`, `axiom`, …) и `maker_token_tags` (по токену: `bundler`, `whale`, `transfer_in`, `diamond_hands`, `paper_hands`).
- **Ранний вход без доп. запросов**: `avg_cost × circulating_supply / ATH`. Если средняя цена входа ≤ 10% ATH,
  то хотя бы одна покупка была ≤ 10% ATH. На токене Agency так проходят 69 из 100 прибыльных трейдеров
  до фильтров (`sandwich_bot`, `bundler`, `transfer_in`, аномальный `start_holding_at`).
  `portfolio activity --token` нужен только для пограничных случаев.

## `market kline`

`{ list: Candle[] }`, по возрастанию `time` (мс). Поля: `time, open, high, low, close, volume (USD), amount (токены), source` — числа строками.
**Отдаёт не больше 100 свечей**: запрос 24 ч по 5m вернул последние 8 ч 20 мин.
Следствие для `outcomes`: максимум за 24 ч берём одним запросом с разрешением **15m** (96 свечей); `high` всё равно ловит пик.
Цена через 1 ч — `close` свечи, куда попадает `buy_ts + 3600`.

## `portfolio stats` — батч не работает

CLI передаёт кошельки как повторяющийся query-параметр `wallet_address`, а сервер возвращает **один объект только по первому кошельку**.
Вывод: `stats` вызывается по одному кошельку (вес 3). Поля (все суммы — строки):

| поле | смысл |
|---|---|
| `realized_profit` | реализованная прибыль за период, USD |
| `realized_profit_pnl` | доходность реализованной прибыли (`realized_profit / cost`); поля `pnl` нет |
| `buy`, `sell` | число покупок/продаж за период |
| `bought_cost`, `sold_income`, `total_cost`, `bought_fee`, `sold_fee` | обороты, USD |
| `last_timestamp` | время последней активности |
| `pnl_stat.winrate` | доля прибыльных токенов (верхнеуровневого `winrate` нет) |
| `pnl_stat.token_num` | число токенов за период |
| `pnl_stat.pnl_lt_nd5_num / pnl_nd5_0x_num / pnl_0x_2x_num / pnl_2x_5x_num / pnl_gt_5x_num` | распределение токенов по доходности: < −50%, −50…0%, 0…+100%, 2–5×, > 5× |
| `pnl_stat.avg_holding_period` | среднее удержание, сек |
| `common.tags`, `common.twitter_username`, `common.twitter_fans_num`, `common.created_at` | профиль |
| `common.fund_from_address`, `common.fund_amount`, `common.fund_from_ts` | **кто профинансировал кошелёк** — для склейки сибилов |

`unrealized_profit` в `stats` нет — он в `profits`.

## `portfolio profits` — батч работает (POST `/v1/user/wallet_profits`)

`{ list: [...] }`, по записи на каждый кошелёк (проверено на 5). Периоды `1d / 7d / 30d / all`. Поля (строки):
`wallet_address, realized_profit, realized_profit_cost, unrealized_profit, unrealized_profit_cost, total_realized_profit,
total_realized_profit_cost, total_profit, total_cost, buy, sell`. Винрейта нет.

Итого для метрик: `pnl_7d/pnl_30d` — батчем через `profits` (до 100 кошельков, один запрос);
`winrate_30d`, распределение доходностей и фандер — через `stats` поштучно, только для кандидатов.

## `portfolio activity`

`{ activities: Activity[], next }`, 50 записей на страницу, новые сверху. Поля: `wallet, tx_hash, timestamp, event_type (buy/sell/…),
token.{address,symbol,total_supply}, token_amount, quote_amount, cost_usd, buy_cost_usd, price_usd, is_open_or_close,
quote_address, quote_token, gas_usd, dex_usd, priority_fee, tip_fee, launchpad, launchpad_platform`.
Для кошелька с 150 сделками по токену первая покупка лежит на 3-й странице — дорого (вес 3 × страницы). Используем редко.

## Наблюдения по качеству (выборка из 5 «smartmoney» без тега arbitrager)

| кошелёк | покупок за 30 д | winrate | доходность | вывод |
|---|---|---|---|---|
| AJcX…M4gs | 3 193 | 45% | +1.3% на $470k оборота | арбитраж/маркетмейкинг |
| 72NW…     | 34 981 | — | +0.7% на $7.2M | бот |
| 8hSh…     | 9 004 | — | +1% на $3.5M | бот |

Фильтр «> 300 сделок в сутки» из ТЗ отсечёт их, но метрики надо считать по `buy` из `stats`, а не только по своим записям.
