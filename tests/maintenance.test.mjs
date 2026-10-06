import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../dist/db.js';
import { outcomeFor } from '../dist/scorer/outcomes.js';
import { cleanUp } from '../dist/retention.js';

const T0 = 1_800_000_000;
const candle = (t, high, close) => ({ time: t * 1000, open: close, high, low: close, close, volume: 1, amount: 1 });

test('outcome: price at +1 h and +24 h, max high within 24 h', () => {
  const candles = [candle(T0 - 900, 1, 1), candle(T0, 1.2, 1.1), candle(T0 + 3600, 1.5, 1.4), candle(T0 + 20 * 3600, 2.6, 2.0), candle(T0 + 86400, 3, 1.8), candle(T0 + 90000, 9, 9)];
  const out = outcomeFor({ tx_hash: 'x', wallet: 'w', token: 't', buy_ts: T0 + 60, buy_price: 1 }, candles);
  assert.equal(out.price1h, 1.4);
  // The candle opening at T0 + 24 h contains buy_ts + 24 h (the buy was a minute after T0).
  assert.equal(out.price24h, 1.8);
  assert.equal(out.max24h, 3);             // the 9× candle starts after the window
});

test('outcome: no candles means no data, not a crash', () => {
  assert.deepEqual(outcomeFor({ tx_hash: 'x', wallet: 'w', token: 't', buy_ts: T0, buy_price: 1 }, []), { price1h: null, price24h: null, max24h: null });
});

test('retention keeps recent and real trades, drops old noise and old trades', () => {
  const db = openDb('', ':memory:');
  const now = T0;
  db.prepare(`INSERT INTO wallets (address, first_seen, last_seen, source, tags_json, updated_at, excluded_reason) VALUES ('BOT', 0, 0, 'gmgn_sm', '[]', 0, 'tag:arbitrager'), ('REAL', 0, 0, 'gmgn_sm', '[]', 0, NULL)`).run();
  let n = 0;
  const add = (wallet, ageDays, route = 0) => db.prepare(`INSERT INTO trades (tx_hash, wallet, token, side, amount_usd, price_usd, token_amount, is_open_or_close, route, ts, source, inserted_at)
    VALUES (?, ?, 'T', 'buy', 1, 1, 1, 1, ?, ?, 'gmgn_sm', 0)`).run(`tx${n++}`, wallet, route, now - ageDays * 86400);
  add('BOT', 1); add('BOT', 5); add('REAL', 5); add('REAL', 40); add('REAL', 5, 1);
  const removed = cleanUp(db, now);
  assert.equal(removed.noise_trades, 1);
  assert.equal(removed.route_legs, 1);
  assert.equal(removed.trades, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 2);
});
