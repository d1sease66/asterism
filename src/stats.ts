import { getState, type DB } from './db.js';
import type { GmgnClient } from './gmgn/client.js';

// Operational numbers for /api/stats and `npm run stats`.

export function collectorStats(db: DB, client?: GmgnClient, sinceSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - sinceSec;
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const feeds = (['smartmoney', 'kol'] as const).map((feed) => {
    const polls = db.prepare(`SELECT COUNT(*) AS polls, SUM(inserted) AS inserted, SUM(gap) AS gaps,
        SUM(error IS NOT NULL) AS errors, AVG(CASE WHEN error IS NULL THEN span_sec END) AS avg_span,
        MIN(CASE WHEN error IS NULL THEN span_sec END) AS min_span, AVG(interval_sec) AS avg_interval
      FROM poll_log WHERE feed = ? AND ts >= ?`).get(feed, since) as Record<string, number | null>;
    return {
      feed,
      interval_sec: Number(getState(db, `${feed}:interval`) ?? 0),
      last_poll: Number(getState(db, `${feed}:last_poll`) ?? 0),
      gaps_total: Number(getState(db, `${feed}:gaps`) ?? 0),
      window: polls,
    };
  });
  return {
    now,
    window_sec: sinceSec,
    totals: {
      trades: count('SELECT COUNT(*) AS n FROM trades'),
      trades_real: count('SELECT COUNT(*) AS n FROM trades WHERE route = 0'),
      wallets: count('SELECT COUNT(*) AS n FROM wallets'),
      kol_wallets: count('SELECT COUNT(*) AS n FROM wallets WHERE is_kol = 1'),
      tokens: count('SELECT COUNT(*) AS n FROM tokens'),
    },
    window: {
      trades: count('SELECT COUNT(*) AS n FROM trades WHERE inserted_at >= ?', since),
      wallets_active: count('SELECT COUNT(DISTINCT wallet) AS n FROM trades WHERE ts >= ?', since),
      tokens_active: count('SELECT COUNT(DISTINCT token) AS n FROM trades WHERE ts >= ? AND route = 0', since),
    },
    feeds,
    learned_routes: JSON.parse(getState(db, 'routes:learned') ?? '[]') as string[],
    gmgn: client ? {
      ...client.stats,
      rate_per_sec: Number(client.limiter.rate.toFixed(3)),
      paused_ms: client.limiter.paused,
      pending: client.limiter.pending,
      granted_weight: client.limiter.granted,
    } : undefined,
  };
}
