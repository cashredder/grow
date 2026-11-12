//! Quick trading: a NEAR balance on the launchpad that buys and sells without a wallet approval each time.
//!
//! The holder deposits once (`deposit_trade`) and gives the site a key limited to `quick_buy` and `quick_sell`
//! on this contract (such keys cannot attach NEAR, which `buy` and `ft_transfer_call` need). Buys are paid from
//! the balance and the coins go to the holder's own wallet, so hold rewards work as usual. Sells pull the coins
//! through the token's `launchpad_sell`, only for the account that signed `quick_sell`, and pay into the
//! balance. Withdrawing needs 1 yoctoNEAR, so only a full-access key (the wallet) can take NEAR out.
//!
//! Balances live in plain storage under their own prefix, so adding them changed nothing in the contract state.
use crate::events::{emit, s};
use crate::*;
use near_sdk::serde_json::json;
use near_sdk::Gas;

const PREFIX: &[u8] = b"tb:";
const GAS_QUICK_SELL: Gas = Gas::from_tgas(150);
/// A first deposit pays for its storage entry (about 100 bytes).
pub(crate) const MIN_DEPOSIT: u128 = ONE_NEAR / 100;

fn key(a: &AccountId) -> Vec<u8> {
    [PREFIX, a.as_bytes()].concat()
}

impl Launchpad {
    pub(crate) fn balance_get(&self, a: &AccountId) -> u128 {
        env::storage_read(&key(a)).map(|v| u128::from_le_bytes(v.try_into().unwrap_or([0; 16]))).unwrap_or(0)
    }

    fn balance_set(&mut self, a: &AccountId, v: u128) {
        env::storage_write(&key(a), &v.to_le_bytes());
    }

    pub(crate) fn balance_add(&mut self, a: &AccountId, amount: u128, reason: &str) {
        let v = self.balance_get(a) + amount;
        self.balance_set(a, v);
        emit("trade_balance", json!({ "account_id": a, "change": s(amount), "out": false, "balance": s(v), "reason": reason }));
    }

    fn balance_take(&mut self, a: &AccountId, amount: u128, reason: &str) {
        let v = self.balance_get(a);
        require!(amount <= v, "not enough on your trading balance");
        self.balance_set(a, v - amount);
        emit("trade_balance", json!({ "account_id": a, "change": s(amount), "out": true, "balance": s(v - amount), "reason": reason }));
    }
}

#[near]
impl Launchpad {
    /// Adds the attached NEAR to your trading balance. Returns the new balance.
    #[payable]
    pub fn deposit_trade(&mut self) -> U128 {
        let a = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_DEPOSIT || (amount > 0 && env::storage_has_key(&key(&a))), "deposit at least 0.01 NEAR");
        self.balance_add(&a, amount, "deposit");
        U128(self.balance_get(&a))
    }

    /// Sends NEAR from your trading balance to your wallet (all of it without `amount`). Needs 1 yoctoNEAR.
    #[payable]
    pub fn withdraw_trade(&mut self, amount: Option<U128>) -> Promise {
        near_sdk::assert_one_yocto();
        let a = env::predecessor_account_id();
        let amount = amount.map(|v| v.0).unwrap_or_else(|| self.balance_get(&a));
        require!(amount > 0, "nothing to withdraw");
        self.balance_take(&a, amount, "withdraw");
        Promise::new(a).transfer(NearToken::from_yoctonear(amount + 1))
    }

    pub fn trade_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance_get(&account_id))
    }

    /// Buys with `amount` NEAR from your trading balance (the first buy of a token also pays its registration
    /// from it). The coins go to your wallet.
    pub fn quick_buy(&mut self, token_id: String, amount: U128, min_out: U128, referrer: Option<AccountId>) -> Promise {
        let buyer = env::predecessor_account_id();
        require!(amount.0 > 0, "amount must be positive");
        self.balance_take(&buyer, amount.0, "buy");
        self.buy_core(&token_id, &buyer, amount.0, min_out.0, referrer, true)
    }

    /// Sells `amount` of your coins; the NEAR goes to your trading balance. Tokens launched before quick
    /// trading (`grow_token_version` below 2) cannot do this: sell them from the wallet.
    pub fn quick_sell(&mut self, token_id: String, amount: U128, min_out: U128) -> Promise {
        let seller = env::predecessor_account_id();
        require!(env::prepaid_gas() >= GAS_QUICK_SELL, "attach at least 150 Tgas");
        let t = self.token(&token_id);
        require!(matches!(t.phase, Phase::Curve | Phase::Pool), "this token is not trading");
        let msg = json!({ "action": "sell", "min_out": min_out, "to_balance": true }).to_string();
        Promise::new(t.account.clone()).function_call(
            "launchpad_sell",
            json!({ "owner_id": seller, "amount": amount, "msg": msg }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            env::prepaid_gas().saturating_sub(Gas::from_tgas(15)),
        )
    }
}
