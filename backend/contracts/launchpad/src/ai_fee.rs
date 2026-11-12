//! Paying for AI: a gardener that decides with NEAR AI pays a small fixed fee per decision into the AI fund,
//! which the platform spends on NEAR AI credits. grow.'s own (House) gardeners are paid by the platform and
//! never charged; holder rewards are never touched.
//!
//! - Only the vault's agent can charge, at most once per `MIN_GAP_MS` per vault, and only the fee the owner
//!   set (`set_ai_fee`, capped at `MAX_AI_FEE`).
//! - For a token's treasurer the fee is spending like its other actions (start and peak go down with it); for
//!   traders it is a real cost and shows in their results.
//!
//! The fee, the fund and each vault's last charge live in plain storage under their own keys, so adding them
//! changed nothing in the contract state.
use crate::events::{emit, s};
use crate::vault::{VaultKind, VaultStatus};
use crate::*;
use near_sdk::serde_json::json;

pub(crate) const MAX_AI_FEE: u128 = ONE_NEAR / 100;
const DEFAULT_AI_FEE: u128 = ONE_NEAR / 1_000;
const MIN_GAP_MS: u64 = 5 * 60_000;
const FEE_KEY: &[u8] = b"ai:fee";
const FUND_KEY: &[u8] = b"ai:fund";

fn read_u128(key: &[u8]) -> Option<u128> {
    env::storage_read(key).and_then(|v| v.try_into().ok()).map(u128::from_le_bytes)
}

fn last_key(vault_id: u64) -> Vec<u8> {
    [b"ai:last:".as_slice(), &vault_id.to_le_bytes()].concat()
}

#[near]
impl Launchpad {
    /// NEAR charged per AI decision.
    pub fn ai_fee(&self) -> U128 {
        U128(read_u128(FEE_KEY).unwrap_or(DEFAULT_AI_FEE))
    }

    /// NEAR collected for AI credits and not yet claimed.
    pub fn ai_fund(&self) -> U128 {
        U128(read_u128(FUND_KEY).unwrap_or(0))
    }

    pub fn set_ai_fee(&mut self, fee: U128) {
        self.only_owner();
        require!(fee.0 <= MAX_AI_FEE, "the AI fee is capped at 0.01 NEAR");
        env::storage_write(FEE_KEY, &fee.0.to_le_bytes());
        emit("ai_fee_set", json!({ "fee": s(fee.0) }));
    }

    /// Charges one AI decision (`decision`: the API's decision id, for the record). Returns the cash left.
    pub fn pay_ai(&mut self, vault_id: u64, decision: u64) -> U128 {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.agent, "agent only");
        require!(matches!(v.kind, VaultKind::User | VaultKind::Dev), "grow.'s own gardeners do not pay for AI");
        require!(v.status == VaultStatus::Active, "this gardener is not active");
        let now = now_ms();
        let last = env::storage_read(&last_key(vault_id)).and_then(|b| b.try_into().ok()).map(u64::from_le_bytes).unwrap_or(0);
        require!(now >= last + MIN_GAP_MS, "one AI fee per 5 minutes");
        let fee = self.ai_fee().0;
        require!(fee > 0 && fee <= v.cash.0, "not enough NEAR for the AI fee");
        v.cash = U128(v.cash.0 - fee);
        if v.kind == VaultKind::Dev {
            v.start = U128(v.start.0.saturating_sub(fee));
            v.peak = U128(v.peak.0.saturating_sub(fee));
        }
        env::storage_write(&last_key(vault_id), &now.to_le_bytes());
        let fund = self.ai_fund().0 + fee;
        env::storage_write(FUND_KEY, &fund.to_le_bytes());
        emit("ai_fee", json!({ "vault_id": vault_id, "decision": decision, "near": s(fee), "cash": s(v.cash.0), "fund": s(fund) }));
        let equity = self.equity(&v);
        emit("vault_equity", json!({ "vault_id": vault_id, "equity": s(equity), "peak": s(v.peak.0), "cash": s(v.cash.0) }));
        let cash = v.cash;
        self.vaults.insert(vault_id, v);
        cash
    }

    /// Sends the AI fund to the treasury, which buys NEAR AI credits with it.
    pub fn claim_ai_fund(&mut self) -> Promise {
        self.only_owner();
        let fund = self.ai_fund().0;
        require!(fund > 0, "the AI fund is empty");
        env::storage_write(FUND_KEY, &0u128.to_le_bytes());
        emit("ai_fund_claimed", json!({ "amount": s(fund), "to": self.treasury }));
        Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(fund))
    }
}
