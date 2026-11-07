//! Crossing: two devs merge their tokens into one tree with two trunks.
//!
//! 1. The dev of A proposes (attaching the new token's storage), naming the new token and their share of the
//!    dev rewards. Either dev can cancel while it waits.
//! 2. The dev of B accepts. An exit window opens (`cross_window_ms`); holders who disagree can sell.
//! 3. After the window anyone finalises. Prices are averaged over the window (time-weighted), so a last-minute
//!    pump does not move the rate. The new token C opens directly in a pool holding both markets' NEAR, priced
//!    so its supply is exactly 1B: every coin of A and B outside the markets converts at its value, and the pool
//!    holds the rest.
//! 4. Holders convert by sending their old coins here (`{"action":"convert"}`); their hold time carries over.
//!    Vault positions convert by themselves. Unclaimed dev rewards of both tokens move to C, split between the
//!    devs and vesting for `cross_vest_ms`.
use crate::create::{blank_token, valid_reference, valid_ticker};
use crate::events::{emit, s};
use crate::market::{GAS_BURN, GAS_CALLBACK, GAS_STORAGE};
use crate::*;
use grow_common::mul_div;
use near_sdk::serde_json::{self, json};
use near_sdk::{Gas, PromiseOrValue};

const E18: u128 = 1_000_000_000_000_000_000;
const GAS_TOKEN_INIT: Gas = Gas::from_tgas(30);
const GAS_ON_DEPLOYED: Gas = Gas::from_tgas(40);
const GAS_HOLD_INFO: Gas = Gas::from_tgas(5);
const GAS_ON_HOLD_INFO: Gas = Gas::from_tgas(40);
const GAS_TRANSFER_WITH_SINCE: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CrossStatus {
    Proposed,
    Window,
    Deploying,
    Done,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Crossing {
    pub id: u64,
    pub a: String,
    pub b: String,
    pub proposer: AccountId,
    pub partner: AccountId,
    pub split_bps: u16,
    pub name: String,
    pub ticker: String,
    pub reference: Option<String>,
    pub status: CrossStatus,
    pub deposit: U128,
    pub created_ms: U64,
    pub ends_ms: U64,
    pub cum_a: U128,
    pub cum_b: U128,
    pub ts0: U64,
    pub new_token: Option<String>,
    pub rate_a: U128,
    pub rate_b: U128,
    pub price_e18: U128,
}

#[near]
impl Launchpad {
    /// Proposes crossing your token `a` with `b`. Attach `token_storage` for the new token; refunded on cancel.
    #[payable]
    pub fn propose_cross(&mut self, a: String, b: String, split_bps: u16, name: String, ticker: String, reference: Option<String>) -> u64 {
        let caller = env::predecessor_account_id();
        require!(a != b, "pick two different tokens");
        let ta = self.token(&a);
        let tb = self.token(&b);
        require!(ta.creator == caller && ta.co_dev.is_none(), "only the dev of the first token can propose");
        require!(tb.creator != caller, "the partner token must belong to another dev");
        require!(ta.parents.is_none() && tb.parents.is_none(), "crossed tokens cannot cross again");
        require!(ta.crossing.is_none() && tb.crossing.is_none(), "one of the tokens is already in a crossing");
        for t in [&ta, &tb] {
            require!(matches!(t.phase, Phase::Curve | Phase::Pool), "both tokens must be trading");
        }
        require!((1_000..=9_000).contains(&split_bps), "your share must be 10-90%");
        let name = name.trim().to_string();
        require!((2..=32).contains(&name.chars().count()), "name must be 2-32 characters");
        let ticker = ticker.trim().to_string();
        require!(valid_ticker(&ticker), "ticker must be 2-8 letters or digits, in capitals");
        require!(valid_reference(&reference), "reference must be an https or ipfs link");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.config.token_storage.0, "attach the new token's storage");
        let id = self.next_cross;
        self.next_cross += 1;
        let now = now_ms();
        let c = Crossing {
            id,
            a: a.clone(),
            b: b.clone(),
            proposer: caller,
            partner: tb.creator.clone(),
            split_bps,
            name,
            ticker,
            reference,
            status: CrossStatus::Proposed,
            deposit: U128(deposit),
            created_ms: U64(now),
            ends_ms: U64(0),
            cum_a: U128(0),
            cum_b: U128(0),
            ts0: U64(0),
            new_token: None,
            rate_a: U128(0),
            rate_b: U128(0),
            price_e18: U128(0),
        };
        let (mut ta, mut tb) = (ta, tb);
        ta.crossing = Some(id);
        tb.crossing = Some(id);
        self.put_token(ta);
        self.put_token(tb);
        emit("cross_proposed", json!({ "cross_id": id, "a": a, "b": b, "proposer": c.proposer, "partner": c.partner, "split_bps": split_bps, "name": c.name, "ticker": c.ticker }));
        self.crossings.insert(id, c);
        id
    }

    /// Either dev cancels a crossing that has not been accepted. The proposer gets the deposit back.
    pub fn cancel_cross(&mut self, cross_id: u64) -> Promise {
        let mut c = self.crossing(cross_id);
        let caller = env::predecessor_account_id();
        require!(caller == c.proposer || caller == c.partner, "dev only");
        require!(c.status == CrossStatus::Proposed, "only a waiting crossing can be cancelled");
        c.status = CrossStatus::Cancelled;
        self.release(&c);
        emit("cross_cancelled", json!({ "cross_id": cross_id, "by": caller }));
        let (to, amount) = (c.proposer.clone(), c.deposit.0);
        self.crossings.insert(cross_id, c);
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
    }

    /// The partner accepts: the exit window opens.
    pub fn accept_cross(&mut self, cross_id: u64) {
        let mut c = self.crossing(cross_id);
        require!(env::predecessor_account_id() == c.partner, "partner only");
        require!(c.status == CrossStatus::Proposed, "not waiting for you");
        let now = now_ms();
        let mut ta = self.token(&c.a);
        let mut tb = self.token(&c.b);
        self.update_twap(&mut ta, now);
        self.update_twap(&mut tb, now);
        c.cum_a = ta.price_cum;
        c.cum_b = tb.price_cum;
        c.ts0 = U64(now);
        c.status = CrossStatus::Window;
        c.ends_ms = U64(now + self.config.cross_window_ms.0);
        self.put_token(ta);
        self.put_token(tb);
        emit("cross_accepted", json!({ "cross_id": cross_id, "ends_ms": c.ends_ms }));
        self.crossings.insert(cross_id, c);
    }

    /// After the window: computes the rates and deploys the new token. Anyone can call it.
    pub fn finalize_cross(&mut self, cross_id: u64) -> Promise {
        let mut c = self.crossing(cross_id);
        require!(c.status == CrossStatus::Window, "the window is not open");
        let now = now_ms();
        require!(now >= c.ends_ms.0, "the exit window is still open");
        let mut ta = self.token(&c.a);
        let mut tb = self.token(&c.b);
        self.update_twap(&mut ta, now);
        self.update_twap(&mut tb, now);
        let dt = now.saturating_sub(c.ts0.0) as u128;
        let twap = |t: &TokenState, cum0: u128| if dt == 0 { spot_e18(t) } else { t.price_cum.0.wrapping_sub(cum0) / dt };
        let pa = twap(&ta, c.cum_a.0);
        let pb = twap(&tb, c.cum_b.0);
        let outside = |t: &TokenState| SUPPLY - t.burned.0 - market_inventory(t);
        let value = mul_div(outside(&ta), pa, E18) + mul_div(outside(&tb), pb, E18);
        let pool_near = market_near(&ta) + market_near(&tb);
        let pc = mul_div(value + pool_near, E18, SUPPLY);
        require!(pc > 0, "nothing to cross");
        let pool_tok = mul_div(pool_near, E18, pc);
        require!(pool_tok > 0 && pool_tok < SUPPLY, "cannot price the new token");
        c.rate_a = U128(mul_div(pa, E18, pc));
        c.rate_b = U128(mul_div(pb, E18, pc));
        c.price_e18 = U128(pc);

        let id = format!("{}-{}", c.ticker.to_lowercase(), crate::create::base36(self.next_token));
        self.next_token += 1;
        let account: AccountId = format!("{id}.{}", env::current_account_id()).parse().unwrap();
        let mut tc = blank_token(&id, account.clone(), &c.name, &c.ticker, ta.creator.clone(), now);
        tc.reference = c.reference.clone();
        tc.co_dev = Some(tb.creator.clone());
        tc.split_bps = c.split_bps;
        tc.fee_bps = ta.fee_bps;
        tc.redirect_pct = ta.redirect_pct;
        tc.redirect_to_holders = ta.redirect_to_holders;
        tc.near_reserve = U128(pool_near);
        tc.tok_reserve = U128(pool_tok);
        tc.pool_open_near = U128(pool_near);
        tc.parents = Some((ta.name.clone(), tb.name.clone()));
        tc.vest_until_ms = U64(now + self.config.cross_vest_ms.0);
        self.put_token(tc);
        ta.phase = Phase::Merging;
        tb.phase = Phase::Merging;
        self.put_token(ta);
        self.put_token(tb);
        c.status = CrossStatus::Deploying;
        c.new_token = Some(id.clone());
        self.crossings.insert(cross_id, c.clone());

        let metadata = json!({ "spec": "ft-1.0.0", "name": c.name, "symbol": c.ticker, "icon": null, "reference": c.reference, "reference_hash": null, "decimals": grow_common::DECIMALS });
        let init = json!({ "launchpad": env::current_account_id(), "total_supply": U128(SUPPLY), "metadata": metadata });
        self.deploy_token_code(Promise::new(account).create_account().transfer(NearToken::from_yoctonear(c.deposit.0)))
            .function_call("new", init.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_TOKEN_INIT)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_DEPLOYED).on_cross_deployed(cross_id))
    }

    #[private]
    pub fn on_cross_deployed(&mut self, cross_id: u64) -> PromiseOrValue<()> {
        let mut c = self.crossing(cross_id);
        let new_id = c.new_token.clone().unwrap();
        let mut ta = self.token(&c.a);
        let mut tb = self.token(&c.b);
        if !crate::promise_ok() {
            // Back to trading as before; the deposit stays with the crossing for another attempt.
            self.tokens.remove(&new_id);
            ta.phase = if ta.pool_open_near.0 > 0 { Phase::Pool } else { Phase::Curve };
            tb.phase = if tb.pool_open_near.0 > 0 { Phase::Pool } else { Phase::Curve };
            self.put_token(ta);
            self.put_token(tb);
            c.status = CrossStatus::Window;
            c.new_token = None;
            emit("cross_failed", json!({ "cross_id": cross_id }));
            self.crossings.insert(cross_id, c);
            return PromiseOrValue::Value(());
        }
        let now = now_ms();
        let mut tc = self.token(&new_id);
        tc.phase = Phase::Pool;
        tc.created_ms = U64(now);
        tc.price_ts = U64(now);
        // Unclaimed dev rewards and buyback money move to the new token; holder rewards stay with the old
        // tokens, whose holders claim them there.
        for t in [&mut ta, &mut tb] {
            let unclaimed = t.dev_earned.0 - t.dev_claimed.0;
            tc.dev_earned = U128(tc.dev_earned.0 + unclaimed);
            t.dev_claimed = t.dev_earned;
            tc.buyback_pool = U128(tc.buyback_pool.0 + t.buyback_pool.0);
            t.buyback_pool = U128(0);
        }
        tc.dev_vault = ta.dev_vault;
        let burn_a = market_inventory(&ta);
        let burn_b = market_inventory(&tb);
        for (t, rate) in [(&mut ta, c.rate_a), (&mut tb, c.rate_b)] {
            t.phase = Phase::Merged;
            t.merged_into = Some(new_id.clone());
            t.merge_rate = rate;
            t.near_reserve = U128(0);
            t.tok_reserve = U128(0);
        }
        ta.burned = U128(ta.burned.0 + burn_a);
        tb.burned = U128(tb.burned.0 + burn_b);
        c.status = CrossStatus::Done;
        emit(
            "cross_done",
            json!({ "cross_id": cross_id, "a": c.a, "b": c.b, "token_id": new_id, "account": tc.account, "rate_a": s(c.rate_a.0), "rate_b": s(c.rate_b.0),
                    "price_e18": s(c.price_e18.0), "pool_near": s(tc.near_reserve.0), "pool_tokens": s(tc.tok_reserve.0), "creator": tc.creator, "co_dev": tc.co_dev, "split_bps": tc.split_bps }),
        );
        let (acc_a, acc_b) = (ta.account.clone(), tb.account.clone());
        self.put_token(ta);
        self.put_token(tb);
        self.put_token(tc);
        self.crossings.insert(cross_id, c);
        // The old markets' coins are gone with their NEAR: burn them so supplies stay honest.
        let burn = |acc: AccountId, amount: u128| {
            Promise::new(acc).function_call("burn", json!({ "amount": U128(amount) }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_BURN)
        };
        let mut p: Option<Promise> = None;
        for (acc, amount) in [(acc_a, burn_a), (acc_b, burn_b)] {
            if amount > 0 {
                let b = burn(acc, amount);
                p = Some(match p {
                    Some(x) => x.and(b),
                    None => b,
                });
            }
        }
        match p {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(()),
        }
    }

    /// Coins of a crossed token sent here convert to the new token, keeping their hold time.
    pub(crate) fn convert_in(&mut self, old_id: &str, holder: &AccountId, amount: u128) -> PromiseOrValue<U128> {
        let t = self.token(old_id);
        require!(t.phase == Phase::Merged, "this token was not crossed");
        let out = mul_div(amount, t.merge_rate.0, E18);
        require!(out > 0, "amount is too small");
        let new_id = t.merged_into.clone().unwrap();
        emit("converted", json!({ "from": old_id, "to": new_id, "account_id": holder, "amount_in": s(amount), "amount_out": s(out) }));
        Promise::new(t.account.clone())
            .function_call("hold_info", json!({ "account_id": holder }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_HOLD_INFO)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_HOLD_INFO).on_hold_info(old_id.to_string(), new_id, holder.clone(), U128(amount), U128(out)))
            .detach();
        // The coins are accepted either way; the callback delivers the new ones.
        PromiseOrValue::Value(U128(0))
    }

    #[private]
    pub fn on_hold_info(&mut self, old_id: String, new_id: String, holder: AccountId, amount_in: U128, amount_out: U128) -> Promise {
        // Hold date from the old token (its `since` is unchanged by sending coins); today if that call failed.
        let today = (env::block_timestamp() / 86_400_000_000_000) as u32;
        let since = match env::promise_result_checked(0, 16_384) {
            Ok(v) => serde_json::from_slice::<serde_json::Value>(&v).ok().and_then(|j| j["since_day"].as_u64()).map(|d| d as u32).unwrap_or(today),
            _ => today,
        };
        let old = self.token(&old_id);
        let c = self.token(&new_id);
        let key = reg_key(&new_id, &holder);
        let mut p = Promise::new(c.account.clone());
        let registering = !self.registered.contains(&key);
        if registering {
            require!(self.platform_earned.0 >= STORAGE_DEPOSIT, "registration is unavailable right now");
            self.platform_earned = U128(self.platform_earned.0 - STORAGE_DEPOSIT);
            self.registered.insert(key);
            p = p.function_call(
                "storage_deposit",
                json!({ "account_id": holder, "registration_only": true }).to_string().into_bytes(),
                NearToken::from_yoctonear(STORAGE_DEPOSIT),
                GAS_STORAGE,
            );
        }
        let give = p.function_call(
            "transfer_with_since",
            json!({ "receiver_id": holder, "amount": amount_out, "since_day": since.min(today) }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_TRANSFER_WITH_SINCE,
        );
        let mut o = old;
        o.burned = U128(o.burned.0 + amount_in.0);
        let acc = o.account.clone();
        self.put_token(o);
        let burn = Promise::new(acc).function_call("burn", json!({ "amount": amount_in }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_BURN);
        give.then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_tokens_sent(new_id, holder, amount_out, registering, false)).and(burn)
    }

    /// Converts coins of a crossed token still waiting here for the caller.
    pub fn convert_pending(&mut self, token_id: String) -> Promise {
        let caller = env::predecessor_account_id();
        let t = self.token(&token_id);
        require!(t.phase == Phase::Merged, "this token was not crossed");
        let key = reg_key(&token_id, &caller);
        let amount = self.pending_tokens.get(&key).map(|v| v.0).unwrap_or(0);
        require!(amount > 0, "nothing pending");
        self.pending_tokens.remove(&key);
        let out = mul_div(amount, t.merge_rate.0, E18);
        let c = self.token(t.merged_into.as_ref().unwrap());
        self.send_tokens(&c, &caller, out, false)
    }

    pub fn get_crossing(&self, cross_id: u64) -> Option<Crossing> {
        self.crossings.get(&cross_id).cloned()
    }

    pub fn list_crossings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Crossing> {
        self.crossings.values().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).cloned().collect()
    }

    pub(crate) fn crossing(&self, id: u64) -> Crossing {
        self.crossings.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such crossing"))
    }

    fn release(&mut self, c: &Crossing) {
        for id in [&c.a, &c.b] {
            let mut t = self.token(id);
            t.crossing = None;
            self.put_token(t);
        }
    }
}
