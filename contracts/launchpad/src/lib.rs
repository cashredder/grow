//! grow. launchpad (`grow.near`).
//!
//! One contract runs every token's market: the bonding curve on virtual reserves, the pool a token moves into
//! when its curve sells out (liquidity locked forever: there are no LP shares at all), the fee split, referrals,
//! buybacks, crossings of two tokens into one, and gardener vaults (agents that trade within on-chain limits).
//! Each token is its own NEP-141 contract at `<id>.grow.near` (see `contracts/token`), holding the supply that
//! is not in someone's wallet on this contract's balance.
//!
//! Rules that hold for every method:
//! - The owner can change settings for future launches within hard caps, pause new launches and point the
//!   treasury somewhere. It can never move curve or pool NEAR, user credits or vault funds.
//! - Every payout except a trader's own proceeds and refunds is credited and pulled.
//! - Amounts are yoctoNEAR and token base units (18 decimals). Times are milliseconds.
mod create;
mod cross;
mod events;
mod market;
mod quick;
mod treasury;
mod vault;

#[cfg(test)]
mod tests;

pub use cross::{CrossStatus, Crossing};
pub use vault::{Allowed, LeaderTrade, Position, Vault, VaultKind, VaultStatus};

use grow_common::{CURVE_END_TOKENS, ONE_NEAR, SUPPLY, VIRTUAL_NEAR, VIRTUAL_TOKENS};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, CryptoHash, NearToken, PanicOnDefault, Promise};

pub const STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR, the token's registration fee
pub const DAY_MS: u64 = 86_400_000;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
pub enum Key {
    Tokens,
    Registered,
    Credits,
    Referrers,
    PendingTokens,
    Crossings,
    Vaults,
    LeaderTrades,
    Copied,
    TokenCode,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// The token contract is being created.
    Deploying,
    Curve,
    Pool,
    /// Accepted crossing whose new token is being deployed: no trading.
    Merging,
    /// Replaced by a crossed token; holders convert at `merge_rate`.
    Merged,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TokenState {
    pub id: String,
    pub account: AccountId,
    pub name: String,
    pub ticker: String,
    pub reference: Option<String>,
    pub creator: AccountId,
    pub co_dev: Option<AccountId>,
    /// Creator's share of dev rewards after a crossing (bps); the co-dev gets the rest.
    pub split_bps: u16,
    pub fee_bps: u16,
    pub created_ms: U64,
    pub phase: Phase,
    /// Curve: virtual NEAR + raised. Pool: real NEAR.
    pub near_reserve: U128,
    pub tok_reserve: U128,
    pub burned: U128,
    /// Coins held inside gardener vaults (owned by users, kept on this contract).
    pub vault_held: U128,
    pub redirect_pct: u8,
    pub redirect_to_holders: bool,
    pub dev_vault: Option<u64>,
    pub dev_earned: U128,
    pub dev_claimed: U128,
    pub vest_until_ms: U64,
    /// Holders' fee share waiting to be pushed to the token contract.
    pub pending_holders: U128,
    pub buyback_pool: U128,
    /// NEAR in the pool when it opened, caps each buyback.
    pub pool_open_near: U128,
    pub last_buyback_block: U64,
    /// Sum of spot price (e18) x elapsed ms, for time-weighted prices.
    pub price_cum: U128,
    pub price_ts: U64,
    pub crossing: Option<u64>,
    pub merged_into: Option<String>,
    /// New-token units per old-token unit, scaled by 1e18.
    pub merge_rate: U128,
    pub parents: Option<(String, String)>,
    pub volume: U128,
    pub trades: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    pub create_fee: U128,
    /// NEAR sent to each new token account for its storage.
    pub token_storage: U128,
    pub max_fee_bps: u16,
    pub default_fee_bps: u16,
    pub pool_fee_bps: u16,
    pub sniper_window_ms: U64,
    pub sniper_start_bps: u16,
    /// Max share of supply a dev can buy at launch (bps).
    pub max_dev_buy_bps: u16,
    pub referral_days: u32,
    pub cross_window_ms: U64,
    pub cross_vest_ms: U64,
    /// Holder rewards are pushed to the token contract once at least this much is waiting.
    pub min_push: U128,
    pub house_fire_bps: u16,
    pub dev_vault_daily_limit: U128,
    pub copy_max_delay_ms: U64,
    pub max_positions: u8,
    pub launches_paused: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            create_fee: U128(ONE_NEAR),
            token_storage: U128(ONE_NEAR / 2),
            max_fee_bps: 500,
            default_fee_bps: 100,
            pool_fee_bps: 50,
            sniper_window_ms: U64(60_000),
            sniper_start_bps: 5_000,
            max_dev_buy_bps: 1_000,
            referral_days: 90,
            cross_window_ms: U64(DAY_MS),
            cross_vest_ms: U64(30 * DAY_MS),
            min_push: U128(ONE_NEAR / 10),
            house_fire_bps: 3_000,
            dev_vault_daily_limit: U128(100 * ONE_NEAR),
            copy_max_delay_ms: U64(120_000),
            max_positions: 12,
            launches_paused: false,
        }
    }
}

/// Hard caps the owner can never go past.
const CAP_CREATE_FEE: u128 = 10 * ONE_NEAR;
const CAP_FEE_BPS: u16 = 500;
const CAP_POOL_FEE_BPS: u16 = 100;
const CAP_SNIPER_BPS: u16 = 5_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Referral {
    pub referrer: AccountId,
    pub since_ms: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Launchpad {
    pub owner: AccountId,
    pub treasury: AccountId,
    /// Signs house and copy trades, and API agents' trades. Holds only function-call keys in production.
    pub relayer: AccountId,
    /// May open house gardeners with its own NEAR (replacing fired ones), and nothing else.
    pub house_funder: AccountId,
    pub config: Config,
    /// Hash of the token code published as a NEAR global contract; when unset, `token_code` is deployed.
    pub token_code_hash: Option<CryptoHash>,
    pub token_code: LookupMap<u8, Vec<u8>>,
    pub tokens: IterableMap<String, TokenState>,
    pub next_token: u64,
    /// `token:account` pairs already registered (storage paid) on a token contract.
    pub registered: LookupSet<String>,
    pub credits: LookupMap<AccountId, U128>,
    pub platform_earned: U128,
    pub referrers: LookupMap<AccountId, Referral>,
    /// Coins bought whose transfer failed, kept for the buyer: `token:account`.
    pub pending_tokens: LookupMap<String, U128>,
    pub crossings: IterableMap<u64, Crossing>,
    pub next_cross: u64,
    pub vaults: IterableMap<u64, Vault>,
    pub next_vault: u64,
    pub leader_trades: LookupMap<u64, Vec<LeaderTrade>>,
    /// `copy_id:seq` already copied.
    pub copied: LookupSet<String>,
}

/// Whether the promise this callback waits on succeeded.
pub(crate) fn promise_ok() -> bool {
    env::promise_result_checked(0, 16_384).is_ok()
}

pub(crate) fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

pub(crate) fn reg_key(token: &str, account: &AccountId) -> String {
    format!("{token}:{account}")
}

#[near]
impl Launchpad {
    #[init]
    pub fn new(owner: AccountId, treasury: AccountId, relayer: AccountId) -> Self {
        Self {
            owner: owner.clone(),
            treasury,
            relayer,
            house_funder: owner.clone(),
            config: Config::default(),
            token_code_hash: None,
            token_code: LookupMap::new(Key::TokenCode),
            tokens: IterableMap::new(Key::Tokens),
            next_token: 1,
            registered: LookupSet::new(Key::Registered),
            credits: LookupMap::new(Key::Credits),
            platform_earned: U128(0),
            referrers: LookupMap::new(Key::Referrers),
            pending_tokens: LookupMap::new(Key::PendingTokens),
            crossings: IterableMap::new(Key::Crossings),
            next_cross: 1,
            vaults: IterableMap::new(Key::Vaults),
            next_vault: 1,
            leader_trades: LookupMap::new(Key::LeaderTrades),
            copied: LookupSet::new(Key::Copied),
        }
    }

    // ---------------------------------------------------------------- owner

    pub fn set_config(&mut self, config: Config) {
        self.only_owner();
        require!(config.create_fee.0 <= CAP_CREATE_FEE, "create fee above the cap");
        require!(config.max_fee_bps <= CAP_FEE_BPS && config.default_fee_bps <= config.max_fee_bps, "fee above the cap");
        require!(config.pool_fee_bps <= CAP_POOL_FEE_BPS, "pool fee above the cap");
        require!(config.sniper_start_bps <= CAP_SNIPER_BPS, "launch fee above the cap");
        require!(config.sniper_window_ms.0 <= 600_000, "launch window above 10 minutes");
        require!(config.max_dev_buy_bps <= 2_000, "dev buy above 20%");
        require!(config.house_fire_bps >= 500 && config.house_fire_bps <= 9_000, "fire threshold out of range");
        require!(config.cross_window_ms.0 >= 60_000, "crossing window too short");
        self.config = config;
    }

    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.only_owner();
        self.treasury = treasury;
    }

    pub fn set_relayer(&mut self, relayer: AccountId) {
        self.only_owner();
        self.relayer = relayer;
    }

    pub fn set_house_funder(&mut self, house_funder: AccountId) {
        self.only_owner();
        self.house_funder = house_funder;
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.only_owner();
        self.owner = owner;
    }

    /// Code of the token contract, used when no global contract hash is set.
    pub fn set_token_code(&mut self) {
        self.only_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("send the wasm as the input"));
        require!(code.len() > 1_000, "that is not a contract");
        self.token_code.insert(0, code);
    }

    /// Hash (base58) of the token code published with `deploy_global_contract`; cheaper launches.
    pub fn set_token_code_hash(&mut self, hash: Option<near_sdk::json_types::Base58CryptoHash>) {
        self.only_owner();
        self.token_code_hash = hash.map(|h| h.into());
    }

    /// Sends the platform's earnings to the treasury.
    pub fn claim_platform(&mut self) -> Promise {
        let amount = self.platform_earned.0;
        require!(amount > 0, "nothing to claim");
        self.platform_earned = U128(0);
        Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_token(&self, token_id: String) -> Option<TokenState> {
        self.tokens.get(&token_id).cloned()
    }

    pub fn list_tokens(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<TokenState> {
        self.tokens.values().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(200) as usize).cloned().collect()
    }

    pub fn tokens_count(&self) -> u32 {
        self.tokens.len()
    }

    pub fn credits_of(&self, account_id: AccountId) -> U128 {
        self.credits.get(&account_id).cloned().unwrap_or(U128(0))
    }

    pub fn referrer_of(&self, account_id: AccountId) -> Option<Referral> {
        self.referrers.get(&account_id).cloned()
    }

    pub fn pending_tokens_of(&self, token_id: String, account_id: AccountId) -> U128 {
        self.pending_tokens.get(&reg_key(&token_id, &account_id)).cloned().unwrap_or(U128(0))
    }

    pub fn platform_earnings(&self) -> U128 {
        self.platform_earned
    }

    /// Spot price as NEAR base units per token base unit, scaled by 1e18.
    pub fn price_e18(&self, token_id: String) -> U128 {
        U128(spot_e18(&self.token(&token_id)))
    }

    // ---------------------------------------------------------------- shared helpers

    pub(crate) fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    pub(crate) fn token(&self, id: &str) -> TokenState {
        self.tokens.get(id).cloned().unwrap_or_else(|| env::panic_str("no such token"))
    }

    pub(crate) fn put_token(&mut self, t: TokenState) {
        self.tokens.insert(t.id.clone(), t);
    }

    pub(crate) fn credit(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let v = self.credits.get(account).map(|c| c.0).unwrap_or(0);
        self.credits.insert(account.clone(), U128(v + amount));
    }
}

/// Spot price, NEAR units per token unit, scaled by 1e18.
pub(crate) fn spot_e18(t: &TokenState) -> u128 {
    if t.tok_reserve.0 == 0 {
        return 0;
    }
    grow_common::mul_div(t.near_reserve.0, 1_000_000_000_000_000_000, t.tok_reserve.0)
}

/// Coins of `t` sitting in the curve or pool on this contract (not counting vault positions).
pub(crate) fn market_inventory(t: &TokenState) -> u128 {
    if on_curve(t) { t.tok_reserve.0 - (VIRTUAL_TOKENS - SUPPLY) } else { t.tok_reserve.0 }
}

/// Whether the market still runs on the bonding curve (virtual reserves). A token being merged keeps the kind
/// of market it had: one that never opened a pool was on the curve.
pub(crate) fn on_curve(t: &TokenState) -> bool {
    match t.phase {
        Phase::Curve | Phase::Deploying => true,
        Phase::Merging => t.pool_open_near.0 == 0,
        _ => false,
    }
}

/// Real NEAR backing the market: raised on the curve or the pool's reserve.
pub(crate) fn market_near(t: &TokenState) -> u128 {
    if on_curve(t) { t.near_reserve.0 - VIRTUAL_NEAR } else { t.near_reserve.0 }
}

