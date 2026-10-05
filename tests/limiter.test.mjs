import test from 'node:test';
import assert from 'node:assert/strict';
import { WeightedLimiter } from '../dist/gmgn/limiter.js';

// Fake clock: sleep advances time instantly, so tests are exact and fast.
function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; await Promise.resolve(); }, get t() { return now; } };
}

test('burst up to capacity is immediate, then requests drain at the rate', async () => {
  const c = clock();
  const limiter = new WeightedLimiter({ ratePerSec: 1, capacity: 4, now: c.now, sleep: c.sleep });
  const times = [];
  for (let i = 0; i < 6; i += 1) {
    await limiter.acquire(1);
    times.push(c.t);
  }
  assert.deepEqual(times, [0, 0, 0, 0, 1000, 2000]);
});

test('weights count: a weight-5 call waits for room', async () => {
  const c = clock();
  const limiter = new WeightedLimiter({ ratePerSec: 2, capacity: 8, now: c.now, sleep: c.sleep });
  await limiter.acquire(5);
  await limiter.acquire(5); // level 5 + 5 = 10 > 8 → wait 2 units / 2 per s = 1 s
  assert.equal(c.t, 1000);
  assert.throws(() => limiter.acquire(9), /exceeds bucket capacity/);
});

test('higher priority jumps the queue', async () => {
  const c = clock();
  const limiter = new WeightedLimiter({ ratePerSec: 1, capacity: 1, now: c.now, sleep: c.sleep });
  await limiter.acquire(1);
  const order = [];
  const low = limiter.acquire(1, 0).then(() => order.push('low'));
  const high = limiter.acquire(1, 10).then(() => order.push('high'));
  await Promise.all([low, high]);
  assert.deepEqual(order, ['high', 'low']);
});

test('penalize pauses everything until reset and halves the rate, which recovers later', async () => {
  const c = clock();
  const limiter = new WeightedLimiter({ ratePerSec: 1, capacity: 2, recoverEveryMs: 60_000, recoverFactor: 2, now: c.now, sleep: c.sleep });
  limiter.penalize(30_000);
  assert.equal(limiter.rate, 0.5);
  await limiter.acquire(1);
  assert.equal(c.t, 30_000);
  // After a quiet recovery period the rate climbs back, never above the max.
  await c.sleep(61_000);
  await limiter.acquire(1);
  assert.equal(limiter.rate, 1);
});

test('background reserve: a feed request is never starved by background work', async () => {
  const c = clock();
  const limiter = new WeightedLimiter({ ratePerSec: 1, capacity: 9, now: c.now, sleep: c.sleep });
  await limiter.acquire(5, 0, 4);          // level 5: background got in, 4 units left free
  const t0 = c.t;
  await limiter.acquire(1, 10);            // feed fits in the reserve at once
  assert.equal(c.t, t0);
  await limiter.acquire(3, 10);            // feed can use the rest of the bucket
  assert.equal(c.t, t0);
  await limiter.acquire(5, 0, 4);          // background waits until level ≤ 0 (9 + 5 + 4 − 9 = 9 s)
  assert.equal(c.t - t0, 9000);
});
