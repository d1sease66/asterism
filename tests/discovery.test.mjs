import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickWinners, earlyBuyers, EARLY } from '../dist/discovery/early.js';
import { activityToTrades } from '../dist/discovery/discovery.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const AGENCY = '7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump';
const NOW = 1791235500; // fixture capture time

test('winners: young tokens with ATH ≥ $1M; absurd ATH prints are dropped', () => {
  const rank = fixture('market-trending-24h-ath').data.rank;
  const winners = pickWinners(rank, NOW);
  assert.ok(winners.length > 30);
  assert.ok(winners.every((w) => w.athMc >= 1e6 && NOW - w.createdAt <= 30 * 86400));
  assert.ok(winners.some((w) => w.address === AGENCY));
  // DOTF: ATH $1.1B at a $5k cap is a bad print.
  assert.ok(!winners.some((w) => w.symbol === 'DOTF'));
});

test('winners: supply comes from market cap / price', () => {
  const winner = pickWinners(fixture('market-trending-24h-ath').data.rank, NOW).find((w) => w.address === AGENCY);
  const info = fixture('token-info');
  assert.ok(Math.abs(winner.supply - Number(info.circulating_supply)) / Number(info.circulating_supply) < 0.02);
});

test('early buyers on a real winner: entry ≤ 10% of ATH, profitable, no bots', () => {
  const winner = pickWinners(fixture('market-trending-24h-ath').data.rank, NOW).find((w) => w.address === AGENCY);
  const traders = fixture('token-traders-profit').list;
  const hits = earlyBuyers(traders, winner);
  assert.ok(hits.length > 10 && hits.length < traders.length);
  for (const hit of hits) {
    assert.ok(hit.entryRatio <= EARLY.maxEntryRatio);
    assert.ok(hit.profit >= EARLY.minProfit);
    assert.ok(!hit.tags.includes('bundler') && !hit.tags.includes('sandwich_bot'));
  }
  // The sandwich bot with 2620 buys and a bogus start time is out.
  assert.ok(!hits.some((hit) => hit.wallet.startsWith('MriyaN')));
  // Transfer-in holders have no trustworthy cost basis.
  const transferIn = traders.filter((t) => t.transfer_in).map((t) => t.address);
  assert.ok(!hits.some((hit) => transferIn.includes(hit.wallet)));
});

test('early buyers: boundary on the entry ratio', () => {
  const winner = { address: 'T', symbol: 'T', athMc: 10_000_000, mc: 1, supply: 1_000_000_000, createdAt: 1000 };
  const base = { address: 'W', addr_type: 0, is_suspicious: false, transfer_in: false, profit: 5000, history_bought_cost: 500, buy_tx_count_cur: 3, start_holding_at: 2000, tags: [], maker_token_tags: [] };
  assert.equal(earlyBuyers([{ ...base, avg_cost: 0.001 }], winner).length, 1);    // entry $1M = 10%
  assert.equal(earlyBuyers([{ ...base, avg_cost: 0.0011 }], winner).length, 0);   // 11%
  assert.equal(earlyBuyers([{ ...base, avg_cost: 0.0001, profit: 100 }], winner).length, 0); // too little profit
  assert.equal(earlyBuyers([{ ...base, avg_cost: 0.0001, addr_type: 2 }], winner).length, 0); // pool / exchange
  assert.equal(earlyBuyers([{ ...base, avg_cost: 0.0001, start_holding_at: 10 }], winner).length, 0); // before creation
});

test('activity → trades keeps only buys/sells and marks route tokens', () => {
  const acts = fixture('portfolio-activity').activities;
  const trades = activityToTrades('Df7DsBZPhHKK6qxG7DQ1jNQ7J5HbJw1eZLhG4M1DWhLH', acts);
  assert.equal(trades.length, acts.filter((a) => a.event_type === 'buy' || a.event_type === 'sell').length);
  assert.ok(trades.every((t) => t.token === AGENCY && t.amountUsd > 0 && t.ts > 1.7e9 && !t.route));
  assert.ok(trades.some((t) => t.side === 'sell'));
});
