import { exclusionByTags } from '../rules.js';
import type { RankItem, TokenTrader } from '../gmgn/types.js';

// Pure discovery rules (spec 6.4), kept apart from I/O so they are testable.

export const WINNER = {
  maxAgeSec: 30 * 86400,
  minAthMc: 1_000_000,
  // A real pump can round-trip 1000×; a single bad print (DOTF: ATH $1.1B at
  // a $5k cap) cannot be told apart from that, so cap both.
  maxAthToMc: 1000,
  maxAthMc: 5_000_000_000,
};

export const EARLY = {
  maxEntryRatio: 0.1,  // average entry market cap ≤ 10% of ATH
  minProfit: 500,
  minCost: 100,
  maxBuys: 200,        // more buys in one token than this is a bot
};

/** GMGN-tagged smart money / KOL that made money on a winner, early or not. */
export const TAGGED = {
  tags: ['smart_degen', 'renowned', 'kol'],
  minProfit: 1000,
};

export interface Winner {
  address: string;
  symbol: string;
  athMc: number;
  mc: number;
  supply: number;
  createdAt: number;
}

export function pickWinners(items: RankItem[], now = Math.floor(Date.now() / 1000)): Winner[] {
  const out = new Map<string, Winner>();
  for (const item of items) {
    const ath = Number(item.history_highest_market_cap);
    const mc = Number(item.market_cap);
    const price = Number(item.price);
    const created = Number(item.creation_timestamp);
    if (!item.address || !Number.isFinite(ath) || !Number.isFinite(mc) || !created) continue;
    if (now - created > WINNER.maxAgeSec || now - created < 0) continue;
    if (ath < WINNER.minAthMc || ath > WINNER.maxAthMc) continue;
    if (ath / Math.max(mc, 1) > WINNER.maxAthToMc) continue;
    // Circulating supply is not in the rank item; market cap / price gives it.
    const supply = price > 0 ? mc / price : Number(item.total_supply);
    if (!Number.isFinite(supply) || supply <= 0) continue;
    out.set(item.address, { address: item.address, symbol: item.symbol, athMc: ath, mc, supply, createdAt: created });
  }
  return [...out.values()].sort((a, b) => b.athMc - a.athMc);
}

export interface EarlyHit {
  kind: 'early' | 'tagged';
  wallet: string;
  token: string;
  entryRatio: number;
  profit: number;
  cost: number;
  startTs: number | null;
  twitter: string | null;
  tags: string[];
}

/**
 * Classifies a winner's top traders. `early`: average entry ≤ 10% of ATH
 * market cap — average cost is an upper bound for the first buy, so no
 * per-wallet activity call is needed. `tagged`: GMGN smart money / KOL that
 * made ≥ $1k on the winner but entered later.
 */
export function classifyTraders(traders: TokenTrader[], winner: Winner): EarlyHit[] {
  const hits: EarlyHit[] = [];
  for (const trader of traders) {
    if (!trader?.address || trader.addr_type !== 0 || trader.is_suspicious || trader.transfer_in) continue;
    const profit = Number(trader.profit);
    const cost = Number(trader.history_bought_cost);
    const avg = Number(trader.avg_cost);
    if (!(profit >= EARLY.minProfit) || !(cost >= EARLY.minCost) || !(avg > 0)) continue;
    if (Number(trader.buy_tx_count_cur) > EARLY.maxBuys) continue;
    const tags = [...(trader.tags ?? []), ...(trader.maker_token_tags ?? [])].filter((tag): tag is string => typeof tag === 'string');
    if (exclusionByTags(tags)) continue;
    const start = trader.start_holding_at ? Number(trader.start_holding_at) : null;
    if (start !== null && start < winner.createdAt - 60) continue; // impossible history, bad data
    const entryRatio = (avg * winner.supply) / winner.athMc;
    const early = entryRatio <= EARLY.maxEntryRatio;
    const tagged = profit >= TAGGED.minProfit && TAGGED.tags.some((tag) => tags.includes(tag));
    if (!early && !tagged) continue;
    hits.push({
      kind: early ? 'early' : 'tagged',
      wallet: trader.address,
      token: winner.address,
      entryRatio,
      profit,
      cost,
      startTs: start,
      twitter: trader.twitter_username ?? null,
      tags,
    });
  }
  return hits;
}

/** Early profitable buyers only (spec 6.4). */
export function earlyBuyers(traders: TokenTrader[], winner: Winner): EarlyHit[] {
  return classifyTraders(traders, winner).filter((hit) => hit.kind === 'early');
}
