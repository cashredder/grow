//! Buying, selling, fees, referrals, holder-reward pushes, buybacks and payouts.
use crate::events::{emit, s};
use crate::*;
use grow_common::{fee_bps_at, mul_div, mul_div_up, split_fee, swap_in, swap_out, BPS, POOL_TOKENS};
use near_sdk::serde_json::{self, json};
use near_sdk::{Gas, PromiseOrValue};

pub(crate) const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub(crate) const GAS_STORAGE: Gas = Gas::from_tgas(5);
pub(crate) const GAS_CALLBACK: Gas = Gas::from_tgas(10);
pub(crate) const GAS_DEPOSIT_REWARDS: Gas = Gas::from_tgas(20);
pub(crate) const GAS_BURN: Gas = Gas::from_tgas(10);
pub(crate) const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// What a trade would do. Amounts in yoctoNEAR / token base units.
#[near(serializers = [json])]
pub struct QuoteView {
    pub out: U128,
    pub fee: U128,
    pub rate_bps: u16,
    /// NEAR (buys) or tokens (sells) actually used; a buy that sells out the curve is capped.
    pub used: U128,
    pub capped: bool,
    /// Average price against the spot price, in bps.
    pub impact_bps: u32,
    pub phase: Phase,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Fill {
    pub out: u128,
    pub used: u128,
    pub fee: u128,
    /// Amount that actually moved the reserves (buy: NEAR after fee; sell: NEAR before fee).
    pub net: u128,
    pub rate_bps: u16,
    pub normal_bps: u16,
    pub graduates: bool,
}

/// Message for `ft_transfer_call` to this contract.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FtMsg {
    Sell { min_out: U128, referrer: Option<AccountId> },
    Convert,
}

pub(crate) fn rates(cfg: &Config, t: &TokenState, now: u64) -> (u16, u16) {
    match t.phase {
        Phase::Pool => (cfg.pool_fee_bps, cfg.pool_fee_bps),
        _ => (fee_bps_at(t.fee_bps, t.created_ms.0, now, cfg.sniper_window_ms.0, cfg.sniper_start_bps), t.fee_bps),
    }
}

/// Buy with `amount` NEAR at fee `rate_bps`. On the curve a buy that would pass the end is capped to exactly
/// the remaining coins; the caller refunds the rest.
pub(crate) fn fill_buy(t: &TokenState, amount: u128, rate_bps: u16, normal_bps: u16) -> Fill {
    let (x, y) = (t.near_reserve.0, t.tok_reserve.0);
    let rate = rate_bps as u128;
    if t.phase == Phase::Curve {
        let room = y - CURVE_END_TOKENS;
        let net_max = swap_in(x, y, room);
        let used_max = mul_div_up(net_max, BPS, BPS - rate);
        if amount >= used_max {
            return Fill { out: room, used: used_max, fee: used_max - net_max, net: net_max, rate_bps, normal_bps, graduates: true };
        }
    }
    let fee = mul_div(amount, rate, BPS);
    let net = amount - fee;
    let out = swap_out(x, y, net);
    require!(out < y, "not enough liquidity");
    Fill { out, used: amount, fee, net, rate_bps, normal_bps, graduates: false }
}

pub(crate) fn fill_sell(t: &TokenState, amount: u128, rate_bps: u16, normal_bps: u16) -> Fill {
    let gross = swap_out(t.tok_reserve.0, t.near_reserve.0, amount);
    require!(gross <= market_near(t), "not enough NEAR in the market");
    let fee = mul_div(gross, rate_bps as u128, BPS);
    Fill { out: gross - fee, used: amount, fee, net: gross, rate_bps, normal_bps, graduates: false }
}

fn impact_bps(spot: u128, paid: u128, got: u128, buy: bool) -> u32 {
    if got == 0 || spot == 0 {
        return 0;
    }
    // Average price (e18) against spot.
    let avg = if buy { mul_div(paid, 1_000_000_000_000_000_000, got) } else { mul_div(got, 1_000_000_000_000_000_000, paid) };
    let diff = if buy { avg.saturating_sub(spot) } else { spot.saturating_sub(avg) };
    mul_div(diff, BPS, spot).min(u32::MAX as u128) as u32
}

#[near]
impl Launchpad {
    // ---------------------------------------------------------------- trading

    /// Buys coins with the attached NEAR. The first buy of a token also pays its 0.00125 NEAR registration.
    #[payable]
    pub fn buy(&mut self, token_id: String, min_out: U128, referrer: Option<AccountId>) -> Promise {
        let buyer = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let mut t = self.token(&token_id);
        require!(matches!(t.phase, Phase::Curve | Phase::Pool), "this token is not trading");
        let storage = if self.registered.contains(&reg_key(&token_id, &buyer)) { 0 } else { STORAGE_DEPOSIT };
        require!(attached > storage, "attach NEAR to buy");
        let amount = attached - storage;
        if let Some(r) = referrer {
            self.set_referrer(&buyer, r);
        }
        let now = now_ms();
        let (rate, normal) = rates(&self.config, &t, now);
        let f = fill_buy(&t, amount, rate, normal);
        require!(f.out > 0, "amount is too small");
        require!(f.out >= min_out.0, "price moved past your slippage limit");
        self.apply_buy(&mut t, &f, now);
        let referred = self.distribute(&mut t, f.fee, f.rate_bps, f.normal_bps, &buyer);
        self.trade_event(&t, &buyer, "buy", f.used, f.out, &f, referred.as_ref(), None);
        self.put_token(t.clone());
        if f.used < amount {
            Promise::new(buyer.clone()).transfer(NearToken::from_yoctonear(amount - f.used)).detach();
        }
        self.send_tokens(&t, &buyer, f.out, storage > 0)
    }

    /// Selling and converting arrive as `ft_transfer_call` from a token contract.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token_account = env::predecessor_account_id();
        let id = self.id_of(&token_account);
        let msg: FtMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad message"));
        self.registered.insert(reg_key(&id, &sender_id));
        match msg {
            FtMsg::Sell { min_out, referrer } => {
                self.sell_in(&id, &sender_id, amount.0, min_out.0, referrer);
                PromiseOrValue::Value(U128(0))
            }
            FtMsg::Convert => self.convert_in(&id, &sender_id, amount.0),
        }
    }

    fn sell_in(&mut self, id: &str, seller: &AccountId, amount: u128, min_out: u128, referrer: Option<AccountId>) {
        let mut t = self.token(id);
        require!(t.phase != Phase::Merged, "this token was crossed: convert it instead");
        require!(matches!(t.phase, Phase::Curve | Phase::Pool), "this token is not trading");
        if let Some(r) = referrer {
            self.set_referrer(seller, r);
        }
        let now = now_ms();
        let (rate, normal) = rates(&self.config, &t, now);
        let f = fill_sell(&t, amount, rate, normal);
        require!(f.out > 0, "amount is too small");
        require!(f.out >= min_out, "price moved past your slippage limit");
        self.apply_sell(&mut t, &f, now);
        let referred = self.distribute(&mut t, f.fee, f.rate_bps, f.normal_bps, seller);
        self.trade_event(&t, seller, "sell", f.out, amount, &f, referred.as_ref(), None);
        self.put_token(t);
        Promise::new(seller.clone()).transfer(NearToken::from_yoctonear(f.out)).detach();
    }

    pub fn quote_buy(&self, token_id: String, amount: U128) -> QuoteView {
        let t = self.token(&token_id);
        let (rate, normal) = rates(&self.config, &t, now_ms());
        let f = fill_buy(&t, amount.0, rate, normal);
        QuoteView {
            out: U128(f.out),
            fee: U128(f.fee),
            rate_bps: rate,
            used: U128(f.used),
            capped: f.used < amount.0,
            impact_bps: impact_bps(spot_e18(&t), f.net, f.out, true),
            phase: t.phase,
        }
    }

    pub fn quote_sell(&self, token_id: String, amount: U128) -> QuoteView {
        let t = self.token(&token_id);
        let (rate, normal) = rates(&self.config, &t, now_ms());
        let f = fill_sell(&t, amount.0, rate, normal);
        QuoteView { out: U128(f.out), fee: U128(f.fee), rate_bps: rate, used: U128(f.used), capped: false, impact_bps: impact_bps(spot_e18(&t), amount.0, f.net, false), phase: t.phase }
    }

    // ---------------------------------------------------------------- payouts

    /// Pushes the holders' waiting fee share to the token contract, where holders claim it.
    pub fn push_rewards(&mut self, token_id: String) -> Promise {
        let mut t = self.token(&token_id);
        let amount = t.pending_holders.0;
        require!(amount > 0, "nothing waiting");
        require!(amount >= self.config.min_push.0 || t.phase == Phase::Merged, "below the minimum push");
        require!(t.phase != Phase::Deploying, "not deployed yet");
        t.pending_holders = U128(0);
        let account = t.account.clone();
        self.put_token(t);
        Promise::new(account)
            .function_call("deposit_rewards", b"{}".to_vec(), NearToken::from_yoctonear(amount), GAS_DEPOSIT_REWARDS)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_rewards_pushed(token_id, U128(amount)))
    }

    #[private]
    pub fn on_rewards_pushed(&mut self, token_id: String, amount: U128) {
        if crate::promise_ok() {
            emit("rewards_pushed", json!({ "token_id": token_id, "amount": s(amount.0) }));
        } else if let Some(mut t) = self.tokens.get(&token_id).cloned() {
            t.pending_holders = U128(t.pending_holders.0 + amount.0);
            self.put_token(t);
        }
    }

    /// Dev rewards of a token. After a crossing both devs are paid their split, once the vesting ends.
    pub fn claim_dev(&mut self, token_id: String) {
        let caller = env::predecessor_account_id();
        let mut t = self.token(&token_id);
        require!(caller == t.creator || Some(&caller) == t.co_dev.as_ref(), "dev only");
        require!(now_ms() >= t.vest_until_ms.0, "rewards of this crossed token are still vesting");
        let amount = t.dev_earned.0 - t.dev_claimed.0;
        require!(amount > 0, "nothing to claim");
        t.dev_claimed = t.dev_earned;
        let (creator_part, co_part) = match &t.co_dev {
            Some(_) => {
                let c = mul_div(amount, t.split_bps as u128, BPS);
                (c, amount - c)
            }
            None => (amount, 0),
        };
        Promise::new(t.creator.clone()).transfer(NearToken::from_yoctonear(creator_part)).detach();
        if let Some(co) = &t.co_dev {
            if co_part > 0 {
                Promise::new(co.clone()).transfer(NearToken::from_yoctonear(co_part)).detach();
            }
        }
        emit("dev_claimed", json!({ "token_id": token_id, "creator": t.creator, "creator_amount": s(creator_part), "co_dev": t.co_dev, "co_dev_amount": s(co_part) }));
        self.put_token(t);
    }

    /// Referral earnings and refunds credited to the caller.
    pub fn claim_credits(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.credits.get(&caller).map(|c| c.0).unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.credits.remove(&caller);
        emit("credits_claimed", json!({ "account_id": caller, "amount": s(amount) }));
        Promise::new(caller).transfer(NearToken::from_yoctonear(amount))
    }

    /// Retries sending coins whose transfer failed.
    pub fn claim_pending_tokens(&mut self, token_id: String) -> Promise {
        let caller = env::predecessor_account_id();
        let key = reg_key(&token_id, &caller);
        let amount = self.pending_tokens.get(&key).map(|v| v.0).unwrap_or(0);
        require!(amount > 0, "nothing pending");
        self.pending_tokens.remove(&key);
        let t = self.token(&token_id);
        require!(t.phase != Phase::Merged, "this token was crossed: convert the pending coins first");
        self.send_tokens(&t, &caller, amount, false)
    }

    /// Spends a token's buyback pool on its own coins and burns them. Anyone can call it, once per block;
    /// each call spends at most 0.5% of the curve's virtual NEAR or 0.2% of what the pool opened with, so a
    /// trader cannot profit by buying before it and selling after.
    pub fn buyback(&mut self, token_id: String) -> Promise {
        let mut t = self.token(&token_id);
        require!(matches!(t.phase, Phase::Curve | Phase::Pool), "this token is not trading");
        require!(t.last_buyback_block.0 != env::block_height(), "one buyback per block");
        let cap = if t.phase == Phase::Curve { VIRTUAL_NEAR * 50 / BPS } else { t.pool_open_near.0 * 20 / BPS };
        let spend = t.buyback_pool.0.min(cap);
        require!(spend > 0, "the buyback pool is empty");
        let now = now_ms();
        let f = fill_buy(&t, spend, 0, 0);
        require!(f.out > 0, "too small");
        self.apply_buy(&mut t, &f, now);
        t.buyback_pool = U128(t.buyback_pool.0 - f.used);
        t.burned = U128(t.burned.0 + f.out);
        t.last_buyback_block = U64(env::block_height());
        emit("buyback", json!({ "token_id": token_id, "near": s(f.used), "tokens": s(f.out), "price_e18": s(spot_e18(&t)), "near_reserve": s(t.near_reserve.0), "tok_reserve": s(t.tok_reserve.0), "burned": s(t.burned.0), "phase": t.phase }));
        let account = t.account.clone();
        self.put_token(t);
        Promise::new(account).function_call("burn", json!({ "amount": U128(f.out) }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_BURN)
    }

    // ---------------------------------------------------------------- internals

    pub(crate) fn id_of(&self, token_account: &AccountId) -> String {
        let suffix = format!(".{}", env::current_account_id());
        let id = token_account.as_str().strip_suffix(&suffix).unwrap_or_else(|| env::panic_str("not a grow. token"));
        let t = self.tokens.get(id).unwrap_or_else(|| env::panic_str("not a grow. token"));
        require!(&t.account == token_account, "not a grow. token");
        id.to_string()
    }

    pub(crate) fn update_twap(&self, t: &mut TokenState, now: u64) {
        let dt = now.saturating_sub(t.price_ts.0) as u128;
        if dt > 0 {
            t.price_cum = U128(t.price_cum.0.wrapping_add(spot_e18(t).wrapping_mul(dt)));
            t.price_ts = U64(now);
        }
    }

    pub(crate) fn apply_buy(&mut self, t: &mut TokenState, f: &Fill, now: u64) {
        self.update_twap(t, now);
        t.near_reserve = U128(t.near_reserve.0 + f.net);
        t.tok_reserve = U128(t.tok_reserve.0 - f.out);
        t.volume = U128(t.volume.0 + f.used);
        t.trades = U64(t.trades.0 + 1);
        if f.graduates {
            // Everything raised and the 207M coins kept back open the pool, in the same call.
            t.near_reserve = U128(t.near_reserve.0 - VIRTUAL_NEAR);
            require!(t.tok_reserve.0 - (VIRTUAL_TOKENS - SUPPLY) == POOL_TOKENS, "curve accounting");
            t.tok_reserve = U128(POOL_TOKENS);
            t.pool_open_near = t.near_reserve;
            t.phase = Phase::Pool;
            emit("graduated", json!({ "token_id": t.id, "pool_near": s(t.near_reserve.0), "pool_tokens": s(t.tok_reserve.0) }));
        }
    }

    pub(crate) fn apply_sell(&mut self, t: &mut TokenState, f: &Fill, now: u64) {
        self.update_twap(t, now);
        t.near_reserve = U128(t.near_reserve.0 - f.net);
        t.tok_reserve = U128(t.tok_reserve.0 + f.used);
        t.volume = U128(t.volume.0 + f.net);
        t.trades = U64(t.trades.0 + 1);
    }

    /// Shares one fee. Returns the referrer that was paid, if any.
    pub(crate) fn distribute(&mut self, t: &mut TokenState, fee: u128, rate_bps: u16, normal_bps: u16, trader: &AccountId) -> Option<AccountId> {
        if fee == 0 {
            return None;
        }
        let referrer = self.active_referrer(trader);
        let sp = split_fee(fee, normal_bps, rate_bps, t.redirect_pct, t.redirect_to_holders, referrer.is_some());
        match t.dev_vault.and_then(|id| self.vaults.get(&id).cloned()) {
            Some(mut v) if v.status == VaultStatus::Active || v.status == VaultStatus::Paused => {
                v.cash = U128(v.cash.0 + sp.dev);
                v.start = U128(v.start.0 + sp.dev);
                v.peak = U128(v.peak.0 + sp.dev);
                self.vaults.insert(v.id, v);
            }
            _ => t.dev_earned = U128(t.dev_earned.0 + sp.dev),
        }
        t.pending_holders = U128(t.pending_holders.0 + sp.holders);
        t.buyback_pool = U128(t.buyback_pool.0 + sp.buyback);
        if let Some(r) = &referrer {
            self.credit(r, sp.referrer);
        }
        self.platform_earned = U128(self.platform_earned.0 + sp.platform);
        emit(
            "fees",
            json!({ "token_id": t.id, "dev": s(sp.dev), "holders": s(sp.holders), "buyback": s(sp.buyback), "referrer": s(sp.referrer), "referrer_id": referrer, "platform": s(sp.platform), "to_vault": t.dev_vault }),
        );
        referrer
    }

    pub(crate) fn set_referrer(&mut self, trader: &AccountId, referrer: AccountId) {
        if &referrer == trader || self.referrers.contains_key(trader) {
            return;
        }
        emit("referral", json!({ "account_id": trader, "referrer": referrer }));
        self.referrers.insert(trader.clone(), Referral { referrer, since_ms: U64(now_ms()) });
    }

    pub(crate) fn active_referrer(&self, trader: &AccountId) -> Option<AccountId> {
        let r = self.referrers.get(trader)?;
        (now_ms().saturating_sub(r.since_ms.0) < self.config.referral_days as u64 * DAY_MS).then(|| r.referrer.clone())
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn trade_event(&self, t: &TokenState, account: &AccountId, side: &str, near: u128, tokens: u128, f: &Fill, referrer: Option<&AccountId>, vault: Option<u64>) {
        emit(
            "trade",
            json!({
                "token_id": t.id, "account_id": account, "side": side, "near": s(near), "tokens": s(tokens),
                "fee": s(f.fee), "rate_bps": f.rate_bps, "price_e18": s(spot_e18(t)),
                "near_reserve": s(t.near_reserve.0), "tok_reserve": s(t.tok_reserve.0), "burned": s(t.burned.0),
                "phase": t.phase, "referrer": referrer, "vault_id": vault,
            }),
        );
    }

    /// Sends coins from this contract's balance, registering the receiver on the token first if needed.
    pub(crate) fn send_tokens(&mut self, t: &TokenState, to: &AccountId, amount: u128, pay_storage: bool) -> Promise {
        let key = reg_key(&t.id, to);
        let mut p = Promise::new(t.account.clone());
        let registering = !self.registered.contains(&key);
        if registering {
            require!(pay_storage || self.platform_earned.0 >= STORAGE_DEPOSIT, "the receiver is not registered");
            if !pay_storage {
                // Registration for coins handed out (crossings) is paid by the platform.
                self.platform_earned = U128(self.platform_earned.0 - STORAGE_DEPOSIT);
            }
            p = p.function_call(
                "storage_deposit",
                json!({ "account_id": to, "registration_only": true }).to_string().into_bytes(),
                NearToken::from_yoctonear(STORAGE_DEPOSIT),
                GAS_STORAGE,
            );
            self.registered.insert(key);
        }
        p.function_call("ft_transfer", json!({ "receiver_id": to, "amount": U128(amount) }).to_string().into_bytes(), ONE_YOCTO, GAS_FT_TRANSFER)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_tokens_sent(t.id.clone(), to.clone(), U128(amount), registering, pay_storage))
    }

    #[private]
    pub fn on_tokens_sent(&mut self, token_id: String, account_id: AccountId, amount: U128, registered_now: bool, user_paid: bool) {
        if crate::promise_ok() {
            return;
        }
        // The whole batch failed: keep the coins for the buyer and give back the registration fee.
        let key = reg_key(&token_id, &account_id);
        let v = self.pending_tokens.get(&key).map(|v| v.0).unwrap_or(0);
        self.pending_tokens.insert(key.clone(), U128(v + amount.0));
        if registered_now {
            self.registered.remove(&key);
            // The registration fee came back to this contract: return it to whoever paid it.
            if user_paid {
                self.credit(&account_id, STORAGE_DEPOSIT);
            } else {
                self.platform_earned = U128(self.platform_earned.0 + STORAGE_DEPOSIT);
            }
        }
        emit("tokens_pending", json!({ "token_id": token_id, "account_id": account_id, "amount": s(amount.0) }));
    }
}
