// Collector report from the local database: `npm run stats [-- hours]`.
import { openDb } from '../dist/db.js';
import { collectorStats } from '../dist/stats.js';

const hours = Number(process.argv[2] || 1);
const db = openDb(process.env.DATA_DIR || './data');
const stats = collectorStats(db, undefined, hours * 3600);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

console.log(`Window: last ${hours} h`);
console.log(`Trades: ${stats.window.trades} new (${stats.totals.trades} total, ${stats.totals.trades_real} not route legs)`);
console.log(`Wallets active: ${stats.window.wallets_active} (total ${stats.totals.wallets}, KOL ${stats.totals.kol_wallets})`);
console.log(`Tokens active: ${stats.window.tokens_active} (total ${stats.totals.tokens})`);
for (const feed of stats.feeds) {
  const w = feed.window;
  console.log(`${feed.feed.padEnd(10)} polls ${w.polls}, inserted ${w.inserted ?? 0}, gaps ${w.gaps ?? 0}, errors ${w.errors ?? 0}, ` +
    `span avg ${Math.round(w.avg_span ?? 0)}s min ${w.min_span ?? '—'}s, interval avg ${(w.avg_interval ?? 0).toFixed(1)}s now ${feed.interval_sec}s`);
}
const flags = db.prepare(`SELECT side, is_open_or_close AS f, COUNT(*) AS n, ROUND(AVG(buy_cost_usd = 0), 3) AS zero_cost
  FROM trades WHERE route = 0 GROUP BY side, f ORDER BY side, f`).all();
console.log('side × is_open_or_close:', flags.map((r) => `${r.side}:${r.f}=${r.n} (buy_cost 0: ${pct(r.zero_cost * r.n, r.n)})`).join(', '));
console.log(`Learned route tokens: ${stats.learned_routes.length}`);
