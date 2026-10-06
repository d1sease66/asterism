import type { DB } from './db.js';
import { CLUSTER_MIN_WALLETS, CLUSTER_WINDOW_MIN, MIN_BUY_USD, PUBLIC_DELAY_MIN } from './config.js';
import { exclusionByTags } from './rules.js';

// Read-only data for the Asterism dashboard. Everything derived from trades
// is cut at now − PUBLIC_DELAY_MIN so the site never front-runs the bot.

const SKY_WINDOW_SEC = 24 * 3600;
const SKY_MAX_STARS = 1500;

interface WalletRow {
  address: string;
  tier: string | null;
  score: number | null;
  is_kol: number;
  twitter_username: string | null;
  tags_json: string;
  excluded_reason: string | null;
  trades: number;
  buys: number;
  volume: number;
  last_ts: number;
}

export function publicCutoff(now = Math.floor(Date.now() / 1000)): number {
  return now - PUBLIC_DELAY_MIN * 60;
}

function walletState(row: WalletRow): { excluded: string | null } {
  return { excluded: row.excluded_reason ?? exclusionByTags(JSON.parse(row.tags_json) as string[]) ?? null };
}

/** Stars: wallets active in the 24 h before the cutoff. */
export function sky(db: DB, now = Math.floor(Date.now() / 1000)) {
  const cutoff = publicCutoff(now);
  const rows = db.prepare(`
    SELECT w.address, w.tier, w.score, w.is_kol, w.twitter_username, w.tags_json, w.excluded_reason,
      COUNT(*) AS trades, SUM(t.side = 'buy') AS buys, SUM(t.amount_usd) AS volume, MAX(t.ts) AS last_ts
    FROM trades t JOIN wallets w ON w.address = t.wallet
    WHERE t.ts BETWEEN ? AND ? AND t.route = 0
    GROUP BY w.address ORDER BY volume DESC LIMIT ?`).all(cutoff - SKY_WINDOW_SEC, cutoff, SKY_MAX_STARS) as WalletRow[];
  const stars = rows.map((row) => ({
    a: row.address,
    tier: row.tier,
    score: row.score,
    kol: row.is_kol === 1,
    x: row.twitter_username,
    n: row.trades,
    vol: Math.round(row.volume),
    last: row.last_ts,
    ...walletState(row),
  }));
  return { cutoff, delay_min: PUBLIC_DELAY_MIN, window_sec: SKY_WINDOW_SEC, stars, asterisms: convergences(db, cutoff) };
}

/**
 * Raw convergences: ≥ CLUSTER_MIN_WALLETS distinct non-excluded wallets
 * bought one token for ≥ MIN_BUY_USD within CLUSTER_WINDOW_MIN, in the 24 h
 * before the cutoff. Until tiers exist this is unscored and labelled so.
 */
export function convergences(db: DB, cutoff: number) {
  const buys = db.prepare(`
    SELECT t.token, t.wallet, t.ts, t.amount_usd, t.price_usd, w.tags_json, w.excluded_reason, w.tier,
      k.symbol, k.logo
    FROM trades t JOIN wallets w ON w.address = t.wallet LEFT JOIN tokens k ON k.address = t.token
    WHERE t.side = 'buy' AND t.route = 0 AND t.amount_usd >= ? AND t.ts BETWEEN ? AND ?
    ORDER BY t.token, t.ts`).all(MIN_BUY_USD, cutoff - SKY_WINDOW_SEC, cutoff) as Array<{
      token: string; wallet: string; ts: number; amount_usd: number; price_usd: number; tags_json: string;
      excluded_reason: string | null; tier: string | null; symbol: string | null; logo: string | null;
    }>;
  const windowSec = CLUSTER_WINDOW_MIN * 60;
  const result: Array<{ token: string; symbol: string | null; logo: string | null; start: number; end: number; wallets: string[]; usd: number; price: number; scored: boolean }> = [];
  let index = 0;
  while (index < buys.length) {
    const token = buys[index]!.token;
    const group = [];
    while (index < buys.length && buys[index]!.token === token) group.push(buys[index++]!);
    const eligible = group.filter((buy) => !(buy.excluded_reason ?? exclusionByTags(JSON.parse(buy.tags_json) as string[]))
      && (buy.tier === null || buy.tier === 'A' || buy.tier === 'B'));
    // Sliding window; report the largest window per token.
    let best: typeof eligible = [];
    for (let start = 0, end = 0; end < eligible.length; end += 1) {
      while (eligible[end]!.ts - eligible[start]!.ts > windowSec) start += 1;
      const slice = eligible.slice(start, end + 1);
      if (new Set(slice.map((buy) => buy.wallet)).size > new Set(best.map((buy) => buy.wallet)).size) best = slice;
    }
    const wallets = [...new Set(best.map((buy) => buy.wallet))];
    if (wallets.length < CLUSTER_MIN_WALLETS) continue;
    result.push({
      token,
      symbol: best[0]!.symbol,
      logo: best[0]!.logo,
      start: best[0]!.ts,
      end: best.at(-1)!.ts,
      wallets,
      usd: Math.round(best.reduce((sum, buy) => sum + buy.amount_usd, 0)),
      price: best[0]!.price_usd,
      scored: best.every((buy) => buy.tier !== null),
    });
  }
  return result.sort((a, b) => b.end - a.end).slice(0, 30);
}

export function summary(db: DB, now = Math.floor(Date.now() / 1000)) {
  const cutoff = publicCutoff(now);
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
  const wallets = db.prepare('SELECT tags_json, excluded_reason, tier, is_kol FROM wallets').all() as Array<{ tags_json: string; excluded_reason: string | null; tier: string | null; is_kol: number }>;
  const reasons: Record<string, number> = {};
  let excluded = 0;
  const tiers: Record<string, number> = { A: 0, B: 0, C: 0 };
  for (const wallet of wallets) {
    const reason = wallet.excluded_reason ?? exclusionByTags(JSON.parse(wallet.tags_json) as string[]);
    if (reason) {
      excluded += 1;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    } else if (wallet.tier && wallet.tier in tiers) tiers[wallet.tier]! += 1;
  }
  const trades24h = one<{ n: number }>('SELECT COUNT(*) AS n FROM trades WHERE ts BETWEEN ? AND ? AND route = 0', cutoff - 86400, cutoff).n;
  // Start of our own observation, not the oldest backfilled trade.
  const since = one<{ t: number | null }>('SELECT MIN(ts) AS t FROM poll_log').t;
  const signals7d = one<{ n: number }>('SELECT COUNT(*) AS n FROM signals WHERE created_at BETWEEN ? AND ?', cutoff - 7 * 86400, cutoff).n;
  const discovered = one<{ n: number }>('SELECT COUNT(*) AS n FROM wallets WHERE discovered_at IS NOT NULL').n;
  const winners = one<{ n: number }>('SELECT COUNT(*) AS n FROM discovery_tokens').n;
  const tradesTotal = one<{ n: number }>('SELECT COUNT(*) AS n FROM trades WHERE route = 0 AND ts <= ?', cutoff).n;
  return {
    cutoff,
    delay_min: PUBLIC_DELAY_MIN,
    watching_since: since,
    wallets: wallets.length,
    kol: wallets.filter((wallet) => wallet.is_kol === 1).length,
    excluded,
    excluded_reasons: reasons,
    tiers,
    scored: tiers.A! + tiers.B! + tiers.C! > 0,
    trades_24h: trades24h,
    trades_total: tradesTotal,
    discovered,
    winners_scanned: winners,
    signals_7d: signals7d,
  };
}

/** Signals published after the delay, with their tracked outcomes. */
export function signals(db: DB, now = Math.floor(Date.now() / 1000)) {
  const rows = db.prepare(`
    SELECT s.id, s.type, s.token, s.created_at, s.wallets_json, s.strength, s.mc_at_signal, s.price_at_signal,
      k.symbol, k.logo, o.price_15m, o.price_1h, o.price_4h, o.price_24h, o.max_24h, o.min_24h
    FROM signals s LEFT JOIN tokens k ON k.address = s.token LEFT JOIN signal_outcomes o ON o.signal_id = s.id
    WHERE s.created_at <= ? ORDER BY s.created_at DESC LIMIT 100`).all(publicCutoff(now));
  return { delay_min: PUBLIC_DELAY_MIN, signals: rows };
}

/** Leaderboard: scored wallets, best first; excluded ones with their reason. */
export function wallets(db: DB) {
  const rows = db.prepare(`
    SELECT w.address, w.tier, w.score, w.is_kol, w.twitter_username, w.excluded_reason, w.last_seen, w.tags_json, w.source, w.discovered_at,
      (SELECT COUNT(*) FROM discovery_hits h WHERE h.wallet = w.address) AS early_hits,
      m.n_buys, m.hit_rate_2x_24h, m.pnl_30d, m.winrate_30d, m.trades_per_day, m.median_hold_sec, m.kol_dump_rate
    FROM wallets w LEFT JOIN wallet_metrics m ON m.wallet = w.address
      AND m.computed_at = (SELECT MAX(computed_at) FROM wallet_metrics WHERE wallet = w.address)
    ORDER BY (w.tier IS NULL), w.tier, w.score DESC, early_hits DESC, w.last_seen DESC LIMIT 1500`).all() as Array<Record<string, unknown> & { tags_json: string; excluded_reason: string | null }>;
  return {
    wallets: rows.map(({ tags_json, ...row }) => ({
      ...row,
      tags: JSON.parse(tags_json) as string[],
      excluded_reason: row.excluded_reason ?? exclusionByTags(JSON.parse(tags_json) as string[]) ?? null,
    })),
  };
}

/**
 * Delayed trade tape: real (non-route) trades in (since, cutoff], oldest
 * first, so the page can replay them at their original pace.
 */
export function feed(db: DB, since: number, now = Math.floor(Date.now() / 1000)) {
  const cutoff = publicCutoff(now);
  const from = Math.max(since, cutoff - 180);
  const rows = db.prepare(`
    SELECT t.tx_hash, t.wallet, t.token, t.side, t.amount_usd, t.is_open_or_close, t.ts,
      w.tier, w.is_kol, w.twitter_username, w.tags_json, w.excluded_reason, k.symbol, k.logo
    FROM trades t JOIN wallets w ON w.address = t.wallet LEFT JOIN tokens k ON k.address = t.token
    WHERE t.route = 0 AND t.ts > ? AND t.ts <= ?
    ORDER BY t.ts, t.rowid LIMIT 400`).all(from, cutoff) as Array<{
      tx_hash: string; wallet: string; token: string; side: string; amount_usd: number; is_open_or_close: number; ts: number;
      tier: string | null; is_kol: number; twitter_username: string | null; tags_json: string; excluded_reason: string | null;
      symbol: string | null; logo: string | null;
    }>;
  return {
    cutoff,
    delay_min: PUBLIC_DELAY_MIN,
    trades: rows.map((row) => ({
      tx: row.tx_hash,
      w: row.wallet,
      t: row.token,
      s: row.symbol,
      logo: row.logo,
      side: row.side,
      usd: Math.round(row.amount_usd),
      full: row.is_open_or_close === 1,
      ts: row.ts,
      tier: row.tier,
      kol: row.is_kol === 1,
      x: row.twitter_username,
      noise: row.excluded_reason ?? exclusionByTags(JSON.parse(row.tags_json) as string[]) ?? null,
    })),
  };
}

/** Activity over the last 24 h in 15-minute buckets: signal-grade vs noise trades. */
export function pulse(db: DB, now = Math.floor(Date.now() / 1000)) {
  const cutoff = publicCutoff(now);
  const bucket = 900;
  const start = Math.floor((cutoff - 86400) / bucket) * bucket;
  const rows = db.prepare(`
    SELECT (t.ts / ${bucket}) * ${bucket} AS b, w.tags_json, w.excluded_reason, COUNT(*) AS n, SUM(t.amount_usd) AS usd
    FROM trades t JOIN wallets w ON w.address = t.wallet
    WHERE t.route = 0 AND t.ts > ? AND t.ts <= ?
    GROUP BY b, w.address`).all(start, cutoff) as Array<{ b: number; tags_json: string; excluded_reason: string | null; n: number; usd: number }>;
  const buckets = new Map<number, { t: number; real: number; noise: number; usd: number }>();
  for (let t = start; t <= cutoff; t += bucket) buckets.set(t, { t, real: 0, noise: 0, usd: 0 });
  for (const row of rows) {
    const slot = buckets.get(row.b);
    if (!slot) continue;
    if (row.excluded_reason ?? exclusionByTags(JSON.parse(row.tags_json) as string[])) slot.noise += row.n;
    else {
      slot.real += row.n;
      slot.usd += row.usd;
    }
  }
  const totals = db.prepare(`
    SELECT COUNT(*) AS trades, COUNT(DISTINCT t.wallet) AS wallets, COUNT(DISTINCT t.token) AS tokens, SUM(t.amount_usd) AS usd
    FROM trades t WHERE t.route = 0 AND t.ts > ? AND t.ts <= ?`).get(cutoff - 86400, cutoff) as { trades: number; wallets: number; tokens: number; usd: number | null };
  return {
    cutoff,
    bucket_sec: bucket,
    buckets: [...buckets.values()].map((slot) => ({ ...slot, usd: Math.round(slot.usd) })),
    totals: { ...totals, usd: Math.round(totals.usd ?? 0) },
  };
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One wallet: profile, early-entry evidence and its real trades before the cutoff. */
export function walletDetail(db: DB, address: string, now = Math.floor(Date.now() / 1000)) {
  if (!ADDRESS.test(address)) return { error: 'bad address' };
  const cutoff = publicCutoff(now);
  const row = db.prepare(`SELECT address, source, first_seen, last_seen, twitter_username, twitter_name, tags_json, is_kol, tier, score,
    excluded_reason, discovered_at FROM wallets WHERE address = ?`).get(address) as (Record<string, unknown> & { tags_json: string; excluded_reason: string | null }) | undefined;
  if (!row) return { error: 'unknown wallet' };
  const tags = JSON.parse(row.tags_json) as string[];
  const early = db.prepare(`SELECT h.token, h.kind, h.entry_ratio, h.profit, h.cost, h.start_ts, d.symbol, d.ath_mc, k.logo
    FROM discovery_hits h LEFT JOIN discovery_tokens d ON d.address = h.token LEFT JOIN tokens k ON k.address = h.token
    WHERE h.wallet = ? ORDER BY h.kind = 'early' DESC, h.profit DESC LIMIT 20`).all(address);
  const trades = db.prepare(`SELECT t.tx_hash AS tx, t.token, t.side, t.amount_usd AS usd, t.price_usd AS price, t.is_open_or_close AS full,
      t.ts, t.source, k.symbol, k.logo
    FROM trades t LEFT JOIN tokens k ON k.address = t.token
    WHERE t.wallet = ? AND t.route = 0 AND t.ts <= ? ORDER BY t.ts DESC LIMIT 60`).all(address, cutoff);
  const totals = db.prepare(`SELECT COUNT(*) AS n, SUM(side = 'buy') AS buys, SUM(amount_usd) AS usd, COUNT(DISTINCT token) AS tokens
    FROM trades WHERE wallet = ? AND route = 0 AND ts <= ?`).get(address, cutoff);
  const { tags_json: _tags, ...profile } = row;
  return {
    cutoff,
    delay_min: PUBLIC_DELAY_MIN,
    wallet: { ...profile, tags, excluded_reason: row.excluded_reason ?? exclusionByTags(tags) ?? null },
    totals,
    early,
    trades,
  };
}
