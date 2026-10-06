import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

// Ordered, append-only migrations. Never edit a shipped entry; add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE wallets (
    address TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    source TEXT NOT NULL,              -- gmgn_sm | gmgn_kol | discovery | manual
    twitter_username TEXT,
    twitter_name TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    is_kol INTEGER NOT NULL DEFAULT 0,
    tier TEXT,                         -- A | B | C | X | NULL
    score REAL,
    excluded_reason TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE trades (
    tx_hash TEXT NOT NULL,
    wallet TEXT NOT NULL,
    token TEXT NOT NULL,
    side TEXT NOT NULL,                -- buy | sell
    amount_usd REAL NOT NULL,
    price_usd REAL NOT NULL,
    token_amount REAL NOT NULL,
    buy_cost_usd REAL NOT NULL DEFAULT 0,
    is_open_or_close INTEGER NOT NULL, -- 1 = full open/close, 0 = partial (see docs/gmgn-fields.md)
    route INTEGER NOT NULL DEFAULT 0,  -- 1 = intermediate leg of a multi-hop swap
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,              -- gmgn_sm | gmgn_kol
    inserted_at INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, wallet, token, side)
  );
  CREATE INDEX trades_token_ts ON trades(token, ts);
  CREATE INDEX trades_wallet_ts ON trades(wallet, ts);
  CREATE INDEX trades_ts ON trades(ts);

  CREATE TABLE tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    logo TEXT,
    total_supply REAL,
    created_at INTEGER,
    launchpad TEXT,
    first_seen INTEGER NOT NULL,
    last_info_json TEXT,
    last_info_at INTEGER
  );

  CREATE TABLE buy_outcomes (
    tx_hash TEXT NOT NULL,
    wallet TEXT NOT NULL,
    token TEXT NOT NULL,
    buy_ts INTEGER NOT NULL,
    buy_price REAL NOT NULL,
    price_1h REAL,
    price_24h REAL,
    max_price_24h REAL,
    done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tx_hash, wallet, token)
  );
  CREATE INDEX buy_outcomes_pending ON buy_outcomes(done, buy_ts);

  CREATE TABLE wallet_metrics (
    wallet TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    n_buys INTEGER,
    hit_rate_2x_24h REAL,
    median_hold_sec REAL,
    trades_per_day REAL,
    pnl_7d REAL,
    pnl_30d REAL,
    winrate_30d REAL,
    kol_dump_rate REAL,
    raw_stats_json TEXT,
    PRIMARY KEY (wallet, computed_at)
  );

  CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    wallets_json TEXT NOT NULL,
    strength TEXT NOT NULL,
    mc_at_signal REAL,
    price_at_signal REAL,
    message_id INTEGER,
    status TEXT NOT NULL DEFAULT 'sent'
  );
  CREATE INDEX signals_token_type ON signals(token, type, created_at);

  CREATE TABLE signal_outcomes (
    signal_id INTEGER PRIMARY KEY REFERENCES signals(id),
    price_15m REAL,
    price_1h REAL,
    price_4h REAL,
    price_24h REAL,
    max_24h REAL,
    min_24h REAL
  );

  CREATE TABLE collector_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE poll_log (
    feed TEXT NOT NULL,
    ts INTEGER NOT NULL,
    records INTEGER NOT NULL,
    inserted INTEGER NOT NULL,
    span_sec INTEGER NOT NULL,
    overlap INTEGER NOT NULL,
    gap INTEGER NOT NULL,
    interval_sec REAL NOT NULL,
    error TEXT
  );
  CREATE INDEX poll_log_feed_ts ON poll_log(feed, ts);
  `,
  `
  -- Discovery: winner tokens we scanned and the early buyers found in them.
  CREATE TABLE discovery_tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    ath_mc REAL NOT NULL,
    mc REAL,
    supply REAL,
    created_at INTEGER,
    processed_at INTEGER NOT NULL,
    traders INTEGER NOT NULL,
    hits INTEGER NOT NULL
  );
  CREATE TABLE discovery_hits (
    wallet TEXT NOT NULL,
    token TEXT NOT NULL,
    entry_ratio REAL NOT NULL,         -- avg entry market cap / ATH market cap
    profit REAL NOT NULL,
    cost REAL NOT NULL,
    start_ts INTEGER,
    found_at INTEGER NOT NULL,
    PRIMARY KEY (wallet, token)
  );
  CREATE INDEX discovery_hits_wallet ON discovery_hits(wallet);
  ALTER TABLE wallets ADD COLUMN discovered_at INTEGER;
  -- Last activity backfill per wallet.
  CREATE TABLE wallet_sync (
    wallet TEXT PRIMARY KEY,
    synced_at INTEGER NOT NULL,
    newest_ts INTEGER,
    trades INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- Known route tokens are never signals, even as a single-leg trade.
  UPDATE trades SET route = 1 WHERE route = 0 AND token IN (
    'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  `,
  `
  -- Discovery also keeps GMGN-tagged profitable traders that entered late.
  ALTER TABLE discovery_hits ADD COLUMN kind TEXT NOT NULL DEFAULT 'early';
  ALTER TABLE discovery_hits ADD COLUMN tags_json TEXT;
  ALTER TABLE discovery_hits ADD COLUMN twitter TEXT;
  `,
];

export function openDb(dataDir: string, file = 'swa.sqlite'): DB {
  let db: DB;
  if (file === ':memory:') {
    db = new Database(':memory:');
  } else {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, file));
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[index]!);
      db.pragma(`user_version = ${index + 1}`);
    })();
  }
}

export function getState(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM collector_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO collector_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
