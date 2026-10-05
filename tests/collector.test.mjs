import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../dist/db.js';
import { normalizeFeed, coverage, nextInterval, tradeKey, multiLegPartners } from '../dist/collector/normalize.js';
import { TradeStore } from '../dist/collector/store.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const CBBTC = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

function raw(overrides = {}) {
  return {
    transaction_hash: 'tx1', maker: 'W1', side: 'buy', base_address: 'TOKEN', amount_usd: 500,
    token_amount: 1000, price_usd: 0.5, buy_cost_usd: 0, is_open_or_close: 1, timestamp: 1_000,
    base_token: { symbol: 'TKN', total_supply: '1000000000', launchpad: 'pump' },
    maker_info: { tags: ['smart_degen'], twitter_username: '', twitter_name: '' },
    ...overrides,
  };
}

test('fixtures parse: every smartmoney and kol record becomes a trade', () => {
  for (const name of ['track-smartmoney', 'track-kol']) {
    const list = fixture(name).list;
    const trades = normalizeFeed(list);
    assert.equal(trades.length, list.length, name);
    for (const trade of trades) {
      assert.ok(trade.txHash && trade.wallet && trade.token, name);
      assert.ok(trade.side === 'buy' || trade.side === 'sell');
      assert.ok(Number.isInteger(trade.ts) && trade.ts > 1.7e9);
      assert.ok(trade.amountUsd >= 0);
    }
  }
});

test('multi-hop: the cbBTC leg of a SOL→cbBTC→meme swap is a route leg', () => {
  const trades = normalizeFeed(fixture('track-smartmoney').list);
  const cb = trades.filter((trade) => trade.token === CBBTC);
  assert.ok(cb.length > 0);
  // Every cbBTC record that shares a tx with another token is route; a lone cbBTC trade is not.
  for (const trade of cb) {
    const partners = trades.filter((other) => other.txHash === trade.txHash && other.wallet === trade.wallet && other.token !== CBBTC);
    assert.equal(trade.route, partners.length > 0);
  }
  // The meme legs stay real.
  assert.ok(trades.some((trade) => trade.symbol === 'SIRIUS' && !trade.route));
});

test('multi-hop: a group made only of route tokens keeps its legs', () => {
  const trades = normalizeFeed([
    raw({ base_address: CBBTC }),
    raw({ base_address: 'So11111111111111111111111111111111111111112' }),
  ]);
  assert.ok(trades.every((trade) => !trade.route));
});

test('learned route tokens are applied, and partners are counted for unknown pairs', () => {
  const list = [raw({ base_address: 'PUP' }), raw({ base_address: 'PUMP' })];
  assert.ok(normalizeFeed(list).every((trade) => !trade.route));
  const partners = multiLegPartners(normalizeFeed(list));
  assert.deepEqual([...partners.get('PUMP')], ['PUP']);
  const learned = normalizeFeed(list, new Set(['PUMP']));
  assert.equal(learned.find((trade) => trade.token === 'PUMP').route, true);
  assert.equal(learned.find((trade) => trade.token === 'PUP').route, false);
});

test('duplicate records in one response collapse to one trade', () => {
  const trades = normalizeFeed([raw(), raw(), raw({ side: 'sell' })]);
  assert.equal(trades.length, 2);
});

test('store: repeated polls insert each trade once and keep wallets/tokens', () => {
  const db = openDb('', ':memory:');
  const store = new TradeStore(db);
  const trades = normalizeFeed(fixture('track-kol').list);
  const first = store.save('kol', trades);
  const second = store.save('kol', trades);
  assert.equal(first.length, trades.length);
  assert.equal(second.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, trades.length);
  const wallets = new Set(trades.map((trade) => trade.wallet)).size;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wallets').get().n, wallets);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE is_kol = 1').get().n, wallets);
  const kol = db.prepare("SELECT * FROM wallets WHERE twitter_username = 'pheromones_sol'").get();
  assert.ok(kol && JSON.parse(kol.tags_json).includes('kol'));
  // Route legs do not create token rows.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE address = ?`).get(CBBTC).n,
    trades.some((trade) => trade.token === CBBTC && !trade.route) ? 1 : 0);
  assert.ok(store.known(tradeKey(trades[0])));
});

test('store: wallet first/last seen span all of its trades, across polls', () => {
  const db = openDb('', ':memory:');
  const store = new TradeStore(db);
  store.save('smartmoney', normalizeFeed([raw({ transaction_hash: 'a', timestamp: 2_000 }), raw({ transaction_hash: 'b', timestamp: 1_500 })]));
  store.save('smartmoney', normalizeFeed([raw({ transaction_hash: 'c', timestamp: 3_000 })]));
  const wallet = db.prepare("SELECT * FROM wallets WHERE address = 'W1'").get();
  assert.equal(wallet.first_seen, 1_500);
  assert.equal(wallet.last_seen, 3_000);
  assert.equal(wallet.is_kol, 0);
});

test('coverage: overlapping responses are not a gap', () => {
  const known = new Set(['x|W1|T|buy']);
  const trades = normalizeFeed([raw({ transaction_hash: 'x', base_address: 'T', timestamp: 100 }), raw({ transaction_hash: 'y', base_address: 'T', timestamp: 130 })]);
  const result = coverage(trades, (key) => known.has(key), 100);
  assert.equal(result.gap, false);
  assert.equal(result.overlap, 1);
  assert.equal(result.spanSec, 30);
});

test('coverage: no overlap and oldest newer than the previous newest is a gap', () => {
  const trades = normalizeFeed([raw({ transaction_hash: 'p', timestamp: 205 }), raw({ transaction_hash: 'q', timestamp: 230 })]);
  assert.equal(coverage(trades, () => false, 200).gap, true);
  // Same second as the previous newest: records may still be continuous.
  assert.equal(coverage(normalizeFeed([raw({ transaction_hash: 'r', timestamp: 200 })]), () => false, 200).gap, false);
  // First poll ever cannot be a gap.
  assert.equal(coverage(trades, () => false, undefined).gap, false);
});

test('nextInterval: follows half the span, shrinks after a gap, stays in bounds', () => {
  const ok = (span) => ({ spanSec: span, overlap: 5, gap: false, newestTs: 0, oldestTs: 0 });
  assert.equal(nextInterval(20, ok(25), 8, 30), 12.5);          // shrink at once
  assert.equal(nextInterval(10, ok(60), 8, 30), 15);            // grow by 25% of the distance
  assert.equal(nextInterval(10, ok(4), 8, 30), 8);              // floor
  assert.equal(nextInterval(20, { ...ok(12), gap: true }, 8, 30), 8); // gap → half of min(current, span)
  assert.equal(nextInterval(29, ok(500), 8, 30), 30);           // ceiling
});
