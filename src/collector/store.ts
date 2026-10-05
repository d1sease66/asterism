import type { DB } from '../db.js';
import { FEED_SOURCE, type FeedName, type NormalizedTrade, tradeKey } from './normalize.js';

// Writes feed trades, wallets and tokens. Insert-or-ignore on the trade key
// makes repeated polls idempotent.

export class TradeStore {
  private readonly insertTrade;
  private readonly upsertWallet;
  private readonly upsertToken;
  private readonly hasTrade;

  constructor(private readonly db: DB) {
    this.insertTrade = db.prepare(`
      INSERT OR IGNORE INTO trades (tx_hash, wallet, token, side, amount_usd, price_usd, token_amount, buy_cost_usd,
        is_open_or_close, route, ts, source, inserted_at)
      VALUES (@txHash, @wallet, @token, @side, @amountUsd, @priceUsd, @tokenAmount, @buyCostUsd,
        @isOpenOrClose, @route, @ts, @source, @now)`);
    this.upsertWallet = db.prepare(`
      INSERT INTO wallets (address, first_seen, last_seen, source, twitter_username, twitter_name, tags_json, is_kol, updated_at)
      VALUES (@wallet, @firstTs, @lastTs, @source, NULLIF(@twitterUsername, ''), NULLIF(@twitterName, ''), @tags, @isKol, @now)
      ON CONFLICT(address) DO UPDATE SET
        last_seen = MAX(last_seen, excluded.last_seen),
        first_seen = MIN(first_seen, excluded.first_seen),
        twitter_username = COALESCE(excluded.twitter_username, twitter_username),
        twitter_name = COALESCE(excluded.twitter_name, twitter_name),
        tags_json = excluded.tags_json,
        is_kol = MAX(is_kol, excluded.is_kol),
        updated_at = excluded.updated_at`);
    this.upsertToken = db.prepare(`
      INSERT INTO tokens (address, symbol, logo, total_supply, launchpad, first_seen)
      VALUES (@token, NULLIF(@symbol, ''), NULLIF(@logo, ''), @totalSupply, NULLIF(@launchpad, ''), @ts)
      ON CONFLICT(address) DO UPDATE SET
        symbol = COALESCE(excluded.symbol, symbol),
        logo = COALESCE(excluded.logo, logo),
        total_supply = COALESCE(NULLIF(excluded.total_supply, 0), total_supply),
        launchpad = COALESCE(excluded.launchpad, launchpad),
        first_seen = MIN(first_seen, excluded.first_seen)`);
    this.hasTrade = db.prepare('SELECT 1 FROM trades WHERE tx_hash = ? AND wallet = ? AND token = ? AND side = ?');
  }

  known(key: string): boolean {
    const [tx, wallet, token, side] = key.split('|');
    return this.hasTrade.get(tx, wallet, token, side) !== undefined;
  }

  /** Stores a batch; returns the trades that were new. */
  save(feed: FeedName, trades: NormalizedTrade[], now = Math.floor(Date.now() / 1000)): NormalizedTrade[] {
    const source = FEED_SOURCE[feed];
    const fresh: NormalizedTrade[] = [];
    const tagsByWallet = new Map<string, Set<string>>();
    const span = new Map<string, { first: number; last: number }>();
    for (const trade of trades) {
      const set = tagsByWallet.get(trade.wallet) ?? new Set<string>();
      trade.tags.forEach((tag) => set.add(tag));
      tagsByWallet.set(trade.wallet, set);
      const range = span.get(trade.wallet);
      if (range) {
        range.first = Math.min(range.first, trade.ts);
        range.last = Math.max(range.last, trade.ts);
      } else span.set(trade.wallet, { first: trade.ts, last: trade.ts });
    }
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const trade of trades) {
        const result = this.insertTrade.run({ ...trade, route: trade.route ? 1 : 0, source, now });
        if (result.changes > 0) fresh.push(trade);
        if (!seen.has(trade.wallet)) {
          seen.add(trade.wallet);
          const tags = [...(tagsByWallet.get(trade.wallet) ?? [])].sort();
          this.upsertWallet.run({
            wallet: trade.wallet,
            firstTs: span.get(trade.wallet)!.first,
            lastTs: span.get(trade.wallet)!.last,
            source,
            twitterUsername: trade.twitterUsername,
            twitterName: trade.twitterName,
            tags: JSON.stringify(tags),
            isKol: feed === 'kol' || tags.includes('kol') ? 1 : 0,
            now,
          });
        }
        if (!trade.route) this.upsertToken.run(trade);
      }
    })();
    return fresh;
  }

  static key = tradeKey;
}
