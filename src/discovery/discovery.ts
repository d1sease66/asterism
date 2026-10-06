import type { DB } from '../db.js';
import { GmgnError, type GmgnClient } from '../gmgn/client.js';
import type { RankItem, WalletActivity } from '../gmgn/types.js';
import { logger } from '../log.js';
import { ROUTE_TOKENS, type NormalizedTrade } from '../collector/normalize.js';
import { TradeStore } from '../collector/store.js';
import { classifyTraders, pickWinners, type EarlyHit, type Winner } from './early.js';

// Reverse search (spec 6.4): wallets that bought winners early. Runs on a
// budget at background priority so the live feed always goes first.

const log = logger('discovery');

export interface DiscoveryOptions {
  /** Winner tokens scanned per run (weight 5 each, plus 5 more with smart_degen). */
  tokensPerRun: number;
  /** Also query the smart_degen-tagged trader list (doubles the cost). */
  smartDegenPass: boolean;
  /** A token is rescanned after this long. */
  rescanSec: number;
  /** Distinct winners a wallet must be early in to get its history backfilled. */
  minWinners: number;
  /** One early entry is enough to join the base with at least this profit. */
  singleEarlyProfit: number;
  /** Activity backfills per sync run (weight 3 each). */
  walletsPerSync: number;
  resyncSec: number;
}

// GMGN allows ~10 units/min and the feeds use about half, so a pass of
// 40 tokens × 2 trader lists (400 units) takes ~1.5 h in the background;
// passes never overlap, the next one starts on the following tick.
export const DEFAULT_DISCOVERY: DiscoveryOptions = {
  tokensPerRun: 40,
  smartDegenPass: true,
  rescanSec: 3 * 86400,
  minWinners: 2,
  singleEarlyProfit: 3000,
  walletsPerSync: 20,
  resyncSec: 6 * 3600,
};

export function activityToTrades(wallet: string, activities: WalletActivity[]): NormalizedTrade[] {
  const out: NormalizedTrade[] = [];
  for (const item of activities) {
    if (item.event_type !== 'buy' && item.event_type !== 'sell') continue;
    const token = item.token?.address;
    if (!item.tx_hash || !token) continue;
    out.push({
      txHash: item.tx_hash,
      wallet,
      token,
      side: item.event_type,
      amountUsd: Number(item.cost_usd) || 0,
      priceUsd: Number(item.price_usd) || 0,
      tokenAmount: Number(item.token_amount) || 0,
      buyCostUsd: Number(item.buy_cost_usd) || 0,
      isOpenOrClose: item.is_open_or_close === 1 ? 1 : 0,
      route: ROUTE_TOKENS.has(token),
      ts: Math.floor(Number(item.timestamp)),
      symbol: item.token.symbol ?? '',
      logo: item.token.logo ?? '',
      totalSupply: Number(item.token.total_supply) || 0,
      launchpad: item.launchpad ?? '',
      tags: [],
      twitterUsername: '',
      twitterName: '',
    });
  }
  return out;
}

export class Discovery {
  private readonly store: TradeStore;
  private running = false;

  constructor(
    private readonly db: DB,
    private readonly client: GmgnClient,
    private readonly options: DiscoveryOptions = DEFAULT_DISCOVERY,
  ) {
    this.store = new TradeStore(db);
  }

  async winners(): Promise<Winner[]> {
    const lists: RankItem[] = [];
    const sources: Array<['1h' | '6h' | '24h', string]> = [
      ['24h', 'history_highest_market_cap'], ['6h', 'history_highest_market_cap'], ['1h', 'history_highest_market_cap'],
      ['24h', 'volume'], ['24h', 'smart_degen_count'],
    ];
    for (const [interval, orderBy] of sources) {
      try {
        lists.push(...await this.client.trending(interval, { orderBy, limit: 100 }));
      } catch (error) {
        if (error instanceof GmgnError && error.isRateLimit) throw error;
        log.warn(`trending ${interval}/${orderBy} failed`, error);
      }
    }
    return pickWinners(lists);
  }

  /** One discovery pass. Returns counts for the report. */
  async run(): Promise<{ winners: number; scanned: number; hits: number; promoted: number }> {
    if (this.running) return { winners: 0, scanned: 0, hits: 0, promoted: 0 };
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const winners = await this.winners();
      const fresh = this.db.prepare('SELECT processed_at FROM discovery_tokens WHERE address = ?');
      const due = winners.filter((winner) => {
        const row = fresh.get(winner.address) as { processed_at: number } | undefined;
        return !row || now - row.processed_at > this.options.rescanSec;
      }).slice(0, this.options.tokensPerRun);
      log.info(`${winners.length} winners, scanning ${due.length}`);
      let hits = 0;
      let promoted = this.promote(); // hits left by an interrupted pass
      for (const winner of due) {
        try {
          hits += await this.scan(winner);
          // Promote as we go: a pass takes over an hour and may be cut by a restart.
          promoted += this.promote();
        } catch (error) {
          if (error instanceof GmgnError && error.isRateLimit) {
            log.warn('rate limited, stopping this pass');
            break;
          }
          log.warn(`scan ${winner.symbol} failed`, error);
        }
      }
      log.info(`pass done: ${due.length} tokens, ${hits} early hits, ${promoted} wallets promoted`);
      return { winners: winners.length, scanned: due.length, hits, promoted };
    } finally {
      this.running = false;
    }
  }

  async scan(winner: Winner): Promise<number> {
    const byWallet = new Map<string, EarlyHit>();
    let traders = 0;
    for (const tag of this.options.smartDegenPass ? [undefined, 'smart_degen'] : [undefined]) {
      const { list } = await this.client.tokenTraders(winner.address, { orderBy: 'profit', limit: 100, tag });
      traders += list?.length ?? 0;
      for (const hit of classifyTraders(list ?? [], winner)) byWallet.set(hit.wallet, hit);
    }
    const now = Math.floor(Date.now() / 1000);
    const insertHit = this.db.prepare(`INSERT INTO discovery_hits (wallet, token, entry_ratio, profit, cost, start_ts, found_at, kind, tags_json, twitter)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet, token) DO UPDATE SET entry_ratio = excluded.entry_ratio,
      profit = excluded.profit, cost = excluded.cost, start_ts = excluded.start_ts, found_at = excluded.found_at,
      kind = excluded.kind, tags_json = excluded.tags_json, twitter = excluded.twitter`);
    const saveToken = this.db.prepare(`INSERT INTO discovery_tokens (address, symbol, ath_mc, mc, supply, created_at, processed_at, traders, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, ath_mc = excluded.ath_mc,
      mc = excluded.mc, supply = excluded.supply, processed_at = excluded.processed_at, traders = excluded.traders, hits = excluded.hits`);
    const upsertTokenRow = this.db.prepare(`INSERT INTO tokens (address, symbol, created_at, first_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET symbol = COALESCE(symbol, excluded.symbol), created_at = COALESCE(created_at, excluded.created_at)`);
    this.db.transaction(() => {
      for (const hit of byWallet.values()) {
        insertHit.run(hit.wallet, hit.token, hit.entryRatio, hit.profit, hit.cost, hit.startTs, now, hit.kind, JSON.stringify(hit.tags), hit.twitter);
      }
      saveToken.run(winner.address, winner.symbol, winner.athMc, winner.mc, winner.supply, winner.createdAt, now, traders, byWallet.size);
      upsertTokenRow.run(winner.address, winner.symbol, winner.createdAt, now);
    })();
    log.debug(`${winner.symbol}: ${byWallet.size} early of ${traders}`);
    return byWallet.size;
  }

  /**
   * Discovery wallets join the base when they were early in ≥ minWinners
   * winners, early once with a big profit, or GMGN-tagged and profitable.
   * New rows carry the trader's tags and X handle so exclusion rules apply.
   */
  promote(): number {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db.prepare(`SELECT wallet,
        COUNT(DISTINCT CASE WHEN kind = 'early' THEN token END) AS early_n,
        MAX(CASE WHEN kind = 'early' THEN profit END) AS early_best,
        SUM(kind = 'tagged') AS tagged_n,
        MIN(start_ts) AS first,
        MAX(tags_json) AS tags_json, MAX(twitter) AS twitter
      FROM discovery_hits GROUP BY wallet
      HAVING early_n >= ? OR (early_n >= 1 AND early_best >= ?) OR tagged_n >= 1`)
      .all(this.options.minWinners, this.options.singleEarlyProfit) as Array<{ wallet: string; first: number | null; tags_json: string | null; twitter: string | null }>;
    const insert = this.db.prepare(`INSERT INTO wallets (address, first_seen, last_seen, source, twitter_username, tags_json, is_kol, updated_at, discovered_at)
      VALUES (@wallet, @first, @first, 'discovery', @twitter, @tags, @kol, @now, @now)
      ON CONFLICT(address) DO UPDATE SET discovered_at = COALESCE(discovered_at, excluded.discovered_at),
        twitter_username = COALESCE(twitter_username, excluded.twitter_username)`);
    let promoted = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const tags = (JSON.parse(row.tags_json ?? '[]') as string[]).filter((tag) => !['top_holder', 'whale', 'diamond_hands', 'paper_hands'].includes(tag));
        const result = insert.run({
          wallet: row.wallet,
          first: row.first ?? now,
          twitter: row.twitter,
          tags: JSON.stringify([...new Set(tags)].sort()),
          kol: tags.includes('renowned') || tags.includes('kol') ? 1 : 0,
          now,
        });
        if (result.changes > 0) promoted += 1;
      }
    })();
    return promoted;
  }

  /** Backfill real recent trades of discovery wallets (they are not in the feeds). */
  async syncActivity(): Promise<{ wallets: number; trades: number }> {
    const now = Math.floor(Date.now() / 1000);
    // History backfill is expensive (weight 3, own route limit): only wallets early in ≥ minWinners winners.
    const due = this.db.prepare(`SELECT w.address FROM wallets w LEFT JOIN wallet_sync s ON s.wallet = w.address
      WHERE w.discovered_at IS NOT NULL AND (s.synced_at IS NULL OR s.synced_at < ?)
        AND (SELECT COUNT(DISTINCT h.token) FROM discovery_hits h WHERE h.wallet = w.address AND h.kind = 'early') >= ?
      ORDER BY s.synced_at IS NOT NULL, s.synced_at LIMIT ?`).all(now - this.options.resyncSec, this.options.minWinners, this.options.walletsPerSync) as Array<{ address: string }>;
    const mark = this.db.prepare(`INSERT INTO wallet_sync (wallet, synced_at, newest_ts, trades) VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET synced_at = excluded.synced_at, newest_ts = MAX(COALESCE(newest_ts, 0), excluded.newest_ts), trades = trades + excluded.trades`);
    const seen = this.db.prepare('UPDATE wallets SET last_seen = MAX(last_seen, ?), updated_at = ? WHERE address = ?');
    let total = 0;
    let wallets = 0;
    for (const { address } of due) {
      try {
        const { activities } = await this.client.walletActivity(address, { types: ['buy', 'sell'], limit: 50 });
        const trades = activityToTrades(address, activities ?? []);
        const fresh = this.store.save('activity', trades, now, { updateWallets: false });
        const newest = trades.reduce((max, trade) => Math.max(max, trade.ts), 0);
        if (newest) seen.run(newest, now, address);
        mark.run(address, now, newest || null, fresh.length);
        total += fresh.length;
        wallets += 1;
      } catch (error) {
        if (error instanceof GmgnError && error.isRateLimit) break;
        log.warn(`activity ${address} failed`, error);
      }
    }
    if (wallets) log.info(`activity sync: ${wallets} wallets, ${total} new trades`);
    return { wallets, trades: total };
  }
}
