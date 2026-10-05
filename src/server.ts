import { DATA_DIR, PORT, POLL_KOL_MIN_SEC, POLL_KOL_SEC, POLL_SMARTMONEY_MAX_SEC, POLL_SMARTMONEY_MIN_SEC, POLL_SMARTMONEY_SEC } from './config.js';
import { FeedCollector } from './collector/collector.js';
import { openDb } from './db.js';
import { GmgnClient } from './gmgn/client.js';
import { startHttp } from './http.js';
import { logger } from './log.js';
import { signals, sky, summary, wallets } from './public.js';
import { collectorStats } from './stats.js';

const log = logger('main');

const db = openDb(DATA_DIR);
// COLLECTOR=0 runs the HTTP side only (site preview next to a live collector).
const collecting = process.env.COLLECTOR !== '0';
const client = new GmgnClient();

const collectors = [
  new FeedCollector(db, client, { feed: 'smartmoney', initialSec: POLL_SMARTMONEY_SEC, minSec: POLL_SMARTMONEY_MIN_SEC, maxSec: POLL_SMARTMONEY_MAX_SEC }),
  new FeedCollector(db, client, { feed: 'kol', initialSec: POLL_KOL_SEC, minSec: POLL_KOL_MIN_SEC, maxSec: POLL_KOL_SEC }),
];

startHttp(PORT, {
  '/health': () => ({ ok: true }),
  '/api/stats': (url) => collectorStats(db, client, Number(url.searchParams.get('window')) || 3600),
  '/api/public/summary': () => summary(db),
  '/api/public/sky': () => sky(db),
  '/api/public/signals': () => signals(db),
  '/api/public/wallets': () => wallets(db),
}, 'web');

if (collecting) collectors.forEach((collector) => collector.start());
log.info(`started${collecting ? '' : ' (collector off)'}; data in ${DATA_DIR}`);

function shutdown(signal: string): void {
  log.info(`${signal}: stopping`);
  collectors.forEach((collector) => collector.stop());
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
