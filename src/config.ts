import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// .env in the working directory is optional; real environment variables win.
if (existsSync('.env')) process.loadEnvFile('.env');

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function list(name: string): string[] {
  return (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean);
}

// GMGN key: env first, then the gmgn-cli config file. Never logged.
function readGmgnKey(): string {
  const fromEnv = process.env.GMGN_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = join(homedir(), '.config', 'gmgn', '.env');
  if (!existsSync(path)) return '';
  const line = readFileSync(path, 'utf8').split('\n').find((row) => row.startsWith('GMGN_API_KEY='));
  return line ? line.slice('GMGN_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
}

export const GMGN_API_KEY = readGmgnKey();
export const GMGN_HOST = process.env.GMGN_HOST?.trim() || 'https://openapi.gmgn.ai';
// Own leaky bucket in front of GMGN. Measured 2026-10-06: the plan allows
// about 10 weight units per MINUTE (not per second as the docs say); every
// 429 so far happened right after ~11 units within a minute.
export const GMGN_RATE_PER_SEC = num('GMGN_RATE_PER_SEC', 9 / 60);
export const GMGN_BURST = num('GMGN_BURST', 9);
// Units background work (discovery, backfills) must leave free for the feeds.
export const GMGN_FEED_RESERVE = num('GMGN_FEED_RESERVE', 4);
export const GMGN_TIMEOUT_MS = num('GMGN_TIMEOUT_MS', 15_000);

export const DATA_DIR = resolve(process.env.DATA_DIR || './data');
export const PORT = num('PORT', 5190);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
export const TELEGRAM_CHAT_IDS = list('TELEGRAM_CHAT_IDS').filter((id) => /^-?\d+(:\d+)?$/.test(id));
export const REPORT_UTC_OFFSET_HOURS = num('REPORT_UTC_OFFSET_HOURS', 3);

// Collector. The smartmoney feed returns 100 trades that covered only ~25 s
// on 2026-10-06, so its interval adapts to the observed coverage.
export const POLL_SMARTMONEY_SEC = num('POLL_SMARTMONEY_SEC', 20);
export const POLL_SMARTMONEY_MIN_SEC = Math.max(5, num('POLL_SMARTMONEY_MIN_SEC', 12));
export const POLL_SMARTMONEY_MAX_SEC = num('POLL_SMARTMONEY_MAX_SEC', 30);
export const POLL_KOL_SEC = num('POLL_KOL_SEC', 60);
export const POLL_KOL_MIN_SEC = Math.max(5, num('POLL_KOL_MIN_SEC', 20));

// Signals and filters (used from stage 4).
export const CLUSTER_MIN_WALLETS = num('CLUSTER_MIN_WALLETS', 3);
export const CLUSTER_WINDOW_MIN = num('CLUSTER_WINDOW_MIN', 30);
export const MIN_BUY_USD = num('MIN_BUY_USD', 300);
export const MC_MIN = num('MC_MIN', 30_000);
export const MC_MAX = num('MC_MAX', 20_000_000);
export const LIQ_MIN = num('LIQ_MIN', 15_000);
export const MAX_RUG = num('MAX_RUG', 0.3);
export const MAX_BUNDLER = num('MAX_BUNDLER', 0.3);
export const SIGNAL_COOLDOWN_MIN = num('SIGNAL_COOLDOWN_MIN', 60);
// Public dashboard shows signals only after this delay.
export const PUBLIC_DELAY_MIN = num('PUBLIC_DELAY_MIN', 15);
