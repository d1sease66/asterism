import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../dist/db.js';
import { SignalEngine, strengthFor } from '../dist/signals/engine.js';
import { rejectReasons, factsFrom } from '../dist/signals/filters.js';
import { formatSignal } from '../dist/signals/format.js';
import { holdDurations, median, combine, tierFor, evidence, dumpRate, percentileRanks } from '../dist/scorer/scorer.js';
import { exclusionByTags } from '../dist/rules.js';

const NOW = 1_800_000_000;
const TOKEN = 'TokenAddr1111111111111111111111111111111111';
const GOOD = { symbol: 'GOOD', price: 0.001, mc: 420_000, liquidity: 86_000, ageSec: 3 * 3600, bundler: 0.12, renounced: true, holders: 900, logo: null, fetchedAt: NOW };

function setup({ facts = GOOD } = {}) {
  const db = openDb('', ':memory:');
  const sent = [];
  const edits = [];
  const telegram = {
    broadcast: async (text) => { sent.push(text); return { '42': sent.length }; },
    edit: async (chat, id, text) => { edits.push({ chat, id, text }); },
  };
  let calls = 0;
  const checker = { facts: async () => { calls += 1; return facts; } };
  const engine = new SignalEngine(db, checker, telegram);
  const wallet = (address, tier, extra = {}) => db.prepare(`INSERT INTO wallets (address, first_seen, last_seen, source, tags_json, is_kol, tier, updated_at, twitter_username)
    VALUES (?, ?, ?, 'gmgn_sm', '[]', ?, ?, ?, ?)`).run(address, NOW, NOW, extra.kol ? 1 : 0, tier, NOW, extra.twitter ?? null);
  let n = 0;
  const trade = (address, side, usd, ts, full = 1) => db.prepare(`INSERT INTO trades (tx_hash, wallet, token, side, amount_usd, price_usd, token_amount, is_open_or_close, ts, source, inserted_at)
    VALUES (?, ?, ?, ?, ?, 0.001, 1, ?, ?, 'gmgn_sm', ?)`).run(`tx${n++}`, address, TOKEN, side, usd, full, ts, ts);
  return { db, engine, sent, edits, wallet, trade, calls: () => calls };
}

test('cluster: 3 A/B wallets buying ≥ $300 within 30 min sends one alert', async () => {
  const t = setup();
  ['A1', 'A2', 'B1'].forEach((w, i) => { t.wallet(w, i < 2 ? 'A' : 'B'); t.trade(w, 'buy', 500, NOW - 600 + i * 60); });
  await t.engine.checkCluster(TOKEN, NOW);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0], /Cluster: <b>\$GOOD<\/b> · 3 smart wallets/);
  const row = t.db.prepare('SELECT type, strength, status FROM signals').get();
  assert.deepEqual({ ...row }, { type: 'cluster', strength: 'strong', status: 'sent' });
});

test('cluster: C-tier, small buys and buys outside the window do not count', async () => {
  const t = setup();
  t.wallet('A1', 'A'); t.trade('A1', 'buy', 500, NOW - 100);
  t.wallet('A2', 'A'); t.trade('A2', 'buy', 200, NOW - 100);          // below $300
  t.wallet('B1', 'B'); t.trade('B1', 'buy', 500, NOW - 40 * 60);      // outside 30 min
  t.wallet('C1', 'C'); t.trade('C1', 'buy', 900, NOW - 100);          // C tier
  await t.engine.checkCluster(TOKEN, NOW);
  assert.equal(t.sent.length, 0);
  assert.equal(t.calls(), 0, 'no API call when there is no cluster');
});

test('antispam: same cluster within the cooldown is not resent; growth edits the original', async () => {
  const t = setup();
  ['A1', 'A2', 'B1'].forEach((w) => { t.wallet(w, 'A'); t.trade(w, 'buy', 500, NOW - 300); });
  await t.engine.checkCluster(TOKEN, NOW);
  await t.engine.checkCluster(TOKEN, NOW + 60);
  assert.equal(t.sent.length, 1);
  assert.equal(t.edits.length, 0);
  ['B2', 'B3'].forEach((w) => { t.wallet(w, 'B'); t.trade(w, 'buy', 700, NOW + 100); });
  await t.engine.checkCluster(TOKEN, NOW + 120);
  assert.equal(t.sent.length, 1, 'no second message');
  assert.equal(t.edits.length, 1);
  assert.match(t.edits[0].text, /5 smart wallets/);
  assert.match(t.edits[0].text, /cluster grew/);
  assert.equal(t.db.prepare('SELECT strength FROM signals').get().strength, 'very_strong');
});

test('cluster + KOL: a non-dumping KOL in the window upgrades the type', async () => {
  const t = setup();
  ['A1', 'A2', 'B1'].forEach((w) => { t.wallet(w, 'A'); t.trade(w, 'buy', 500, NOW - 300); });
  t.wallet('K1', 'C', { kol: true, twitter: 'kolguy' }); t.trade('K1', 'buy', 1500, NOW - 200);
  await t.engine.checkCluster(TOKEN, NOW);
  assert.match(t.sent[0], /Cluster \+ KOL/);
  assert.match(t.sent[0], /KOL @kolguy/);
  assert.equal(t.db.prepare('SELECT strength FROM signals').get().strength, 'very_strong');
});

test('filters: a failing token is recorded as filtered and not sent', async () => {
  const t = setup({ facts: { ...GOOD, mc: 10_000 } });
  ['A1', 'A2', 'B1'].forEach((w) => { t.wallet(w, 'A'); t.trade(w, 'buy', 500, NOW - 300); });
  await t.engine.checkCluster(TOKEN, NOW);
  assert.equal(t.sent.length, 0);
  const row = t.db.prepare('SELECT status, text FROM signals').get();
  assert.equal(row.status, 'filtered');
  assert.match(row.text, /mc</);
  await t.engine.checkCluster(TOKEN, NOW + 30);
  assert.equal(t.calls(), 1, 'filtered token is not re-checked until the cluster grows');
});

test('muted tokens are skipped', async () => {
  const t = setup();
  ['A1', 'A2', 'B1'].forEach((w) => { t.wallet(w, 'A'); t.trade(w, 'buy', 500, NOW - 300); });
  t.db.prepare('INSERT INTO muted_tokens (token, until) VALUES (?, ?)').run(TOKEN, NOW + 3600);
  await t.engine.checkCluster(TOKEN, NOW);
  assert.equal(t.sent.length, 0);
});

test('exit cluster only fires for a token that had a signal in the last 48 h', async () => {
  const t = setup();
  ['A1', 'A2', 'B1'].forEach((w) => { t.wallet(w, 'A'); t.trade(w, 'sell', 400, NOW - 300, 1); });
  await t.engine.checkExit(TOKEN, NOW);
  assert.equal(t.sent.length, 0);
  t.db.prepare(`INSERT INTO signals (type, token, created_at, updated_at, wallets_json, strength, status) VALUES ('cluster', ?, ?, ?, '[]', 'strong', 'sent')`).run(TOKEN, NOW - 3600, NOW - 3600);
  await t.engine.checkExit(TOKEN, NOW);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0], /Exit cluster/);
});

test('rejectReasons follows the spec thresholds', () => {
  assert.deepEqual(rejectReasons(GOOD), []);
  assert.ok(rejectReasons({ ...GOOD, liquidity: 5_000 }).some((r) => r.startsWith('liq')));
  assert.ok(rejectReasons({ ...GOOD, ageSec: 120 }).includes('age<10m'));
  assert.ok(rejectReasons({ ...GOOD, renounced: false }).some((r) => r.includes('renounced')));
  assert.ok(rejectReasons({ ...GOOD, bundler: 0.45 }).some((r) => r.startsWith('bundlers')));
  assert.ok(rejectReasons({ ...GOOD, mc: 25_000_000 }).some((r) => r.startsWith('mc>')));
});

test('factsFrom reads the real token info / security shapes', () => {
  const info = { symbol: 'X', price: { price: '0.01' }, circulating_supply: '1000000', liquidity: 50000, creation_timestamp: NOW - 7200, stat: { top_bundler_trader_percentage: '0.3058' }, holder_count: 10 };
  const facts = factsFrom(info, { renounced_mint: true, renounced_freeze_account: true }, NOW);
  assert.equal(facts.mc, 10_000);
  assert.equal(facts.ageSec, 7200);
  assert.equal(facts.bundler, 0.3058);
  assert.equal(facts.renounced, true);
  assert.equal(factsFrom(info, {}, NOW).renounced, null);
});

test('alert text has the spec parts and escapes symbols', () => {
  const text = formatSignal('cluster', TOKEN, { ...GOOD, symbol: '<b>' }, [
    { wallet: 'A1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tier: 'A', usd: 2100, ts: NOW, kol: false, twitter: null, hit: 0.61, earlyN: 0, pnl30: null },
  ]);
  assert.match(text, /&lt;b&gt;/);
  assert.match(text, /MC \$420k · liq \$86k · age 3h · bundlers 12% · mint\/freeze renounced/);
  assert.match(text, /A · hit 61% · \$2\.1k/);
  assert.match(text, new RegExp(`<code>${TOKEN}</code>`));
  assert.match(text, /Not investment advice/);
});

test('strength: ≥ 5 wallets or a KOL is very strong; first entry is medium; exit is a warning', () => {
  assert.equal(strengthFor('cluster', 3), 'strong');
  assert.equal(strengthFor('cluster', 5), 'very_strong');
  assert.equal(strengthFor('cluster_kol', 3), 'very_strong');
  assert.equal(strengthFor('a_first_entry', 1), 'medium');
  assert.equal(strengthFor('exit_cluster', 3), 'warning');
});

test('scorer: holds, median, dump rate', () => {
  const trades = [
    { token: 'T', side: 'buy', ts: 0, full: 1, usd: 100 }, { token: 'T', side: 'buy', ts: 50, full: 0, usd: 100 },
    { token: 'T', side: 'sell', ts: 100, full: 1, usd: 300 }, { token: 'U', side: 'buy', ts: 200, full: 1, usd: 100 },
    { token: 'U', side: 'sell', ts: 230, full: 0, usd: 50 }, { token: 'U', side: 'sell', ts: 4000, full: 1, usd: 50 },
  ];
  assert.deepEqual(holdDurations(trades), [100, 3800]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(dumpRate(trades), null, 'too few buys');
  const dumper = [0, 1, 2].flatMap((i) => [{ token: `T${i}`, side: 'buy', ts: i * 10_000, full: 1, usd: 1 }, { token: `T${i}`, side: 'sell', ts: i * 10_000 + 600, full: 1, usd: 1 }]);
  assert.equal(dumpRate(dumper), 1);
});

test('scorer: missing components renormalise; freshness alone gives no score', () => {
  assert.equal(combine({ hit: null, pnl: null, winrate: null, fresh: 1 }), null);
  const s = combine({ hit: 1, pnl: 0, winrate: null, fresh: 1 });
  assert.ok(Math.abs(s - (0.45 + 0.1) / 0.8) < 1e-9);
  assert.equal(evidence(0, 0), null);
  assert.equal(evidence(3, 0), 1);
  assert.deepEqual(percentileRanks([10, 30, 20]), [0, 1, 0.5]);
});

test('scorer: tiers split 15% / 25% / rest', () => {
  const tiers = Array.from({ length: 20 }, (_, i) => tierFor(i, 20));
  assert.equal(tiers.filter((t) => t === 'A').length, 3);
  assert.equal(tiers.filter((t) => t === 'B').length, 5);
  assert.equal(tiers.filter((t) => t === 'C').length, 12);
});

test('KOLs are not excluded for the arbitrager tag alone; others are', () => {
  assert.equal(exclusionByTags(['kol', 'arbitrager']), undefined);
  assert.equal(exclusionByTags(['smart_degen', 'arbitrager']), 'tag:arbitrager');
  assert.equal(exclusionByTags(['kol', 'wash_trader']), 'tag:wash_trader');
});
