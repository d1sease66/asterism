import type { TokenFacts } from './filters.js';

// Telegram alert text (HTML). English, times in UTC.

export type SignalType = 'cluster' | 'cluster_kol' | 'a_first_entry' | 'exit_cluster';
export type Strength = 'medium' | 'strong' | 'very_strong' | 'warning';

export interface SignalWallet {
  wallet: string;
  tier: string | null;
  usd: number;
  ts: number;
  kol: boolean;
  twitter: string | null;
  hit: number | null;
  earlyN: number;
  pnl30: number | null;
}

export const SITE_URL = process.env.SITE_URL?.trim() || 'https://asterism-pi.vercel.app';

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const a = Math.abs(value);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : a.toFixed(0);
  return `${value < 0 ? '−' : ''}$${s}`;
}

export function age(sec: number | null): string {
  if (sec === null) return 'age n/a';
  if (sec < 3600) return `age ${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `age ${Math.round(sec / 3600)}h`;
  return `age ${Math.round(sec / 86400)}d`;
}

function walletLine(w: SignalWallet): string {
  const parts = [w.tier ?? '·'];
  if (w.kol) parts.push(w.twitter ? `KOL @${esc(w.twitter)}` : 'KOL');
  else if (w.twitter) parts.push(`@${esc(w.twitter)}`);
  if (w.hit !== null) parts.push(`hit ${Math.round(w.hit * 100)}%`);
  else if (w.earlyN > 0) parts.push(`early ×${w.earlyN}`);
  else if (w.pnl30 !== null) parts.push(`30d ${usd(w.pnl30)}`);
  parts.push(usd(w.usd));
  parts.push(`<a href="${SITE_URL}/#w=${w.wallet}">${short(w.wallet)}</a>`);
  return `• ${parts.join(' · ')}`;
}

const HEAD: Record<SignalType, (n: number, mins: number) => string> = {
  cluster: (n, mins) => `🔥 Cluster: %SYM% · ${n} smart wallets in ${mins} min`,
  cluster_kol: (n, mins) => `🌟 Cluster + KOL: %SYM% · ${n} smart wallets in ${mins} min`,
  a_first_entry: () => '🟢 A-wallet first entry: %SYM%',
  exit_cluster: (n, mins) => `🚨 Exit cluster: %SYM% · ${n} smart wallets sold out in ${mins} min`,
};

export function formatSignal(type: SignalType, token: string, facts: TokenFacts, wallets: SignalWallet[], options: { upgraded?: boolean } = {}): string {
  const span = wallets.length ? Math.max(...wallets.map((w) => w.ts)) - Math.min(...wallets.map((w) => w.ts)) : 0;
  const mins = Math.max(1, Math.round(span / 60));
  // Function replacement: a `$&`-like symbol must not be read as a replace pattern.
  const head = HEAD[type](new Set(wallets.map((w) => w.wallet)).size, mins)
    .replace('%SYM%', () => `<b>$${esc(facts.symbol || short(token))}</b>`);
  const risk = [
    `MC ${usd(facts.mc)}`,
    `liq ${usd(facts.liquidity)}`,
    age(facts.ageSec),
    facts.bundler !== null ? `bundlers ${Math.round(facts.bundler * 100)}%` : 'bundlers n/a',
    facts.renounced === null ? 'authorities n/a' : facts.renounced ? 'mint/freeze renounced' : '⚠️ mint/freeze active',
  ].join(' · ');
  const list = [...wallets].sort((a, b) => (a.tier ?? 'Z').localeCompare(b.tier ?? 'Z') || b.usd - a.usd).slice(0, 8).map(walletLine);
  if (wallets.length > 8) list.push(`• +${wallets.length - 8} more`);
  return [
    options.upgraded ? `${head}\n⬆️ <i>cluster grew</i>` : head,
    risk,
    ...list,
    `CA: <code>${token}</code>`,
    `<a href="https://gmgn.ai/sol/token/${token}">GMGN</a> · <a href="https://dexscreener.com/solana/${token}">Dexscreener</a> · <a href="https://solscan.io/token/${token}">Solscan</a>`,
    '<i>Not investment advice.</i>',
  ].join('\n');
}
