import { DATA_DIR, PORT, POLL_KOL_MIN_SEC, POLL_KOL_SEC, POLL_SMARTMONEY_MAX_SEC, POLL_SMARTMONEY_MIN_SEC, POLL_SMARTMONEY_SEC } from './config.js';
import { commandHandler, formatStats } from './bot.js';
import { FeedCollector, RouteBook } from './collector/collector.js';
import { Discovery } from './discovery/discovery.js';
import { getState, openDb, setState } from './db.js';
import { GmgnClient } from './gmgn/client.js';
import { startHttp } from './http.js';
import { logger } from './log.js';
import { feed, pulse, signals, sky, summary, walletDetail, wallets } from './public.js';
import { Scorer } from './scorer/scorer.js';
import { SignalEngine } from './signals/engine.js';
import { TokenChecker } from './signals/filters.js';
import { SignalTracker, signalStats } from './signals/tracker.js';
import { collectorStats } from './stats.js';
import { isTelegramConfigured, Telegram } from './telegram.js';

const log = logger('main');

const db = openDb(DATA_DIR);
// COLLECTOR=0 runs the HTTP side only (site preview next to a live collector).
const collecting = process.env.COLLECTOR !== '0';
const client = new GmgnClient();
const telegram = collecting && isTelegramConfigured() ? new Telegram(db) : null;
const engine = new SignalEngine(db, new TokenChecker(db, client), telegram);

const routes = new RouteBook(db);
const onTrades = (_feed: string, fresh: Parameters<SignalEngine['onTrades']>[0]) => {
  void engine.onTrades(fresh).catch((error) => log.error('signal engine failed', error));
};
const collectors = [
  new FeedCollector(db, client, { feed: 'smartmoney', initialSec: POLL_SMARTMONEY_SEC, minSec: POLL_SMARTMONEY_MIN_SEC, maxSec: POLL_SMARTMONEY_MAX_SEC }, routes, onTrades),
  new FeedCollector(db, client, { feed: 'kol', initialSec: POLL_KOL_SEC, minSec: POLL_KOL_MIN_SEC, maxSec: POLL_KOL_SEC }, routes, onTrades),
];

startHttp(PORT, {
  '/health': () => ({ ok: true }),
  '/api/stats': (url) => collectorStats(db, client, Number(url.searchParams.get('window')) || 3600),
  '/api/public/summary': () => ({ ...summary(db), bot: telegram?.username || process.env.TELEGRAM_BOT_USERNAME || null }),
  '/api/public/sky': () => sky(db),
  '/api/public/signals': () => signals(db),
  '/api/public/wallets': () => wallets(db),
  '/api/public/feed': (url) => feed(db, Number(url.searchParams.get('since')) || 0),
  '/api/public/pulse': () => pulse(db),
  '/api/public/wallet': (url) => walletDetail(db, url.searchParams.get('a') ?? ''),
}, 'web');

const discovery = new Discovery(db, client);
const scorer = new Scorer(db, client);
const tracker = new SignalTracker(db, client);
const HOUR = 3600_000;
const DISCOVERY_EVERY_MS = Number(process.env.DISCOVERY_EVERY_HOURS || 2) * HOUR;
const SCORE_EVERY_MS = Number(process.env.SCORE_EVERY_HOURS || 6) * HOUR;
const SUMMARY_UTC_HOUR = Number(process.env.DAILY_SUMMARY_UTC_HOUR ?? 7); // 10:00 Moscow

async function discoveryPass(): Promise<void> {
  try {
    await discovery.run();
    await discovery.syncActivity();
  } catch (error) {
    log.warn('discovery pass failed, retrying in 10 min', error);
    setTimeout(() => void discoveryPass(), 10 * 60_000);
  }
}

async function scorePass(): Promise<void> {
  try {
    await scorer.run();
  } catch (error) {
    log.error('scoring failed', error);
  }
}

/** Daily summary once per UTC day at SUMMARY_UTC_HOUR. */
async function dailySummary(): Promise<void> {
  if (!telegram) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < SUMMARY_UTC_HOUR || getState(db, 'summary:last_day') === day) return;
  setState(db, 'summary:last_day', day);
  const stats = signalStats(db, Math.floor(now.getTime() / 1000) - 86400);
  await telegram.broadcast(`${formatStats(stats, `Daily summary · ${day}`)}\n<i>Not investment advice.</i>`);
}

if (collecting) {
  collectors.forEach((collector) => collector.start());
  if (process.env.DISCOVERY !== '0') {
    setTimeout(() => void discoveryPass(), 60_000);
    setInterval(() => void discoveryPass(), DISCOVERY_EVERY_MS);
    setInterval(() => void discovery.syncActivity().catch((error) => log.error('activity sync failed', error)), 30 * 60_000);
  }
  setTimeout(() => void scorePass(), 2 * 60_000);
  setInterval(() => void scorePass(), SCORE_EVERY_MS);
  setInterval(() => void tracker.run().catch((error) => log.error('tracker failed', error)), 5 * 60_000);
  if (telegram) {
    void telegram.poll(commandHandler(db)).catch((error) => log.error('telegram polling stopped', error));
    setInterval(() => void dailySummary().catch((error) => log.error('daily summary failed', error)), 10 * 60_000);
  }
}
log.info(`started${collecting ? '' : ' (collector off)'}${telegram ? ', telegram on' : ''}; data in ${DATA_DIR}`);

function shutdown(signal: string): void {
  log.info(`${signal}: stopping`);
  collectors.forEach((collector) => collector.stop());
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
