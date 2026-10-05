import type { FeedTrade } from '../gmgn/types.js';

export type FeedName = 'smartmoney' | 'kol';
/** Where a trade came from: a live feed or a per-wallet activity backfill. */
export type TradeSource = FeedName | 'activity';
export const FEED_SOURCE: Record<TradeSource, 'gmgn_sm' | 'gmgn_kol' | 'gmgn_activity'> = { smartmoney: 'gmgn_sm', kol: 'gmgn_kol', activity: 'gmgn_activity' };

// Tokens that show up as the middle leg of multi-hop swaps (SOL → cbBTC →
// meme gives two "buy" records in one tx). Never a signal on their own.
export const ROUTE_TOKENS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', // cbBTC
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
]);

export interface NormalizedTrade {
  txHash: string;
  wallet: string;
  token: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  priceUsd: number;
  tokenAmount: number;
  buyCostUsd: number;
  isOpenOrClose: number;
  route: boolean;
  ts: number;
  symbol: string;
  logo: string;
  totalSupply: number;
  launchpad: string;
  tags: string[];
  twitterUsername: string;
  twitterName: string;
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function tradeKey(trade: { txHash: string; wallet: string; token: string; side: string }): string {
  return `${trade.txHash}|${trade.wallet}|${trade.token}|${trade.side}`;
}

/**
 * Converts raw feed records and marks route legs: known route tokens always,
 * learned ones (`learnedRoutes`) when they sit next to another token in the
 * same (tx, wallet) group and at least one leg stays a real trade.
 */
export function normalizeFeed(list: FeedTrade[], learnedRoutes: ReadonlySet<string> = new Set()): NormalizedTrade[] {
  const trades: NormalizedTrade[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw?.transaction_hash || !raw.maker || !raw.base_address) continue;
    if (raw.side !== 'buy' && raw.side !== 'sell') continue;
    const trade: NormalizedTrade = {
      txHash: raw.transaction_hash,
      wallet: raw.maker,
      token: raw.base_address,
      side: raw.side,
      amountUsd: finite(raw.amount_usd),
      priceUsd: finite(raw.price_usd),
      tokenAmount: finite(raw.token_amount),
      buyCostUsd: finite(raw.buy_cost_usd),
      isOpenOrClose: raw.is_open_or_close === 1 ? 1 : 0,
      // Stablecoins, SOL wrappers and majors are never a signal, even alone.
      route: ROUTE_TOKENS.has(raw.base_address),
      ts: Math.floor(finite(raw.timestamp)),
      symbol: raw.base_token?.symbol ?? '',
      logo: raw.base_token?.logo ?? '',
      totalSupply: finite(raw.base_token?.total_supply),
      launchpad: raw.base_token?.launchpad ?? '',
      tags: Array.isArray(raw.maker_info?.tags) ? raw.maker_info!.tags!.filter((tag) => typeof tag === 'string') : [],
      twitterUsername: raw.maker_info?.twitter_username ?? '',
      twitterName: raw.maker_info?.twitter_name ?? '',
    };
    const key = tradeKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    trades.push(trade);
  }

  const groups = new Map<string, NormalizedTrade[]>();
  for (const trade of trades) {
    const key = `${trade.txHash}|${trade.wallet}`;
    const group = groups.get(key);
    if (group) group.push(trade);
    else groups.set(key, [trade]);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((trade) => trade.token)).size < 2) continue;
    const isRoute = (trade: NormalizedTrade) => ROUTE_TOKENS.has(trade.token) || learnedRoutes.has(trade.token);
    if (group.every(isRoute)) continue; // static route legs are already marked
    for (const trade of group) if (isRoute(trade)) trade.route = true;
  }
  return trades;
}

/**
 * Tokens that act as the second leg for many different tokens across
 * multi-hop groups (e.g. PUMP for PUP, DJT for Trannie). Returns partner
 * counts for each token seen in an unresolved multi-token group, so the
 * collector can accumulate them and promote frequent ones to route tokens.
 */
export function multiLegPartners(trades: NormalizedTrade[]): Map<string, Set<string>> {
  const groups = new Map<string, NormalizedTrade[]>();
  for (const trade of trades) {
    const key = `${trade.txHash}|${trade.wallet}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(trade);
  }
  const partners = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    const live = group.filter((trade) => !trade.route);
    const tokens = [...new Set(live.map((trade) => trade.token))];
    if (tokens.length < 2) continue;
    for (const token of tokens) {
      const set = partners.get(token) ?? new Set<string>();
      tokens.filter((other) => other !== token).forEach((other) => set.add(other));
      partners.set(token, set);
    }
  }
  return partners;
}

export interface CoverageResult {
  /** Seconds between oldest and newest record of this response. */
  spanSec: number;
  /** Records already stored by a previous poll. */
  overlap: number;
  /** True when this response does not reach back to the previous one. */
  gap: boolean;
  newestTs: number;
  oldestTs: number;
}

/**
 * Gap check: the previous poll ended at `prevNewestTs`. If no record of this
 * response was already known and its oldest record is newer than that, the
 * feed moved more than 100 records between polls and some were lost.
 */
export function coverage(trades: NormalizedTrade[], known: (key: string) => boolean, prevNewestTs: number | undefined): CoverageResult {
  if (trades.length === 0) return { spanSec: 0, overlap: 0, gap: false, newestTs: prevNewestTs ?? 0, oldestTs: prevNewestTs ?? 0 };
  let newest = -Infinity;
  let oldest = Infinity;
  let overlap = 0;
  for (const trade of trades) {
    newest = Math.max(newest, trade.ts);
    oldest = Math.min(oldest, trade.ts);
    if (known(tradeKey(trade))) overlap += 1;
  }
  const gap = prevNewestTs !== undefined && overlap === 0 && oldest > prevNewestTs;
  return { spanSec: newest - oldest, overlap, gap, newestTs: newest, oldestTs: oldest };
}

/**
 * Next poll interval: poll again before the feed can turn over. Aim at half
 * the observed span so consecutive responses overlap; shrink fast after a
 * gap, grow slowly otherwise.
 */
export function nextInterval(current: number, result: CoverageResult, min: number, max: number): number {
  if (result.gap) return Math.max(min, Math.min(current, result.spanSec) / 2);
  const target = result.spanSec > 0 ? result.spanSec / 2 : max;
  const next = target < current ? target : current + (target - current) * 0.25;
  return Math.min(max, Math.max(min, next));
}
