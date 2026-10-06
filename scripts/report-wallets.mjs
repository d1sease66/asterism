// Wallet report: `npm run report:wallets` — tier distribution, top 20 A
// wallets with their metrics, and why wallets were excluded.
import { openDb } from '../dist/db.js';

const db = openDb(process.env.DATA_DIR || './data');
const now = Math.floor(Date.now() / 1000);
const usd = (v) => (v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v) >= 1e3 ? `${(Math.abs(v) / 1e3).toFixed(1)}k` : Math.abs(v).toFixed(0)}`);
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const latest = `LEFT JOIN wallet_metrics m ON m.wallet = w.address AND m.computed_at = (SELECT MAX(computed_at) FROM wallet_metrics WHERE wallet = w.address)`;
const observed = `EXISTS (SELECT 1 FROM trades t WHERE t.wallet = w.address AND t.source IN ('gmgn_sm', 'gmgn_kol') AND t.ts >= ${now - 14 * 86400})`;

console.log('Tiers (all · seen in feeds 14 d):');
for (const row of db.prepare(`SELECT COALESCE(tier, 'none') AS tier, COUNT(*) AS n, SUM(${observed}) AS feed FROM wallets w GROUP BY tier ORDER BY tier`).all()) {
  console.log(`  ${row.tier.padEnd(5)} ${String(row.n).padStart(6)} · ${row.feed}`);
}

console.log('\nTop 20 A wallets seen in the feeds:');
const top = db.prepare(`SELECT w.address, w.twitter_username, w.is_kol, w.score, m.n_buys, m.hit_rate_2x_24h, m.pnl_30d, m.trades_per_day, m.median_hold_sec, m.early_n
  FROM wallets w ${latest} WHERE w.tier = 'A' AND ${observed} ORDER BY w.score DESC LIMIT 20`).all();
top.forEach((w, i) => console.log(`  ${String(i + 1).padStart(2)}. ${w.address}  score ${(w.score * 100).toFixed(0)} · hit ${pct(w.hit_rate_2x_24h)} (${w.n_buys ?? 0} buys) · 30d ${usd(w.pnl_30d)} · ${w.trades_per_day?.toFixed(1) ?? '—'}/day · early ×${w.early_n ?? 0}${w.is_kol ? ' · KOL' : ''}${w.twitter_username ? ` @${w.twitter_username}` : ''}`));

console.log('\nTop 10 A wallets from discovery only:');
db.prepare(`SELECT w.address, w.score, m.early_n, m.pnl_30d FROM wallets w ${latest} WHERE w.tier = 'A' AND NOT ${observed} ORDER BY w.score DESC LIMIT 10`).all()
  .forEach((w, i) => console.log(`  ${String(i + 1).padStart(2)}. ${w.address}  score ${(w.score * 100).toFixed(0)} · early ×${w.early_n ?? 0} · 30d ${usd(w.pnl_30d)}`));

console.log('\nExcluded:');
for (const row of db.prepare(`SELECT excluded_reason AS reason, COUNT(*) AS n FROM wallets WHERE excluded_reason IS NOT NULL GROUP BY reason ORDER BY n DESC`).all()) {
  console.log(`  ${row.reason.padEnd(22)} ${row.n}`);
}
const outcomes = db.prepare('SELECT COUNT(*) AS n, SUM(done) AS done, AVG(CASE WHEN done = 1 THEN max_price_24h >= 2 * buy_price END) AS hit FROM buy_outcomes').get();
console.log(`\nBuy outcomes: ${outcomes.done ?? 0}/${outcomes.n} resolved, 2× within 24 h: ${pct(outcomes.hit)}`);
