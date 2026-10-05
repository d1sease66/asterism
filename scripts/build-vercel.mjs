// Builds the Vercel output in .vercel-out/.
//
//   node scripts/build-vercel.mjs              → snapshot mode: the site plus a
//       static copy of /api/public/* taken from the local database now (same
//       15-minute public delay). The page labels itself as a snapshot.
//   API_ORIGIN=https://host node scripts/build-vercel.mjs
//                                              → live mode: /api/* is proxied
//       to the backend, no snapshot files.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.vercel-out';
const apiOrigin = process.env.API_ORIGIN?.replace(/\/$/, '');

// Keep the Vercel project link (.vercel/) between builds.
mkdirSync(OUT, { recursive: true });
for (const entry of readdirSync(OUT)) if (entry !== '.vercel') rmSync(join(OUT, entry), { recursive: true, force: true });
cpSync('web', OUT, { recursive: true });

const vercel = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  cleanUrls: false,
  headers: [
    { source: '/api/(.*)', headers: [{ key: 'cache-control', value: 'public, max-age=60' }] },
    { source: '/(.*)\\.(css|js|svg)', headers: [{ key: 'cache-control', value: 'public, max-age=300' }] },
  ],
};

if (apiOrigin) {
  vercel.rewrites = [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  console.log(`live mode → /api proxied to ${apiOrigin}`);
} else {
  const { openDb } = await import('../dist/db.js');
  const pub = await import('../dist/public.js');
  const db = openDb(process.env.DATA_DIR || './data');
  const now = Math.floor(Date.now() / 1000);
  const dir = join(OUT, 'api/public');
  mkdirSync(join(dir, 'wallet'), { recursive: true });
  const write = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data));

  const summary = pub.summary(db, now);
  const sky = pub.sky(db, now);
  const wallets = pub.wallets(db);
  const feed = pub.feed(db, 0, now);
  write('summary.json', summary);
  write('sky.json', sky);
  write('signals.json', pub.signals(db, now));
  write('wallets.json', wallets);
  write('pulse.json', pub.pulse(db, now));
  write('feed.json', feed);

  // Wallet drawers for every wallet the page can open.
  const addresses = new Set([
    ...sky.stars.map((s) => s.a),
    ...feed.trades.map((t) => t.w),
    ...wallets.wallets.map((w) => w.address),
  ]);
  let written = 0;
  for (const address of addresses) {
    const detail = pub.walletDetail(db, address, now);
    if (detail.error) continue;
    writeFileSync(join(dir, 'wallet', `${address}.json`), JSON.stringify(detail));
    written += 1;
  }
  write('meta.json', { mode: 'snapshot', generated_at: now, cutoff: sky.cutoff });

  // Mark the page so app.js reads the static files and says it is a snapshot.
  const index = join(OUT, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('<html lang="en">', `<html lang="en" data-snapshot="${sky.cutoff}">`));
  console.log(`snapshot mode → ${sky.stars.length} stars, ${feed.trades.length} tape trades, ${written} wallet files, cutoff ${new Date(sky.cutoff * 1000).toISOString()}`);
}

writeFileSync(join(OUT, 'vercel.json'), JSON.stringify(vercel, null, 2));
if (!existsSync(join(OUT, '.vercel'))) console.log('not linked yet: run `vercel link` inside .vercel-out');
