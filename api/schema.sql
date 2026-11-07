-- grow. API database (Cloudflare D1, SQLite). Everything under "chain mirror" is rebuilt by the indexer from
-- contract events and can be dropped and re-indexed; the rest is user data that lives only here.
-- Amounts: *_raw columns hold exact decimal strings (yoctoNEAR, token base units); plain REAL columns hold the
-- same in NEAR / whole tokens for sorting and charts. Times are milliseconds.

-- ---------------------------------------------------------------- chain mirror

CREATE TABLE IF NOT EXISTS ix_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every applied event once, so re-reading a block never applies it twice.
CREATE TABLE IF NOT EXISTS events (
  receipt TEXT NOT NULL, idx INTEGER NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL,
  contract TEXT NOT NULL, standard TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (receipt, idx)
);
CREATE INDEX IF NOT EXISTS events_block ON events (block);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, account TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ticker TEXT NOT NULL,
  creator TEXT NOT NULL, co_dev TEXT, split_bps INTEGER NOT NULL DEFAULT 10000,
  reference TEXT, image TEXT, description TEXT, x TEXT, telegram TEXT, website TEXT, meta_done INTEGER NOT NULL DEFAULT 0,
  fee_bps INTEGER NOT NULL, redirect_pct INTEGER NOT NULL DEFAULT 0, redirect_to TEXT NOT NULL DEFAULT 'holders',
  dev_vault INTEGER, phase TEXT NOT NULL,
  near_reserve_raw TEXT NOT NULL, tok_reserve_raw TEXT NOT NULL, burned_raw TEXT NOT NULL DEFAULT '0',
  price REAL NOT NULL DEFAULT 0, mcap REAL NOT NULL DEFAULT 0, progress REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0, trades INTEGER NOT NULL DEFAULT 0, holders INTEGER NOT NULL DEFAULT 0,
  dev_fees REAL NOT NULL DEFAULT 0, holder_fees REAL NOT NULL DEFAULT 0, holder_pending REAL NOT NULL DEFAULT 0,
  buyback_pending REAL NOT NULL DEFAULT 0, burned_tokens REAL NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL, graduated_ts INTEGER, last_trade_ts INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT, parents TEXT, crossing_id INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_creator ON tokens (creator);
CREATE INDEX IF NOT EXISTS tokens_created ON tokens (created_ts);
CREATE INDEX IF NOT EXISTS tokens_mcap ON tokens (mcap);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT NOT NULL, token_id TEXT NOT NULL, account TEXT NOT NULL,
  side TEXT NOT NULL, near REAL NOT NULL, tokens REAL NOT NULL, fee REAL NOT NULL, price REAL NOT NULL, mcap REAL NOT NULL,
  ts INTEGER NOT NULL, block INTEGER NOT NULL, vault_id INTEGER, referrer TEXT
);
CREATE INDEX IF NOT EXISTS trades_token_ts ON trades (token_id, ts);
CREATE INDEX IF NOT EXISTS trades_account ON trades (account, ts);
CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);

-- Wallet balances from the tokens' NEP-141 events. Coins in vaults belong to vault owners and are in `vaults`.
CREATE TABLE IF NOT EXISTS balances (
  token_id TEXT NOT NULL, account TEXT NOT NULL, balance_raw TEXT NOT NULL, balance REAL NOT NULL,
  first_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  PRIMARY KEY (token_id, account)
);
CREATE INDEX IF NOT EXISTS balances_account ON balances (account);

CREATE TABLE IF NOT EXISTS vaults (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, agent TEXT NOT NULL, name TEXT NOT NULL,
  strategy TEXT NOT NULL, status TEXT NOT NULL, stop_reason TEXT,
  budget REAL NOT NULL, cash REAL NOT NULL, equity REAL NOT NULL, peak REAL NOT NULL,
  fire_bps INTEGER NOT NULL, daily_limit REAL NOT NULL, allowed TEXT NOT NULL, expires_ts INTEGER NOT NULL DEFAULT 0,
  leader INTEGER, per_trade REAL NOT NULL DEFAULT 0, trades INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  positions TEXT NOT NULL DEFAULT '[]', seq INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL, fired_ts INTEGER, art TEXT
);
CREATE INDEX IF NOT EXISTS vaults_owner ON vaults (owner);
CREATE INDEX IF NOT EXISTS vaults_leader ON vaults (leader);

CREATE TABLE IF NOT EXISTS vault_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id INTEGER NOT NULL, ts INTEGER NOT NULL, receipt TEXT NOT NULL,
  token_id TEXT NOT NULL, side TEXT NOT NULL, near REAL NOT NULL, tokens REAL NOT NULL, note TEXT, seq INTEGER, copied_from INTEGER
);
CREATE INDEX IF NOT EXISTS vault_log_vault ON vault_log (vault_id, ts);

CREATE TABLE IF NOT EXISTS vault_equity (vault_id INTEGER NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL, PRIMARY KEY (vault_id, ts));

CREATE TABLE IF NOT EXISTS crossings (
  id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, proposer TEXT NOT NULL, partner TEXT NOT NULL,
  split_bps INTEGER NOT NULL, name TEXT NOT NULL, ticker TEXT NOT NULL, status TEXT NOT NULL,
  ends_ts INTEGER NOT NULL DEFAULT 0, new_token TEXT, rate_a TEXT, rate_b TEXT, created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (account TEXT PRIMARY KEY, referrer TEXT NOT NULL, since_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer);
CREATE TABLE IF NOT EXISTS ref_earnings (referrer TEXT PRIMARY KEY, earned REAL NOT NULL DEFAULT 0, claimed REAL NOT NULL DEFAULT 0);

-- ---------------------------------------------------------------- user data

CREATE TABLE IF NOT EXISTS ref_codes (code TEXT PRIMARY KEY, account TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS profiles (
  account TEXT PRIMARY KEY, bio TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT 'sapling',
  x TEXT, tg TEXT, discord TEXT, updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_nonces (nonce TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT NOT NULL, account TEXT NOT NULL, text TEXT NOT NULL,
  ts INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_token ON comments (token_id, id);
CREATE INDEX IF NOT EXISTS comments_author ON comments (account, ts);
CREATE INDEX IF NOT EXISTS comments_ip ON comments (ip, ts);

CREATE TABLE IF NOT EXISTS favorites (account TEXT NOT NULL, token_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (account, token_id));

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, text TEXT NOT NULL, link TEXT NOT NULL, ts INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0, dedupe TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS notifications_account ON notifications (account, id);

-- Keys for agents people run themselves. Only a hash is stored; the key is shown once.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
  daily_limit REAL NOT NULL, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_used INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys (account);
CREATE TABLE IF NOT EXISTS api_key_vaults (vault_id INTEGER PRIMARY KEY, key_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_spend (key_id TEXT NOT NULL, day INTEGER NOT NULL, near REAL NOT NULL, PRIMARY KEY (key_id, day));

-- Strategy state per vault (last run, entry prices, targets hit).
CREATE TABLE IF NOT EXISTS agent_state (vault_id INTEGER PRIMARY KEY, last_run INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '{}');

-- Transactions the relayer and house funder send, one at a time per signer.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, signer TEXT NOT NULL, method TEXT NOT NULL, args TEXT NOT NULL,
  deposit TEXT NOT NULL DEFAULT '0', gas TEXT NOT NULL DEFAULT '100000000000000', status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, tx_hash TEXT, error TEXT, dedupe TEXT UNIQUE, created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id);

CREATE TABLE IF NOT EXISTS prices (key TEXT PRIMARY KEY, value REAL NOT NULL, ts INTEGER NOT NULL);
