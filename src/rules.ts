// Wallet exclusion rules (spec 6.1). Tag rules apply as soon as a wallet is
// seen; behaviour rules need metrics and run in the scorer.

export const EXCLUDE_TAGS = ['wash_trader', 'arbitrager', 'dex_bot', 'bundler', 'rat_trader', 'sandwich_bot'] as const;
// `sniper` alone is weak: excluded only when no strong tag offsets it.
export const WEAK_EXCLUDE_TAGS = ['sniper'] as const;
export const STRONG_TAGS = ['smart_degen', 'kol', 'renowned', 'launchpad_smart'] as const;

export const MAX_TRADES_PER_DAY = 300;
export const MIN_MEDIAN_HOLD_SEC = 60;

/**
 * GMGN puts `arbitrager` on almost every KOL wallet (94 of 100 KOL feed
 * trades on 2026-10-06), so for KOLs that tag alone does not exclude;
 * behaviour rules still apply to them.
 */
export function exclusionByTags(tags: readonly string[], options: { isKol?: boolean } = {}): string | undefined {
  const isKol = options.isKol ?? (tags.includes('kol') || tags.includes('renowned'));
  const hit = EXCLUDE_TAGS.find((tag) => tags.includes(tag) && !(isKol && tag === 'arbitrager'));
  if (hit) return `tag:${hit}`;
  const weak = WEAK_EXCLUDE_TAGS.find((tag) => tags.includes(tag));
  if (weak && !STRONG_TAGS.some((tag) => tags.includes(tag))) return `tag:${weak}`;
  return undefined;
}

export function exclusionByBehaviour(tradesPerDay: number | null, medianHoldSec: number | null): string | undefined {
  if (tradesPerDay !== null && tradesPerDay > MAX_TRADES_PER_DAY) return 'trades_per_day';
  if (medianHoldSec !== null && medianHoldSec < MIN_MEDIAN_HOLD_SEC) return 'median_hold';
  return undefined;
}
