import type { DB } from './db.js';
import { logger } from './log.js';

// Keeps the database small on a server with little free disk. Trades of
// excluded (bot) wallets are only needed for the 24 h sky and pulse; real
// trades back the 30-day metrics.

const log = logger('retention');
const DAY = 86400;

export const RETENTION = {
  tradesDays: 30,
  noiseTradesDays: 3,
  pollLogDays: 7,
  signalsDays: 90,
};

export function cleanUp(db: DB, now = Math.floor(Date.now() / 1000)): Record<string, number> {
  const removed: Record<string, number> = {};
  db.transaction(() => {
    removed.noise_trades = db.prepare(`DELETE FROM trades WHERE ts < ? AND wallet IN (SELECT address FROM wallets WHERE excluded_reason IS NOT NULL)`)
      .run(now - RETENTION.noiseTradesDays * DAY).changes;
    removed.route_legs = db.prepare('DELETE FROM trades WHERE route = 1 AND ts < ?').run(now - RETENTION.noiseTradesDays * DAY).changes;
    removed.trades = db.prepare('DELETE FROM trades WHERE ts < ?').run(now - RETENTION.tradesDays * DAY).changes;
    removed.poll_log = db.prepare('DELETE FROM poll_log WHERE ts < ?').run(now - RETENTION.pollLogDays * DAY).changes;
    removed.buy_outcomes = db.prepare('DELETE FROM buy_outcomes WHERE buy_ts < ?').run(now - RETENTION.tradesDays * DAY).changes;
    removed.filtered_signals = db.prepare(`DELETE FROM signals WHERE status = 'filtered' AND created_at < ?`).run(now - 7 * DAY).changes;
    removed.signals = db.prepare(`DELETE FROM signal_outcomes WHERE signal_id IN (SELECT id FROM signals WHERE created_at < ?)`).run(now - RETENTION.signalsDays * DAY).changes;
    db.prepare('DELETE FROM signals WHERE created_at < ?').run(now - RETENTION.signalsDays * DAY);
    removed.muted = db.prepare('DELETE FROM muted_tokens WHERE until < ?').run(now).changes;
  })();
  // Freed pages are reused by SQLite; fold the WAL back so the file stops growing.
  db.pragma('wal_checkpoint(TRUNCATE)');
  const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
  if (total) log.info(`removed ${JSON.stringify(removed)}`);
  return removed;
}
