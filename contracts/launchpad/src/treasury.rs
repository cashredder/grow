//! The token treasurer: a token's own gardener (a `Dev` vault, connected at launch and fed by the dev's share
//! of the trading fees) can spend its NEAR on the token, besides trading it:
//!
//! - `Buyback`: the NEAR goes to the token's buyback pool, which buys coins and burns them through `buyback`
//!   (once per block, within the usual caps), so the treasurer cannot move the price in one go.
//! - `Rewards`: the NEAR is added to the holders' rewards, paid out by `push_rewards` like fee rewards.
//! - `PayDev`: the NEAR goes to the dev (the vault owner), at most `MAX_PAY_BPS` of the cash per day.
//!
//! Only the vault's agent can do this, within the vault's daily limit. The NEAR leaves the vault on purpose,
//! so its start and peak go down by the same amount and the spending never counts as a trading loss.
use crate::events::{emit, s};
use crate::vault::{VaultKind, VaultStatus};
use crate::*;
use grow_common::{mul_div, BPS};
use near_sdk::serde_json::json;

/// Share of the treasurer's cash that can go to the dev in one day.
pub(crate) const MAX_PAY_BPS: u128 = 2_000;

#[near(serializers = [json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TreasuryAction {
    Buyback,
    Rewards,
    PayDev,
}

#[near]
impl Launchpad {
    /// Spends `amount` of the treasurer's NEAR on its token. Returns the cash left.
    pub fn treasury_action(&mut self, vault_id: u64, action: TreasuryAction, amount: U128, note: Option<String>) -> U128 {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.agent, "agent only");
        require!(v.kind == VaultKind::Dev, "only a token's own gardener manages its treasury");
        require!(v.status == VaultStatus::Active, "this gardener is not active");
        if let Some(n) = &note {
            require!(n.chars().count() <= 140, "note longer than 140 characters");
        }
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        require!(amount <= v.cash.0, "not enough NEAR in the treasury");
        let now = now_ms();
        let day = (now / DAY_MS) as u32;
        if v.day != day {
            v.day = day;
            v.spent_today = U128(0);
        }
        require!(v.spent_today.0.saturating_add(amount) <= v.daily_limit.0, "daily limit reached");
        let token_id = match &v.allowed {
            crate::vault::Allowed::Only(id) => id.clone(),
            _ => env::panic_str("this gardener has no token"),
        };
        let mut t = self.token(&token_id);
        require!(matches!(t.phase, Phase::Curve | Phase::Pool), "this token is not trading");
        match action {
            TreasuryAction::Buyback => t.buyback_pool = U128(t.buyback_pool.0 + amount),
            TreasuryAction::Rewards => t.pending_holders = U128(t.pending_holders.0 + amount),
            TreasuryAction::PayDev => {
                // Counted against the day's cash at its start, so it cannot be drained in small steps.
                let day_cash = v.cash.0 + v.spent_today.0;
                let paid = paid_today(vault_id, day) + amount;
                require!(paid <= mul_div(day_cash, MAX_PAY_BPS, BPS), "the dev can take at most 20% of the treasury a day");
                set_paid_today(vault_id, day, paid);
                Promise::new(v.owner.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
            }
        }
        v.cash = U128(v.cash.0 - amount);
        v.spent_today = U128(v.spent_today.0 + amount);
        v.start = U128(v.start.0.saturating_sub(amount));
        v.peak = U128(v.peak.0.saturating_sub(amount));
        let action_name = match action {
            TreasuryAction::Buyback => "buyback",
            TreasuryAction::Rewards => "rewards",
            TreasuryAction::PayDev => "pay_dev",
        };
        emit("treasury", json!({ "vault_id": vault_id, "token_id": token_id, "action": action_name, "near": s(amount), "cash": s(v.cash.0), "note": note }));
        self.put_token(t);
        let cash = v.cash;
        let equity = self.equity(&v);
        emit("vault_equity", json!({ "vault_id": vault_id, "equity": s(equity), "peak": s(v.peak.0), "cash": s(cash.0) }));
        self.vaults.insert(vault_id, v);
        cash
    }
}

// Paid to the dev today, per vault: plain storage under its own prefix (no change to the contract state).
fn paid_key(vault_id: u64) -> Vec<u8> {
    [b"pd:".as_slice(), &vault_id.to_le_bytes()].concat()
}

fn paid_today(vault_id: u64, day: u32) -> u128 {
    match env::storage_read(&paid_key(vault_id)) {
        Some(v) if v.len() == 20 && u32::from_le_bytes(v[..4].try_into().unwrap()) == day => u128::from_le_bytes(v[4..].try_into().unwrap()),
        _ => 0,
    }
}

fn set_paid_today(vault_id: u64, day: u32, paid: u128) {
    env::storage_write(&paid_key(vault_id), &[day.to_le_bytes().as_slice(), &paid.to_le_bytes()].concat());
}
