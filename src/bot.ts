import type { DB } from './db.js';
import { esc, short, SITE_URL, usd } from './signals/format.js';
import { signalStats, type SignalStats } from './signals/tracker.js';
import type { CommandHandler } from './telegram.js';

// Bot commands (spec 6.7). Read-only views over the database.

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TYPE_NAMES: Record<string, string> = { cluster: 'cluster', cluster_kol: 'cluster + KOL', a_first_entry: 'A first entry', exit_cluster: 'exit cluster' };

export function formatStats(stats: SignalStats, title: string): string {
  if (!stats.total) return `<b>${title}</b>\nNo signals yet.`;
  const types = Object.entries(stats.byType).map(([type, n]) => `${TYPE_NAMES[type] ?? type} ${n}`).join(' · ');
  const lines = [`<b>${title}</b>`, `Signals: ${stats.total} (${types})`];
  if (stats.tracked) {
    lines.push(`Reached 2× within 24h: ${stats.hit2x}/${stats.tracked} (${Math.round((stats.hit2x / stats.tracked) * 100)}%)`);
    if (stats.medianMax !== null) lines.push(`Median 24h max: ${stats.medianMax.toFixed(2)}×`);
    if (stats.best) lines.push(`Best at 24h: $${esc(stats.best.symbol)} ${stats.best.x.toFixed(2)}×`);
    if (stats.worst) lines.push(`Worst at 24h: $${esc(stats.worst.symbol)} ${stats.worst.x.toFixed(2)}×`);
  } else {
    lines.push('24-hour outcomes are still being tracked.');
  }
  return lines.join('\n');
}

export function commandHandler(db: DB): CommandHandler {
  return async (command, args) => {
    const now = Math.floor(Date.now() / 1000);
    switch (command) {
      case 'help':
        return 'Commands: /stats — signal results for 7 days · /top — top 20 A wallets · /wallet &lt;address&gt; · /token &lt;CA&gt; · /mute &lt;CA&gt; [hours] · /stop';
      case 'stats':
        return formatStats(signalStats(db, now - 7 * 86400), 'Signals, last 7 days');
      case 'top': {
        const rows = db.prepare(`SELECT w.address, w.twitter_username, w.score, m.pnl_30d, m.early_n, m.hit_rate_2x_24h
          FROM wallets w LEFT JOIN wallet_metrics m ON m.wallet = w.address AND m.computed_at = (SELECT MAX(computed_at) FROM wallet_metrics WHERE wallet = w.address)
          WHERE w.tier = 'A' ORDER BY w.score DESC LIMIT 20`).all() as Array<{ address: string; twitter_username: string | null; score: number; pnl_30d: number | null; early_n: number | null; hit_rate_2x_24h: number | null }>;
        if (!rows.length) return 'No A-tier wallets yet: scoring has not run.';
        return ['<b>Top A wallets</b>', ...rows.map((row, i) => {
          const facts = [row.hit_rate_2x_24h !== null ? `hit ${Math.round(row.hit_rate_2x_24h * 100)}%` : null,
            row.early_n ? `early ×${row.early_n}` : null, row.pnl_30d !== null ? `30d ${usd(row.pnl_30d)}` : null].filter(Boolean).join(' · ');
          return `${i + 1}. <a href="${SITE_URL}/#w=${row.address}">${short(row.address)}</a>${row.twitter_username ? ` @${esc(row.twitter_username)}` : ''} · ${facts}`;
        })].join('\n');
      }
      case 'wallet': {
        const address = args[0] ?? '';
        if (!ADDRESS.test(address)) return 'Usage: /wallet &lt;address&gt;';
        const row = db.prepare(`SELECT w.*, m.n_buys, m.pnl_30d, m.trades_per_day, m.median_hold_sec, m.early_n, m.hit_rate_2x_24h, m.kol_dump_rate
          FROM wallets w LEFT JOIN wallet_metrics m ON m.wallet = w.address AND m.computed_at = (SELECT MAX(computed_at) FROM wallet_metrics WHERE wallet = w.address)
          WHERE w.address = ?`).get(address) as Record<string, number | string | null> | undefined;
        if (!row) return 'Not in the base.';
        const trades = db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE wallet = ? AND route = 0`).get(address) as { n: number };
        return [
          `<b>${short(address)}</b>${row.twitter_username ? ` @${esc(String(row.twitter_username))}` : ''}${row.is_kol ? ' · KOL' : ''}`,
          `Tier: ${row.excluded_reason ? `excluded (${esc(String(row.excluded_reason))})` : row.tier ?? 'unranked'}${row.score !== null ? ` · score ${(Number(row.score) * 100).toFixed(0)}` : ''}`,
          `30d PnL: ${usd(row.pnl_30d as number | null)} · trades/day: ${row.trades_per_day !== null ? Number(row.trades_per_day).toFixed(1) : '—'}`,
          `Early in winners: ${row.early_n ?? 0} · hit 2×/24h: ${row.hit_rate_2x_24h !== null ? `${Math.round(Number(row.hit_rate_2x_24h) * 100)}%` : 'n/a'}`,
          `Trades in our records: ${trades.n}`,
          `<a href="${SITE_URL}/#w=${address}">Asterism</a> · <a href="https://solscan.io/account/${address}">Solscan</a> · <a href="https://gmgn.ai/sol/address/${address}">GMGN</a>`,
        ].join('\n');
      }
      case 'token': {
        const token = args[0] ?? '';
        if (!ADDRESS.test(token)) return 'Usage: /token &lt;CA&gt;';
        const rows = db.prepare(`SELECT t.wallet, w.tier, w.is_kol, w.twitter_username, SUM(CASE WHEN t.side = 'buy' THEN t.amount_usd ELSE 0 END) AS bought,
            SUM(CASE WHEN t.side = 'sell' THEN t.amount_usd ELSE 0 END) AS sold, MAX(t.ts) AS last
          FROM trades t JOIN wallets w ON w.address = t.wallet
          WHERE t.token = ? AND t.route = 0 AND t.ts >= ? AND w.excluded_reason IS NULL
          GROUP BY t.wallet ORDER BY (w.tier IS NULL), w.tier, bought DESC LIMIT 15`).all(token, now - 86400) as Array<{ wallet: string; tier: string | null; is_kol: number; twitter_username: string | null; bought: number; sold: number }>;
        if (!rows.length) return 'No wallets from the base traded this token in the last 24h.';
        const symbol = (db.prepare('SELECT symbol FROM tokens WHERE address = ?').get(token) as { symbol: string | null } | undefined)?.symbol;
        return [`<b>$${esc(symbol ?? short(token))}</b> · base wallets, last 24h`, ...rows.map((row) =>
          `• ${row.tier ?? '·'}${row.is_kol ? ' KOL' : ''} ${short(row.wallet)}${row.twitter_username ? ` @${esc(row.twitter_username)}` : ''} · bought ${usd(row.bought)} · sold ${usd(row.sold)}`)].join('\n');
      }
      case 'mute': {
        const token = args[0] ?? '';
        if (!ADDRESS.test(token)) return 'Usage: /mute &lt;CA&gt; [hours]';
        const hours = Math.min(24 * 30, Math.max(1, Number(args[1]) || 24));
        db.prepare('INSERT INTO muted_tokens (token, until) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET until = excluded.until').run(token, now + hours * 3600);
        return `🔇 Muted ${short(token)} for ${hours}h.`;
      }
      default:
        return undefined;
    }
  };
}
