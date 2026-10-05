import { getState, setState, type DB } from '../db.js';
import { GmgnError, type GmgnClient } from '../gmgn/client.js';
import { logger } from '../log.js';
import { coverage, multiLegPartners, nextInterval, normalizeFeed, type FeedName, type NormalizedTrade } from './normalize.js';
import { TradeStore } from './store.js';

// Polls one GMGN feed forever with an interval that follows the feed's real
// turnover. Each poll is logged to poll_log so gaps can be audited later.

const log = logger('collector');
// A token seen as a second leg next to this many distinct tokens is a route token.
const ROUTE_PROMOTE_PARTNERS = 5;

export interface FeedOptions {
  feed: FeedName;
  initialSec: number;
  minSec: number;
  maxSec: number;
}

export type TradesListener = (feed: FeedName, fresh: NormalizedTrade[]) => void;

export class FeedCollector {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  intervalSec: number;
  private readonly store: TradeStore;
  private readonly logPoll;

  constructor(
    private readonly db: DB,
    private readonly client: GmgnClient,
    private readonly options: FeedOptions,
    private readonly routes: RouteBook,
    private readonly onTrades?: TradesListener,
  ) {
    this.store = new TradeStore(db);
    this.intervalSec = Number(getState(db, `${options.feed}:interval`)) || options.initialSec;
    this.logPoll = db.prepare(`INSERT INTO poll_log (feed, ts, records, inserted, span_sec, overlap, gap, interval_sec, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.pollOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logPoll.run(this.options.feed, Math.floor(Date.now() / 1000), 0, 0, 0, 0, 0, this.intervalSec, message.slice(0, 300));
      if (!(error instanceof GmgnError && error.isRateLimit)) log.error(`${this.options.feed} poll failed`, error);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.intervalSec * 1000);
  }

  async pollOnce(): Promise<{ inserted: number; gap: boolean; spanSec: number }> {
    const { feed } = this.options;
    const response = feed === 'smartmoney' ? await this.client.smartMoney(100) : await this.client.kol(100);
    const trades = normalizeFeed(response.list ?? [], this.routes.learned);
    const prevNewest = getState(this.db, `${feed}:newest_ts`);
    const result = coverage(trades, (key) => this.store.known(key), prevNewest === undefined ? undefined : Number(prevNewest));
    const fresh = this.store.save(feed, trades);
    this.routes.learn(trades);

    const now = Math.floor(Date.now() / 1000);
    this.intervalSec = nextInterval(this.intervalSec, result, this.options.minSec, this.options.maxSec);
    setState(this.db, `${feed}:newest_ts`, String(Math.max(result.newestTs, Number(prevNewest ?? 0))));
    setState(this.db, `${feed}:interval`, this.intervalSec.toFixed(2));
    setState(this.db, `${feed}:last_poll`, String(now));
    if (result.gap) {
      const gaps = Number(getState(this.db, `${feed}:gaps`) ?? 0) + 1;
      setState(this.db, `${feed}:gaps`, String(gaps));
      log.warn(`${feed}: possible gap (no overlap, oldest ${result.oldestTs} > previous newest ${prevNewest}); interval → ${this.intervalSec.toFixed(1)}s`);
    }
    this.logPoll.run(feed, now, trades.length, fresh.length, result.spanSec, result.overlap, result.gap ? 1 : 0, this.intervalSec, null);
    log.debug(`${feed}: ${trades.length} records, ${fresh.length} new, span ${result.spanSec}s, overlap ${result.overlap}, next ${this.intervalSec.toFixed(1)}s`);
    if (fresh.length > 0) this.onTrades?.(feed, fresh);
    return { inserted: fresh.length, gap: result.gap, spanSec: result.spanSec };
  }
}

/**
 * Route tokens learned from multi-hop swaps, shared by all feed collectors so
 * a token is learned (and logged) once.
 */
export class RouteBook {
  readonly learned: Set<string>;
  private readonly partners: Map<string, Set<string>>;

  constructor(private readonly db: DB) {
    this.learned = new Set(JSON.parse(getState(db, 'routes:learned') ?? '[]') as string[]);
    const stored = JSON.parse(getState(db, 'routes:partners') ?? '{}') as Record<string, string[]>;
    this.partners = new Map(Object.entries(stored).map(([token, list]) => [token, new Set(list)]));
  }

  learn(trades: NormalizedTrade[]): void {
    let changed = false;
    for (const [token, partners] of multiLegPartners(trades)) {
      const set = this.partners.get(token) ?? new Set<string>();
      const before = set.size;
      partners.forEach((partner) => set.add(partner));
      if (set.size === before) continue;
      changed = true;
      // Keep the record bounded: only the count matters past the threshold.
      this.partners.set(token, new Set([...set].slice(0, ROUTE_PROMOTE_PARTNERS * 2)));
      if (set.size >= ROUTE_PROMOTE_PARTNERS && !this.learned.has(token)) {
        this.learned.add(token);
        log.info(`learned route token ${token} (${set.size} partners)`);
        // Re-mark stored legs of this token that sit next to another token in the same tx.
        this.db.prepare(`UPDATE trades SET route = 1 WHERE token = ? AND route = 0 AND EXISTS (
          SELECT 1 FROM trades t2 WHERE t2.tx_hash = trades.tx_hash AND t2.wallet = trades.wallet AND t2.token <> trades.token)`).run(token);
      }
    }
    if (!changed) return;
    setState(this.db, 'routes:learned', JSON.stringify([...this.learned]));
    setState(this.db, 'routes:partners', JSON.stringify(Object.fromEntries([...this.partners].map(([token, set]) => [token, [...set]]))));
  }
}
