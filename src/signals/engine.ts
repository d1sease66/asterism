import type { DB } from '../db.js';
import { CLUSTER_MIN_WALLETS, CLUSTER_WINDOW_MIN, MIN_BUY_USD, SIGNAL_COOLDOWN_MIN } from '../config.js';
import { GmgnError } from '../gmgn/client.js';
import { logger } from '../log.js';
import type { NormalizedTrade } from '../collector/normalize.js';
import type { Telegram } from '../telegram.js';
import { rejectReasons, type TokenChecker } from './filters.js';
import { formatSignal, type SignalType, type SignalWallet, type Strength } from './format.js';

// Signal engine (spec 6.5). Runs on every batch of new feed trades.

const log = logger('signals');
const A_FIRST_MIN_USD = 1000;
const EXIT_LOOKBACK_SEC = 48 * 3600;
const VERY_STRONG_WALLETS = 5;

interface BuyRow {
  wallet: string;
  usd: number;
  ts: number;
  tier: string | null;
  is_kol: number;
  twitter: string | null;
  hit: number | null;
  early_n: number | null;
  pnl30: number | null;
  dump: number | null;
}

export function strengthFor(type: SignalType, wallets: number): Strength {
  if (type === 'exit_cluster') return 'warning';
  if (type === 'a_first_entry') return 'medium';
  if (type === 'cluster_kol' || wallets >= VERY_STRONG_WALLETS) return 'very_strong';
  return 'strong';
}

export class SignalEngine {
  private readonly busy = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly checker: TokenChecker,
    private readonly telegram: Telegram | null,
  ) {}

  private walletRows(token: string, side: 'buy' | 'sell', since: number, minUsd: number, fullExitOnly = false): BuyRow[] {
    return this.db.prepare(`
      SELECT t.wallet, SUM(t.amount_usd) AS usd, MIN(t.ts) AS ts, w.tier, w.is_kol, w.twitter_username AS twitter,
        m.hit_rate_2x_24h AS hit, m.early_n, m.pnl_30d AS pnl30, m.kol_dump_rate AS dump
      FROM trades t JOIN wallets w ON w.address = t.wallet
      LEFT JOIN wallet_metrics m ON m.wallet = w.address AND m.computed_at = (SELECT MAX(computed_at) FROM wallet_metrics WHERE wallet = w.address)
      WHERE t.token = ? AND t.side = ? AND t.route = 0 AND t.ts >= ? AND t.amount_usd >= ? AND w.excluded_reason IS NULL
        ${fullExitOnly ? 'AND t.is_open_or_close = 1' : ''}
      GROUP BY t.wallet`).all(token, side, since, minUsd) as BuyRow[];
  }

  private toWallets(rows: BuyRow[]): SignalWallet[] {
    return rows.map((row) => ({
      wallet: row.wallet, tier: row.tier, usd: row.usd, ts: row.ts, kol: row.is_kol === 1, twitter: row.twitter,
      hit: row.hit, earlyN: row.early_n ?? 0, pnl30: row.pnl30,
    }));
  }

  private muted(token: string, now: number): boolean {
    const row = this.db.prepare('SELECT until FROM muted_tokens WHERE token = ?').get(token) as { until: number } | undefined;
    return Boolean(row && row.until > now);
  }

  private recent(token: string, types: SignalType[], since: number) {
    return this.db.prepare(`SELECT id, type, status, wallets_json, messages_json, created_at FROM signals
      WHERE token = ? AND type IN (${types.map(() => '?').join(',')}) AND created_at >= ? ORDER BY created_at DESC LIMIT 1`)
      .get(token, ...types, since) as { id: number; type: SignalType; status: string; wallets_json: string; messages_json: string | null; created_at: number } | undefined;
  }

  /** Entry point: new trades from a feed poll. */
  async onTrades(fresh: NormalizedTrade[], now = Math.floor(Date.now() / 1000)): Promise<void> {
    const real = fresh.filter((trade) => !trade.route);
    const buyTokens = new Set(real.filter((trade) => trade.side === 'buy').map((trade) => trade.token));
    const sellTokens = new Set(real.filter((trade) => trade.side === 'sell').map((trade) => trade.token));
    for (const token of buyTokens) await this.guard(token, () => this.checkCluster(token, now));
    for (const trade of real) {
      if (trade.side === 'buy' && trade.amountUsd >= A_FIRST_MIN_USD) await this.guard(trade.token, () => this.checkFirstEntry(trade, now));
    }
    for (const token of sellTokens) await this.guard(token, () => this.checkExit(token, now));
  }

  private async guard(token: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(token)) return;
    this.busy.add(token);
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof GmgnError && error.isRateLimit)) log.error(`signal check ${token} failed`, error);
    } finally {
      this.busy.delete(token);
    }
  }

  async checkCluster(token: string, now: number): Promise<void> {
    if (this.muted(token, now)) return;
    const since = now - CLUSTER_WINDOW_MIN * 60;
    const rows = this.walletRows(token, 'buy', since, MIN_BUY_USD);
    const strong = rows.filter((row) => row.tier === 'A' || row.tier === 'B');
    if (strong.length < CLUSTER_MIN_WALLETS) return;
    const kols = rows.filter((row) => row.is_kol === 1 && (row.tier === 'A' || row.tier === 'B' || row.tier === 'C') && !(row.dump !== null && row.dump >= 0.3));
    const type: SignalType = kols.length > 0 ? 'cluster_kol' : 'cluster';
    const members = [...strong, ...kols.filter((k) => !strong.some((s) => s.wallet === k.wallet))];
    await this.emit(type, token, this.toWallets(members), strong.length, now);
  }

  async checkFirstEntry(trade: NormalizedTrade, now: number): Promise<void> {
    if (this.muted(trade.token, now)) return;
    const wallet = this.db.prepare('SELECT tier, excluded_reason FROM wallets WHERE address = ?').get(trade.wallet) as { tier: string | null; excluded_reason: string | null } | undefined;
    if (wallet?.tier !== 'A' || wallet.excluded_reason) return;
    const earlier = this.db.prepare(`SELECT 1 FROM trades WHERE wallet = ? AND token = ? AND side = 'buy' AND ts < ? LIMIT 1`).get(trade.wallet, trade.token, trade.ts);
    if (earlier) return;
    const rows = this.walletRows(trade.token, 'buy', trade.ts, A_FIRST_MIN_USD).filter((row) => row.wallet === trade.wallet);
    await this.emit('a_first_entry', trade.token, this.toWallets(rows), 1, now);
  }

  async checkExit(token: string, now: number): Promise<void> {
    const prior = this.db.prepare(`SELECT 1 FROM signals WHERE token = ? AND status = 'sent' AND type IN ('cluster', 'cluster_kol', 'a_first_entry') AND created_at >= ?`)
      .get(token, now - EXIT_LOOKBACK_SEC);
    if (!prior) return;
    const rows = this.walletRows(token, 'sell', now - CLUSTER_WINDOW_MIN * 60, 0, true).filter((row) => row.tier === 'A' || row.tier === 'B');
    if (rows.length < CLUSTER_MIN_WALLETS) return;
    await this.emit('exit_cluster', token, this.toWallets(rows), rows.length, now);
  }

  private async emit(type: SignalType, token: string, wallets: SignalWallet[], countForStrength: number, now: number): Promise<void> {
    const family: SignalType[] = type === 'cluster' || type === 'cluster_kol' ? ['cluster', 'cluster_kol'] : [type];
    const previous = this.recent(token, family, now - SIGNAL_COOLDOWN_MIN * 60);
    const before = previous ? (JSON.parse(previous.wallets_json) as SignalWallet[]) : [];
    const grew = wallets.length > before.length || (previous && previous.type === 'cluster' && type === 'cluster_kol');
    // Within the cooldown nothing new is sent unless the cluster grew; this
    // also keeps a filtered token from re-spending API calls on every trade.
    if (previous && !grew) return;

    const facts = await this.checker.facts(token, now);
    const reasons = rejectReasons(facts);
    const strength = strengthFor(type, countForStrength);

    if (reasons.length) {
      if (!previous || previous.status === 'filtered') {
        this.db.prepare(`INSERT INTO signals (type, token, created_at, updated_at, wallets_json, strength, mc_at_signal, price_at_signal, status, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filtered', ?)`).run(type, token, now, now, JSON.stringify(wallets), strength, facts.mc, facts.price, reasons.join(', '));
        log.info(`${type} $${facts.symbol} filtered: ${reasons.join(', ')}`);
      }
      return;
    }

    if (previous && previous.status === 'sent') {
      // Same signal, cluster grew: edit the original message everywhere.
      const text = formatSignal(type, token, facts, wallets, { upgraded: true });
      const messages = JSON.parse(previous.messages_json ?? '{}') as Record<string, number>;
      for (const [chatId, messageId] of Object.entries(messages)) {
        await this.telegram?.edit(chatId, messageId, text).catch((error) => log.warn(`edit ${chatId} failed`, error));
      }
      this.db.prepare('UPDATE signals SET type = ?, wallets_json = ?, strength = ?, updated_at = ?, text = ? WHERE id = ?')
        .run(type, JSON.stringify(wallets), strength, now, text, previous.id);
      log.info(`${type} $${facts.symbol} grew to ${wallets.length} wallets (signal ${previous.id})`);
      return;
    }

    const text = formatSignal(type, token, facts, wallets);
    const messages = this.telegram ? await this.telegram.broadcast(text) : {};
    const result = this.db.prepare(`INSERT INTO signals (type, token, created_at, updated_at, wallets_json, strength, mc_at_signal, price_at_signal, status, messages_json, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`).run(type, token, now, now, JSON.stringify(wallets), strength, facts.mc, facts.price, JSON.stringify(messages), text);
    this.db.prepare('INSERT OR IGNORE INTO signal_outcomes (signal_id) VALUES (?)').run(result.lastInsertRowid);
    log.info(`${type} $${facts.symbol} sent to ${Object.keys(messages).length} chats (${wallets.length} wallets, ${strength})`);
  }
}
