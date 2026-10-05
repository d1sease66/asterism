import { DATA_DIR, PORT, POLL_KOL_MIN_SEC, POLL_KOL_SEC, POLL_SMARTMONEY_MAX_SEC, POLL_SMARTMONEY_MIN_SEC, POLL_SMARTMONEY_SEC } from './config.js';
import { FeedCollector, RouteBook } from './collector/collector.js';
import { Discovery } from './discovery/discovery.js';
import { openDb } from './db.js';
import { GmgnClient } from './gmgn/client.js';
import { startHttp } from './http.js';
import { logger } from './log.js';
import { feed, pulse, signals, sky, summary, walletDetail, wallets } from './public.js';
import { collectorStats } from './stats.js';

const log = logger('main');

const db = openDb(DATA_DIR);
// COLLECTOR=0 runs the HTTP side only (site preview next to a live collector).
const collecting = process.env.COLLECTOR !== '0';
const client = new GmgnClient();

const routes = new RouteBook(db);
const collectors = [
  new FeedCollector(db, client, { feed: 'smartmoney', initialSec: POLL_SMARTMONEY_SEC, minSec: POLL_SMARTMONEY_MIN_SEC, maxSec: POLL_SMARTMONEY_MAX_SEC }, routes),
  new FeedCollector(db, client, { feed: 'kol', initialSec: POLL_KOL_SEC, minSec: POLL_KOL_MIN_SEC, maxSec: POLL_KOL_SEC }, routes),
];

startHttp(PORT, {
  '/health': () => ({ ok: true }),
  '/api/stats': (url) => collectorStats(db, client, Number(url.searchParams.get('window')) || 3600),
  '/api/public/summary': () => summary(db),
  '/api/public/sky': () => sky(db),
  '/api/public/signals': () => signals(db),
  '/api/public/wallets': () => wallets(db),
  '/api/public/feed': (url) => feed(db, Number(url.searchParams.get('since')) || 0),
  '/api/public/pulse': () => pulse(db),
  '/api/public/wallet': (url) => walletDetail(db, url.searchParams.get('a') ?? ''),
}, 'web');

const discovery = new Discovery(db, client);
const DISCOVERY_EVERY_MS = Number(process.env.DISCOVERY_EVERY_HOURS || 2) * 3600_000;
const SYNC_EVERY_MS = 30 * 60_000;

async function discoveryPass(): Promise<void> {
  try {
    await discovery.run();
    await discovery.syncActivity();
  } catch (error) {
    log.warn('discovery pass failed, retrying in 10 min', error);
    setTimeout(() => void discoveryPass(), 10 * 60_000);
  }
}

if (collecting) {
  collectors.forEach((collector) => collector.start());
  if (process.env.DISCOVERY !== '0') {
    setTimeout(() => void discoveryPass(), 60_000);
    setInterval(() => void discoveryPass(), DISCOVERY_EVERY_MS);
    setInterval(() => void discovery.syncActivity().catch((error) => log.error('activity sync failed', error)), SYNC_EVERY_MS);
  }
}
log.info(`started${collecting ? '' : ' (collector off)'}; data in ${DATA_DIR}`);

function shutdown(signal: string): void {
  log.info(`${signal}: stopping`);
  collectors.forEach((collector) => collector.stop());
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
