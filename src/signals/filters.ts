import type { DB } from '../db.js';
import { LIQ_MIN, MAX_BUNDLER, MC_MAX, MC_MIN } from '../config.js';
import { PRIORITY, type GmgnClient } from '../gmgn/client.js';
import type { TokenInfo, TokenSecurity } from '../gmgn/types.js';

// Risk filters before an alert (spec 6.5), from token info + security,
// cached 5 minutes in tokens.last_info_json.
//
// Not available from GMGN for arbitrary tokens: rug_ratio and wash-trading
// (token security does not return them; only rank lists do). They are shown
// when known and never invented.

const CACHE_SEC = 300;
export const MIN_AGE_SEC = 10 * 60;

export interface TokenFacts {
  symbol: string;
  price: number;
  mc: number;
  liquidity: number;
  ageSec: number | null;
  bundler: number | null;
  renounced: boolean | null;
  holders: number | null;
  logo: string | null;
  fetchedAt: number;
}

export function factsFrom(info: TokenInfo, security: TokenSecurity, now: number): TokenFacts {
  const price = Number(info.price?.price) || 0;
  const supply = Number(info.circulating_supply) || Number(info.total_supply) || 0;
  const bundler = Number(info.stat?.top_bundler_trader_percentage);
  const created = Number(info.creation_timestamp) || Number(info.open_timestamp) || 0;
  const renounced = security.renounced_mint === undefined && security.renounced_freeze_account === undefined
    ? null
    : Boolean(security.renounced_mint) && Boolean(security.renounced_freeze_account);
  return {
    symbol: info.symbol,
    price,
    mc: price * supply,
    liquidity: Number(info.liquidity) || 0,
    ageSec: created ? now - created : null,
    bundler: Number.isFinite(bundler) ? bundler : null,
    renounced,
    holders: info.holder_count ?? null,
    logo: info.logo ?? null,
    fetchedAt: now,
  };
}

/** Reasons a token fails the alert filters; empty means it passes. */
export function rejectReasons(facts: TokenFacts): string[] {
  const reasons: string[] = [];
  if (facts.mc < MC_MIN) reasons.push(`mc<${MC_MIN}`);
  if (facts.mc > MC_MAX) reasons.push(`mc>${MC_MAX}`);
  if (facts.liquidity < LIQ_MIN) reasons.push(`liq<${LIQ_MIN}`);
  if (facts.ageSec !== null && facts.ageSec < MIN_AGE_SEC) reasons.push('age<10m');
  if (facts.renounced === false) reasons.push('mint/freeze not renounced');
  if (facts.bundler !== null && facts.bundler > MAX_BUNDLER) reasons.push(`bundlers>${MAX_BUNDLER}`);
  return reasons;
}

export class TokenChecker {
  constructor(private readonly db: DB, private readonly client: GmgnClient) {}

  async facts(token: string, now = Math.floor(Date.now() / 1000)): Promise<TokenFacts> {
    const row = this.db.prepare('SELECT last_info_json, last_info_at FROM tokens WHERE address = ?').get(token) as { last_info_json: string | null; last_info_at: number | null } | undefined;
    if (row?.last_info_json && row.last_info_at && now - row.last_info_at < CACHE_SEC) return JSON.parse(row.last_info_json) as TokenFacts;
    const info = await this.client.tokenInfo(token, PRIORITY.signal);
    const security = await this.client.tokenSecurity(token, PRIORITY.signal);
    const facts = factsFrom(info, security, now);
    this.db.prepare(`INSERT INTO tokens (address, symbol, logo, first_seen, last_info_json, last_info_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET last_info_json = excluded.last_info_json, last_info_at = excluded.last_info_at,
        symbol = COALESCE(tokens.symbol, excluded.symbol), logo = COALESCE(tokens.logo, excluded.logo),
        created_at = COALESCE(tokens.created_at, excluded.created_at)`)
      .run(token, facts.symbol, facts.logo, now, JSON.stringify(facts), now, facts.ageSec !== null ? now - facts.ageSec : null);
    return facts;
  }
}
