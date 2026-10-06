import type { DB } from '../db.js';
import { GmgnError, type GmgnClient } from '../gmgn/client.js';
import type { Candle } from '../gmgn/types.js';
import { logger } from '../log.js';

// Buy outcomes for hit_rate_2x_24h (spec 6.2): for each tracked buy (a full
// position open of ≥ $100 by a non-excluded wallet), the price 1 h and 24 h
// later and the 24-hour max. One kline call per token covers every pending
// buy of that token: 15-minute candles span 25 h, 1-hour candles 100 h.

const log = logger('outcomes');
const DAY = 86400;
const MIN_BUY_USD = 100;

export interface PendingBuy {
  tx_hash: string;
  wallet: string;
  token: string;
  buy_ts: number;
  buy_price: number;
}

export interface Outcome {
  price1h: number | null;
  price24h: number | null;
  max24h: number | null;
}

/** Close of the candle containing `ts`, or the last candle before it. */
function priceAt(candles: Array<{ t: number; close: number }>, ts: number): number | null {
  let best: number | null = null;
  for (const candle of candles) {
    if (candle.t > ts) break;
    best = candle.close;
  }
  return best;
}

export function outcomeFor(buy: PendingBuy, raw: Candle[]): Outcome {
  const candles = raw.map((c) => ({ t: Math.floor(Number(c.time) / 1000), high: Number(c.high), close: Number(c.close) }))
    .filter((c) => c.high > 0 && c.close > 0).sort((a, b) => a.t - b.t);
  const window = candles.filter((c) => c.t >= buy.buy_ts - 3600 && c.t <= buy.buy_ts + DAY);
  return {
    price1h: priceAt(candles, buy.buy_ts + 3600),
    price24h: priceAt(candles, buy.buy_ts + DAY),
    max24h: window.length ? Math.max(...window.map((c) => c.high)) : null,
  };
}

export class Outcomes {
  constructor(private readonly db: DB, private readonly client: GmgnClient) {}

  /** Queue new buys worth tracking. Cheap: SQL only. */
  enqueue(now = Math.floor(Date.now() / 1000)): number {
    return this.db.prepare(`INSERT OR IGNORE INTO buy_outcomes (tx_hash, wallet, token, buy_ts, buy_price)
      SELECT t.tx_hash, t.wallet, t.token, t.ts, t.price_usd FROM trades t JOIN wallets w ON w.address = t.wallet
      WHERE t.side = 'buy' AND t.route = 0 AND t.is_open_or_close = 1 AND t.amount_usd >= ? AND t.price_usd > 0
        AND t.source IN ('gmgn_sm', 'gmgn_kol') AND w.excluded_reason IS NULL AND t.ts >= ?`).run(MIN_BUY_USD, now - 3 * DAY).changes;
  }

  /** Resolve buys older than 24 h, up to `maxTokens` kline calls. */
  async run(maxTokens = 20, now = Math.floor(Date.now() / 1000)): Promise<{ queued: number; tokens: number; resolved: number }> {
    const queued = this.enqueue(now);
    // Buys older than 3 days can no longer be priced well; drop them from the queue.
    this.db.prepare('DELETE FROM buy_outcomes WHERE done = 0 AND buy_ts < ?').run(now - 4 * DAY);
    const tokens = this.db.prepare(`SELECT token, MIN(buy_ts) AS first, MAX(buy_ts) AS last, COUNT(*) AS n FROM buy_outcomes
      WHERE done = 0 AND buy_ts <= ? GROUP BY token ORDER BY n DESC LIMIT ?`).all(now - DAY, maxTokens) as Array<{ token: string; first: number; last: number; n: number }>;
    const pending = this.db.prepare('SELECT tx_hash, wallet, token, buy_ts, buy_price FROM buy_outcomes WHERE done = 0 AND token = ? AND buy_ts <= ?');
    const save = this.db.prepare('UPDATE buy_outcomes SET price_1h = ?, price_24h = ?, max_price_24h = ?, done = 1 WHERE tx_hash = ? AND wallet = ? AND token = ?');
    let resolved = 0;
    let calls = 0;
    for (const row of tokens) {
      const from = row.first - 3600;
      const to = Math.min(now, row.last + DAY);
      const resolution = to - from <= 25 * 3600 ? '15m' : '1h';
      let candles: Candle[];
      try {
        candles = await this.client.kline(row.token, resolution, from, to);
        calls += 1;
      } catch (error) {
        if (error instanceof GmgnError && error.isRateLimit) break;
        log.warn(`kline ${row.token} failed`, error);
        continue;
      }
      const buys = pending.all(row.token, now - DAY) as PendingBuy[];
      this.db.transaction(() => {
        for (const buy of buys) {
          const outcome = outcomeFor(buy, candles);
          // No candles at all (dead token): count as a miss rather than leaving it pending forever.
          save.run(outcome.price1h, outcome.price24h, outcome.max24h ?? 0, buy.tx_hash, buy.wallet, buy.token);
          resolved += 1;
        }
      })();
    }
    if (calls) log.info(`resolved ${resolved} buys over ${calls} tokens (${queued} newly queued)`);
    return { queued, tokens: calls, resolved };
  }
}
