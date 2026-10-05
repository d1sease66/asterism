import { randomUUID } from 'node:crypto';
import { GMGN_API_KEY, GMGN_BURST, GMGN_HOST, GMGN_RATE_PER_SEC, GMGN_TIMEOUT_MS } from '../config.js';
import { logger } from '../log.js';
import { WeightedLimiter } from './limiter.js';
import type {
  Candle, FeedResponse, RankItem, TokenInfo, TokenSecurity, TokenTrader,
  WalletActivity, WalletProfit, WalletStats,
} from './types.js';

// The only module that talks to GMGN. Direct HTTP to the OpenAPI that
// gmgn-cli wraps: X-APIKEY header plus `timestamp` (±5 s) and `client_id`
// (UUID, replay-protected for 7 s) in the query. Weights are GMGN's own.

const log = logger('gmgn');

export const PRIORITY = { feed: 10, signal: 5, background: 0 } as const;

export class GmgnError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiError?: string,
    readonly resetAt?: number,
  ) {
    super(message);
  }
  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Query;
  body?: unknown;
  weight: number;
  priority?: number;
}

export interface ClientStats {
  requests: number;
  errors: number;
  rateLimited: number;
  lastRateLimitAt?: number;
}

const RETRIES = 3;

function buildUrl(path: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else params.set(key, String(value));
  }
  return `${GMGN_HOST}${path}?${params.toString()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export class GmgnClient {
  readonly limiter: WeightedLimiter;
  readonly stats: ClientStats = { requests: 0, errors: 0, rateLimited: 0 };

  constructor(private readonly apiKey = GMGN_API_KEY, limiter?: WeightedLimiter) {
    if (!apiKey) throw new Error('GMGN_API_KEY is not configured (env or ~/.config/gmgn/.env)');
    this.limiter = limiter ?? new WeightedLimiter({ ratePerSec: GMGN_RATE_PER_SEC, capacity: GMGN_BURST });
  }

  async request<T>(path: string, options: RequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      await this.limiter.acquire(options.weight, options.priority ?? PRIORITY.background);
      try {
        return await this.once<T>(method, path, options);
      } catch (error) {
        lastError = error;
        if (error instanceof GmgnError && error.isRateLimit) {
          // Wait for the server's reset instead of retrying: every request
          // during a ban extends it.
          const until = (error.resetAt ? error.resetAt * 1000 : Date.now() + 60_000) + 1_000;
          this.limiter.penalize(until);
          this.stats.rateLimited += 1;
          this.stats.lastRateLimitAt = Date.now();
          log.warn(`${path}: ${error.apiError ?? '429'}, pausing ${Math.round((until - Date.now()) / 1000)}s, rate now ${this.limiter.rate.toFixed(2)}/s`);
          throw error;
        }
        const retriable = !(error instanceof GmgnError) || error.status >= 500;
        if (!retriable || attempt === RETRIES) break;
        await sleep(1_000 * 2 ** (attempt - 1));
      }
    }
    this.stats.errors += 1;
    throw lastError;
  }

  private async once<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const query = { ...options.query, timestamp: Math.floor(Date.now() / 1000), client_id: randomUUID() };
    this.stats.requests += 1;
    const response = await fetch(buildUrl(path, query), {
      method,
      headers: { 'X-APIKEY': this.apiKey, 'Content-Type': 'application/json', 'User-Agent': 'smart-wallet-alerts/0.1' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(GMGN_TIMEOUT_MS),
    });
    const text = await response.text();
    let json: { code?: number; data?: T; error?: string; message?: string; reset_at?: number };
    try {
      json = JSON.parse(text);
    } catch {
      throw new GmgnError(`${path}: HTTP ${response.status}, non-JSON body`, response.status);
    }
    if (response.status === 429 || json.code === 429) {
      const header = Number(response.headers.get('x-ratelimit-reset'));
      const resetAt = json.reset_at ?? (Number.isFinite(header) && header > 0 ? header : undefined);
      throw new GmgnError(`${path}: ${json.message ?? 'rate limited'}`, 429, json.error, resetAt);
    }
    if (!response.ok || json.code !== 0) {
      throw new GmgnError(`${path}: HTTP ${response.status} ${json.error ?? ''} ${json.message ?? ''}`.trim(), response.status || 500, json.error);
    }
    return json.data as T;
  }

  // ---- Feeds (weight 1) ----
  smartMoney(limit = 100): Promise<FeedResponse> {
    return this.request('/v1/user/smartmoney', { query: { chain: 'sol', limit }, weight: 1, priority: PRIORITY.feed });
  }

  kol(limit = 100): Promise<FeedResponse> {
    return this.request('/v1/user/kol', { query: { chain: 'sol', limit }, weight: 1, priority: PRIORITY.feed });
  }

  // ---- Token ----
  tokenInfo(address: string, priority: number = PRIORITY.signal): Promise<TokenInfo> {
    return this.request('/v1/token/info', { query: { chain: 'sol', address }, weight: 1, priority });
  }

  tokenSecurity(address: string, priority: number = PRIORITY.signal): Promise<TokenSecurity> {
    return this.request('/v1/token/security', { query: { chain: 'sol', address }, weight: 1, priority });
  }

  tokenTraders(address: string, options: { orderBy?: string; tag?: string; limit?: number; direction?: 'asc' | 'desc' } = {}): Promise<{ list: TokenTrader[] }> {
    return this.request('/v1/market/token_top_traders', {
      query: { chain: 'sol', address, limit: options.limit ?? 100, order_by: options.orderBy ?? 'profit', direction: options.direction ?? 'desc', tag: options.tag },
      weight: 5,
    });
  }

  // ---- Market ----
  async trending(interval: '1m' | '5m' | '1h' | '6h' | '24h', options: { orderBy?: string; limit?: number; filters?: string[] } = {}): Promise<RankItem[]> {
    const data = await this.request<{ rank: RankItem[] }>('/v1/market/rank', {
      query: { chain: 'sol', interval, limit: options.limit ?? 100, order_by: options.orderBy, direction: 'desc', filters: options.filters },
      weight: 1,
    });
    return data.rank ?? [];
  }

  async kline(address: string, resolution: '1m' | '5m' | '15m' | '1h' | '4h' | '1d', fromSec: number, toSec: number, priority: number = PRIORITY.background): Promise<Candle[]> {
    // GMGN returns at most 100 candles (the most recent ones in the range).
    const data = await this.request<{ list: Candle[] }>('/v1/market/token_kline', {
      query: { chain: 'sol', address, resolution, from: fromSec * 1000, to: toSec * 1000 },
      weight: 2,
      priority,
    });
    return data.list ?? [];
  }

  // ---- Portfolio ----
  /** Single wallet only: the API ignores all but the first wallet_address. */
  walletStats(wallet: string, period: '7d' | '30d'): Promise<WalletStats> {
    return this.request('/v1/user/wallet_stats', { query: { chain: 'sol', wallet_address: wallet, period }, weight: 3 });
  }

  async walletProfits(wallets: string[], period: '1d' | '7d' | '30d' | 'all'): Promise<WalletProfit[]> {
    if (wallets.length === 0 || wallets.length > 100) throw new Error('walletProfits takes 1–100 wallets');
    const data = await this.request<{ list: WalletProfit[] }>('/v1/user/wallet_profits', {
      method: 'POST',
      body: { chain: 'sol', period, wallet_addresses: wallets },
      weight: 3,
    });
    return data.list ?? [];
  }

  walletActivity(wallet: string, options: { token?: string; types?: string[]; cursor?: string; limit?: number } = {}): Promise<{ activities: WalletActivity[]; next?: string }> {
    return this.request('/v1/user/wallet_activity', {
      query: { chain: 'sol', wallet_address: wallet, token_address: options.token, type: options.types, cursor: options.cursor, limit: options.limit },
      weight: 3,
    });
  }
}
