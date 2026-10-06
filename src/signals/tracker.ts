import type { DB } from '../db.js';
import { GmgnError, PRIORITY, type GmgnClient } from '../gmgn/client.js';
import { logger } from '../log.js';

// Signal outcomes (spec stage 5): price 15 m / 1 h / 4 h / 24 h after each
// sent signal, plus the 24-hour max and min from one 15-minute kline call.

const log = logger('tracker');
const CHECKPOINTS = [
  { column: 'price_15m', after: 15 * 60 },
  { column: 'price_1h', after: 3600 },
  { column: 'price_4h', after: 4 * 3600 },
  { column: 'price_24h', after: 24 * 3600 },
] as const;

interface Pending {
  id: number;
  token: string;
  created_at: number;
  price_15m: number | null;
  price_1h: number | null;
  price_4h: number | null;
  price_24h: number | null;
  max_24h: number | null;
}

export class SignalTracker {
  constructor(private readonly db: DB, private readonly client: GmgnClient) {}

  async run(now = Math.floor(Date.now() / 1000)): Promise<number> {
    const pending = this.db.prepare(`SELECT s.id, s.token, s.created_at, o.price_15m, o.price_1h, o.price_4h, o.price_24h, o.max_24h
      FROM signals s JOIN signal_outcomes o ON o.signal_id = s.id
      WHERE s.status = 'sent' AND o.max_24h IS NULL AND s.created_at >= ? ORDER BY s.created_at`).all(now - 3 * 86400) as Pending[];
    let updated = 0;
    for (const signal of pending) {
      try {
        for (const point of CHECKPOINTS) {
          if (signal[point.column] !== null || now < signal.created_at + point.after) continue;
          // Late by more than an hour (e.g. after downtime): the price would be wrong, leave it empty.
          if (now > signal.created_at + point.after + 3600 && point.column !== 'price_24h') continue;
          const info = await this.client.tokenInfo(signal.token, PRIORITY.background);
          const price = Number(info.price?.price) || null;
          this.db.prepare(`UPDATE signal_outcomes SET ${point.column} = ?, checked_at = ? WHERE signal_id = ?`).run(price, now, signal.id);
          updated += 1;
        }
        if (now >= signal.created_at + 24 * 3600 && signal.max_24h === null) {
          const candles = await this.client.kline(signal.token, '15m', signal.created_at, signal.created_at + 24 * 3600);
          const highs = candles.map((c) => Number(c.high)).filter((v) => v > 0);
          const lows = candles.map((c) => Number(c.low)).filter((v) => v > 0);
          this.db.prepare('UPDATE signal_outcomes SET max_24h = ?, min_24h = ?, checked_at = ? WHERE signal_id = ?')
            .run(highs.length ? Math.max(...highs) : 0, lows.length ? Math.min(...lows) : 0, now, signal.id);
          updated += 1;
        }
      } catch (error) {
        if (error instanceof GmgnError && error.isRateLimit) break;
        log.warn(`signal ${signal.id} outcome failed`, error);
      }
    }
    return updated;
  }
}

export interface SignalStats {
  total: number;
  byType: Record<string, number>;
  tracked: number;
  hit2x: number;
  medianMax: number | null;
  best: { symbol: string; x: number } | null;
  worst: { symbol: string; x: number } | null;
}

/** Results of sent signals over a window (for /stats and the daily summary). */
export function signalStats(db: DB, since: number): SignalStats {
  const rows = db.prepare(`SELECT s.type, s.price_at_signal AS p, o.max_24h AS mx, o.price_24h AS p24, COALESCE(k.symbol, substr(s.token, 1, 6)) AS symbol
    FROM signals s LEFT JOIN signal_outcomes o ON o.signal_id = s.id LEFT JOIN tokens k ON k.address = s.token
    WHERE s.status = 'sent' AND s.created_at >= ?`).all(since) as Array<{ type: string; p: number | null; mx: number | null; p24: number | null; symbol: string }>;
  const byType: Record<string, number> = {};
  rows.forEach((row) => (byType[row.type] = (byType[row.type] ?? 0) + 1));
  const done = rows.filter((row) => row.type !== 'exit_cluster' && row.p && row.mx).map((row) => ({ symbol: row.symbol, max: row.mx! / row.p!, end: row.p24 ? row.p24 / row.p! : null }));
  const maxes = done.map((row) => row.max).sort((a, b) => a - b);
  const byEnd = done.filter((row) => row.end !== null).sort((a, b) => b.end! - a.end!);
  return {
    total: rows.length,
    byType,
    tracked: done.length,
    hit2x: done.filter((row) => row.max >= 2).length,
    medianMax: maxes.length ? maxes[Math.floor(maxes.length / 2)]! : null,
    best: byEnd[0] ? { symbol: byEnd[0].symbol, x: byEnd[0].end! } : null,
    worst: byEnd.at(-1) ? { symbol: byEnd.at(-1)!.symbol, x: byEnd.at(-1)!.end! } : null,
  };
}
