import type { DB } from '../db.js';
import { GmgnError, type GmgnClient } from '../gmgn/client.js';
import { logger } from '../log.js';
import { exclusionByBehaviour, exclusionByTags } from '../rules.js';

// Wallet metrics, exclusions and tiers (spec 6.1–6.3).
//
// score = 0.45·hit + 0.25·rank(pnl_30d) + 0.20·winrate + 0.10·freshness.
// Until 24-hour buy outcomes exist, `hit` is stood in for by discovery
// evidence (early entries into winners); missing components are dropped and
// the remaining weights renormalised, so a wallet is never punished for data
// we have not collected yet.

const log = logger('scorer');

export const WEIGHTS = { hit: 0.45, pnl: 0.25, winrate: 0.2, fresh: 0.1 } as const;
export const TIER_SHARE = { A: 0.15, B: 0.25 } as const;
const DAY = 86400;
const MIN_HIT_BUYS = 10;
const STALE_SEC = 14 * DAY;
const KOL_DUMP_MAX = 0.3;

export interface WalletTrade {
  token: string;
  side: 'buy' | 'sell';
  ts: number;
  full: number;
  usd: number;
}

/** Durations from opening a position (first buy while flat) to a full exit. */
export function holdDurations(trades: WalletTrade[]): number[] {
  const open = new Map<string, number>();
  const out: number[] = [];
  for (const trade of [...trades].sort((a, b) => a.ts - b.ts)) {
    if (trade.side === 'buy') {
      if (!open.has(trade.token)) open.set(trade.token, trade.ts);
    } else if (trade.full === 1 && open.has(trade.token)) {
      out.push(trade.ts - open.get(trade.token)!);
      open.delete(trade.token);
    }
  }
  return out;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Share of a KOL's buys followed by a full exit within an hour. */
export function dumpRate(trades: WalletTrade[]): number | null {
  const buys = trades.filter((trade) => trade.side === 'buy' && trade.full === 1);
  if (buys.length < 3) return null;
  const dumped = buys.filter((buy) => trades.some((t) => t.token === buy.token && t.side === 'sell' && t.full === 1 && t.ts > buy.ts && t.ts - buy.ts <= 3600));
  return dumped.length / buys.length;
}

/** Percentile rank in [0, 1] for each value (ties share the lower rank). */
export function percentileRanks(values: number[]): number[] {
  if (values.length <= 1) return values.map(() => 1);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((value) => sorted.indexOf(value) / (sorted.length - 1));
}

export function freshness(lastSeen: number, now: number): number {
  const age = Math.max(0, now - lastSeen);
  return Math.max(0, 1 - age / STALE_SEC);
}

/** Early entries into distinct winners → [0, 1]; three or more is full marks. */
export function evidence(earlyN: number, taggedN: number): number | null {
  if (earlyN <= 0 && taggedN <= 0) return null;
  return Math.min(1, earlyN / 3 + taggedN * 0.15);
}

export interface Components { hit: number | null; pnl: number | null; winrate: number | null; fresh: number | null }

export function combine(components: Components): number | null {
  let sum = 0;
  let weight = 0;
  for (const key of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) {
    const value = components[key];
    if (value === null || !Number.isFinite(value)) continue;
    sum += WEIGHTS[key] * value;
    weight += WEIGHTS[key];
  }
  // Freshness alone says nothing about skill.
  if (weight <= WEIGHTS.fresh) return null;
  return sum / weight;
}

/** Top 15% → A, next 25% → B, the rest → C. Input sorted best first. */
export function tierFor(index: number, total: number): 'A' | 'B' | 'C' {
  if (index < Math.max(1, Math.round(total * TIER_SHARE.A))) return 'A';
  if (index < Math.round(total * (TIER_SHARE.A + TIER_SHARE.B))) return 'B';
  return 'C';
}

export function downgrade(tier: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  return tier === 'A' ? 'B' : 'C';
}

interface Row {
  address: string;
  tags_json: string;
  is_kol: number;
  last_seen: number;
}

export class Scorer {
  private running = false;

  constructor(private readonly db: DB, private readonly client?: GmgnClient) {}

  /** Batch PnL for 30 days via wallet_profits (100 wallets per call). */
  private async fetchProfits(wallets: string[]): Promise<Map<string, { pnl: number; trades: number }>> {
    const out = new Map<string, { pnl: number; trades: number }>();
    if (!this.client) return out;
    for (let i = 0; i < wallets.length; i += 100) {
      const chunk = wallets.slice(i, i + 100);
      try {
        for (const row of await this.client.walletProfits(chunk, '30d')) {
          out.set(row.wallet_address, { pnl: Number(row.total_profit) || 0, trades: (Number(row.buy) || 0) + (Number(row.sell) || 0) });
        }
      } catch (error) {
        if (error instanceof GmgnError && error.isRateLimit) {
          log.warn(`profits stopped at ${i}/${wallets.length}: rate limited`);
          break;
        }
        log.warn('profits chunk failed', error);
      }
    }
    return out;
  }

  async run(now = Math.floor(Date.now() / 1000)): Promise<{ wallets: number; excluded: number; tiers: Record<string, number> }> {
    if (this.running) return { wallets: 0, excluded: 0, tiers: {} };
    this.running = true;
    try {
      const wallets = this.db.prepare(`SELECT address, tags_json, is_kol, last_seen FROM wallets`).all() as Row[];
      const trades = this.db.prepare(`SELECT wallet, token, side, ts, is_open_or_close AS full, amount_usd AS usd
        FROM trades WHERE route = 0 ORDER BY wallet, ts`).all() as Array<WalletTrade & { wallet: string }>;
      const byWallet = new Map<string, WalletTrade[]>();
      for (const trade of trades) (byWallet.get(trade.wallet) ?? byWallet.set(trade.wallet, []).get(trade.wallet)!).push(trade);
      const hits = new Map((this.db.prepare(`SELECT wallet,
          COUNT(DISTINCT CASE WHEN kind = 'early' THEN token END) AS early_n, SUM(kind = 'tagged') AS tagged_n
        FROM discovery_hits GROUP BY wallet`).all() as Array<{ wallet: string; early_n: number; tagged_n: number }>).map((row) => [row.wallet, row]));
      const outcomes = new Map((this.db.prepare(`SELECT wallet, COUNT(*) AS n, AVG(max_price_24h >= 2 * buy_price) AS hit
        FROM buy_outcomes WHERE done = 1 GROUP BY wallet`).all() as Array<{ wallet: string; n: number; hit: number }>).map((row) => [row.wallet, row]));

      // Tag exclusions first: no API budget is spent on known bots.
      const tagReason = new Map<string, string | undefined>();
      for (const wallet of wallets) tagReason.set(wallet.address, exclusionByTags(JSON.parse(wallet.tags_json) as string[], { isKol: wallet.is_kol === 1 }));
      const live = wallets.filter((wallet) => !tagReason.get(wallet.address));
      const profits = await this.fetchProfits(live.map((wallet) => wallet.address));

      const pnlKnown = live.filter((wallet) => profits.has(wallet.address));
      const ranks = percentileRanks(pnlKnown.map((wallet) => profits.get(wallet.address)!.pnl));
      const pnlRanks = new Map(pnlKnown.map((wallet, i) => [wallet.address, ranks[i]!]));

      interface Scored { wallet: Row; score: number | null; reason?: string; metrics: Record<string, number | null>; components: Components; eligible: boolean; dump: number | null }
      const scored: Scored[] = [];
      for (const wallet of wallets) {
        const own = byWallet.get(wallet.address) ?? [];
        const holds = holdDurations(own);
        const medianHold = holds.length >= 5 ? median(holds) : null;
        const profit = profits.get(wallet.address);
        const perDay = profit ? profit.trades / 30 : null;
        const outcome = outcomes.get(wallet.address);
        const hit = hits.get(wallet.address);
        const nBuys = own.filter((trade) => trade.side === 'buy' && trade.usd >= 100).length;
        const reason = tagReason.get(wallet.address) ?? exclusionByBehaviour(perDay, medianHold);
        const components: Components = {
          hit: outcome && outcome.n >= MIN_HIT_BUYS ? outcome.hit : evidence(hit?.early_n ?? 0, hit?.tagged_n ?? 0),
          pnl: pnlRanks.get(wallet.address) ?? null,
          winrate: null,
          fresh: freshness(wallet.last_seen, now),
        };
        const dump = wallet.is_kol === 1 ? dumpRate(own) : null;
        scored.push({
          wallet,
          reason,
          score: reason ? null : combine(components),
          components,
          eligible: (profit?.pnl ?? 0) > 0 || (hit?.early_n ?? 0) > 0,
          dump,
          metrics: {
            n_buys: nBuys,
            hit_rate_2x_24h: outcome && outcome.n >= MIN_HIT_BUYS ? outcome.hit : null,
            median_hold_sec: medianHold,
            trades_per_day: perDay,
            pnl_7d: null,
            pnl_30d: profit?.pnl ?? null,
            winrate_30d: null,
            kol_dump_rate: dump,
            early_n: hit?.early_n ?? 0,
          },
        });
      }

      // Only wallets with real evidence of skill can be A/B; the rest with a score are C.
      const ranked = scored.filter((s) => s.score !== null && s.eligible).sort((a, b) => b.score! - a.score!);
      const tiers = new Map<string, 'A' | 'B' | 'C'>();
      ranked.forEach((s, i) => {
        let tier = tierFor(i, ranked.length);
        if (now - s.wallet.last_seen > STALE_SEC) tier = downgrade(tier);
        if (s.dump !== null && s.dump >= KOL_DUMP_MAX) tier = 'C';
        tiers.set(s.wallet.address, tier);
      });
      for (const s of scored) if (s.score !== null && !tiers.has(s.wallet.address)) tiers.set(s.wallet.address, 'C');

      const update = this.db.prepare('UPDATE wallets SET tier = ?, score = ?, excluded_reason = ?, updated_at = ? WHERE address = ?');
      const insert = this.db.prepare(`INSERT OR REPLACE INTO wallet_metrics (wallet, computed_at, n_buys, hit_rate_2x_24h, median_hold_sec, trades_per_day,
        pnl_7d, pnl_30d, winrate_30d, kol_dump_rate, raw_stats_json, early_n, components_json)
        VALUES (@wallet, @now, @n_buys, @hit_rate_2x_24h, @median_hold_sec, @trades_per_day, @pnl_7d, @pnl_30d, @winrate_30d, @kol_dump_rate, NULL, @early_n, @components)`);
      const counts: Record<string, number> = { A: 0, B: 0, C: 0, X: 0, none: 0 };
      this.db.transaction(() => {
        for (const s of scored) {
          const tier = s.reason ? 'X' : tiers.get(s.wallet.address) ?? null;
          counts[tier ?? 'none'] = (counts[tier ?? 'none'] ?? 0) + 1;
          update.run(tier, s.score, s.reason ?? null, now, s.wallet.address);
          insert.run({ wallet: s.wallet.address, now, ...s.metrics, components: JSON.stringify(s.components) });
        }
        this.db.prepare('DELETE FROM wallet_metrics WHERE computed_at < ?').run(now - 7 * DAY);
      })();
      log.info(`scored ${wallets.length}: A ${counts.A}, B ${counts.B}, C ${counts.C}, excluded ${counts.X}, no data ${counts.none}; pnl for ${profits.size}`);
      return { wallets: wallets.length, excluded: counts.X ?? 0, tiers: counts };
    } finally {
      this.running = false;
    }
  }
}
