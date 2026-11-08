//! Gardener vaults: money an agent trades within limits the contract enforces.
//!
//! - House: grow.'s own gardeners, funded by the owner, fired at `house_fire_bps` (30%) down from their peak.
//! - User: a gardener someone creates from a strategy or runs with their own agent (an API key on the relayer,
//!   or the user's own NEAR account as `agent`). Stops at the owner's stop loss, daily limit and end date.
//! - Copy: follows another vault. Only the relayer can place copy trades, and only a recent trade the leader
//!   actually made, in the same token and direction: a buy of `per_trade`, or the same share of the position
//!   for a sell.
//! - Dev: a token's dev rewards, connected at launch, trading that token only.
//!
//! Coins bought by a vault stay on this contract (`Position`) until the owner closes the vault, which sends the
//! coins and the NEAR to the owner. Nobody else can move a vault's funds.
use crate::events::{emit, s};
use crate::market::{fill_buy, fill_sell, rates};
use crate::*;
use grow_common::{mul_div, BPS};
use near_sdk::serde_json::json;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VaultKind {
    House,
    User,
    Copy,
    Dev,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VaultStatus {
    Active,
    Paused,
    /// Hit its loss limit (or its leader was fired). No more trades; the owner can close it.
    Fired,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Allowed {
    All,
    PoolOnly,
    Only(String),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Position {
    pub token_id: String,
    pub amount: U128,
    /// NEAR spent on the coins still held, for profit and win counts.
    pub cost: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Vault {
    pub id: u64,
    pub kind: VaultKind,
    pub owner: AccountId,
    pub agent: AccountId,
    pub name: String,
    pub strategy: String,
    pub cash: U128,
    pub positions: Vec<Position>,
    /// NEAR put in (deposits and dev rewards).
    pub start: U128,
    pub peak: U128,
    /// Loss from the peak that stops the vault, bps.
    pub fire_bps: u16,
    pub daily_limit: U128,
    pub day: u32,
    pub spent_today: U128,
    pub allowed: Allowed,
    /// 0 = no end date.
    pub expires_ms: U64,
    pub status: VaultStatus,
    pub stop_reason: Option<String>,
    pub leader: Option<u64>,
    pub per_trade: U128,
    pub trades: u32,
    pub wins: u32,
    pub seq: u64,
    pub created_ms: U64,
    pub fired_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct LeaderTrade {
    pub seq: u64,
    pub token_id: String,
    pub buy: bool,
    /// For sells: share of the position sold, bps.
    pub fraction_bps: u32,
    pub ts_ms: U64,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub vault: Vault,
    pub equity: U128,
    pub drawdown_bps: u32,
}

const MAX_LEADER_TRADES: usize = 20;
const MIN_BUDGET: u128 = ONE_NEAR;

#[near]
impl Launchpad {
    // ---------------------------------------------------------------- creating

    /// A gardener of your own. Attach its budget. `agent` defaults to the relayer (strategies and API keys);
    /// pass your own account to trade it from your own agent.
    #[payable]
    pub fn create_vault(&mut self, name: String, strategy: String, agent: Option<AccountId>, daily_limit: U128, stop_loss_bps: u16, allowed: Allowed, days: u32) -> u64 {
        let budget = env::attached_deposit().as_yoctonear();
        require!(budget >= MIN_BUDGET, "the budget must be at least 1 NEAR");
        require!((500..=10_000).contains(&stop_loss_bps), "stop loss must be 5-100%");
        require!((1..=365).contains(&days), "days must be 1-365");
        require!(daily_limit.0 > 0, "set a daily limit");
        check_name(&name);
        let owner = env::predecessor_account_id();
        let agent = agent.unwrap_or_else(|| self.relayer.clone());
        let id = self.new_vault(VaultKind::User, owner, agent, name, strategy, budget, stop_loss_bps, daily_limit.0, allowed, days as u64 * DAY_MS, None, 0);
        id
    }

    /// One of grow.'s own gardeners. Owner or house funder; attach its starting capital.
    #[payable]
    pub fn create_house_vault(&mut self, name: String, strategy: String, daily_limit: U128) -> u64 {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner || caller == self.house_funder, "owner or house funder only");
        let budget = env::attached_deposit().as_yoctonear();
        require!(budget >= MIN_BUDGET, "the budget must be at least 1 NEAR");
        check_name(&name);
        self.new_vault(VaultKind::House, caller, self.relayer.clone(), name, strategy, budget, self.config.house_fire_bps, daily_limit.0, Allowed::All, 0, None, 0)
    }

    /// Copies a gardener's trades at your size. Attach the budget.
    #[payable]
    pub fn copy_vault(&mut self, leader_id: u64, per_trade: U128, stop_loss_bps: u16) -> u64 {
        let budget = env::attached_deposit().as_yoctonear();
        require!(budget >= MIN_BUDGET, "the budget must be at least 1 NEAR");
        require!(per_trade.0 > 0 && per_trade.0 <= budget, "the budget must cover at least one trade");
        require!((500..=10_000).contains(&stop_loss_bps), "stop loss must be 5-100%");
        let leader = self.vault(leader_id);
        require!(matches!(leader.kind, VaultKind::House | VaultKind::User), "only house and user gardeners can be copied");
        require!(leader.status == VaultStatus::Active, "this gardener is not trading");
        let owner = env::predecessor_account_id();
        let name = format!("Copy of {}", leader.name);
        self.new_vault(VaultKind::Copy, owner, self.relayer.clone(), name, leader.strategy, budget, stop_loss_bps, u128::MAX, Allowed::All, 0, Some(leader_id), per_trade.0)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_vault(
        &mut self,
        kind: VaultKind,
        owner: AccountId,
        agent: AccountId,
        name: String,
        strategy: String,
        budget: u128,
        fire_bps: u16,
        daily_limit: u128,
        allowed: Allowed,
        duration_ms: u64,
        leader: Option<u64>,
        per_trade: u128,
    ) -> u64 {
        require!(strategy.len() <= 32, "strategy name too long");
        let id = self.next_vault;
        self.next_vault += 1;
        let now = now_ms();
        let v = Vault {
            id,
            kind,
            owner,
            agent,
            name,
            strategy,
            cash: U128(budget),
            positions: vec![],
            start: U128(budget),
            peak: U128(budget),
            fire_bps,
            daily_limit: U128(daily_limit),
            day: (now / DAY_MS) as u32,
            spent_today: U128(0),
            allowed,
            expires_ms: U64(if duration_ms > 0 { now + duration_ms } else { 0 }),
            status: VaultStatus::Active,
            stop_reason: None,
            leader,
            per_trade: U128(per_trade),
            trades: 0,
            wins: 0,
            seq: 0,
            created_ms: U64(now),
            fired_ms: U64(0),
        };
        emit(
            "vault_created",
            json!({ "vault_id": id, "kind": v.kind, "owner": v.owner, "agent": v.agent, "name": v.name, "strategy": v.strategy,
                    "budget": s(budget), "fire_bps": fire_bps, "daily_limit": s(daily_limit.min(u128::MAX)), "allowed": v.allowed,
                    "expires_ms": v.expires_ms, "leader": leader, "per_trade": s(per_trade) }),
        );
        self.vaults.insert(id, v);
        id
    }

    // ---------------------------------------------------------------- owner controls

    #[payable]
    pub fn deposit_vault(&mut self, vault_id: u64) {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.owner, "owner only");
        require!(matches!(v.status, VaultStatus::Active | VaultStatus::Paused), "this vault is stopped");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR");
        v.cash = U128(v.cash.0 + amount);
        v.start = U128(v.start.0 + amount);
        v.peak = U128(v.peak.0 + amount);
        emit("vault_deposit", json!({ "vault_id": vault_id, "amount": s(amount) }));
        self.vaults.insert(vault_id, v);
    }

    pub fn set_vault_paused(&mut self, vault_id: u64, paused: bool) {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.owner, "owner only");
        require!(matches!(v.status, VaultStatus::Active | VaultStatus::Paused), "this vault is stopped");
        v.status = if paused { VaultStatus::Paused } else { VaultStatus::Active };
        emit("vault_status", json!({ "vault_id": vault_id, "status": v.status }));
        self.vaults.insert(vault_id, v);
    }

    /// Points a user vault at another agent (for example after revoking an API key).
    pub fn set_vault_agent(&mut self, vault_id: u64, agent: AccountId) {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.owner, "owner only");
        require!(v.kind == VaultKind::User, "only user gardeners change agents");
        v.agent = agent;
        emit("vault_agent", json!({ "vault_id": vault_id, "agent": v.agent }));
        self.vaults.insert(vault_id, v);
    }

    /// Stops the vault and returns everything to its owner: NEAR, and coins as real tokens.
    pub fn close_vault(&mut self, vault_id: u64) -> Promise {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.owner, "owner only");
        require!(v.status != VaultStatus::Closed, "already closed");
        self.normalize_positions(&mut v);
        let positions = std::mem::take(&mut v.positions);
        for p in positions {
            let mut t = self.token(&p.token_id);
            t.vault_held = U128(t.vault_held.0 - p.amount.0);
            self.put_token(t.clone());
            let pay = !self.registered.contains(&reg_key(&t.id, &v.owner));
            if pay {
                require!(v.cash.0 >= STORAGE_DEPOSIT, "not enough NEAR in the vault to register the coins");
                v.cash = U128(v.cash.0 - STORAGE_DEPOSIT);
            }
            // Each coin transfer runs on its own: NEAR does not allow returning a joint promise.
            self.send_tokens(&t, &v.owner, p.amount.0, pay).detach();
        }
        let cash = v.cash.0;
        v.cash = U128(0);
        v.status = VaultStatus::Closed;
        emit("vault_closed", json!({ "vault_id": vault_id, "cash": s(cash) }));
        let owner = v.owner.clone();
        self.vaults.insert(vault_id, v);
        Promise::new(owner).transfer(NearToken::from_yoctonear(cash))
    }

    // ---------------------------------------------------------------- trading

    /// A trade by the vault's agent. Returns the equity after it.
    pub fn vault_trade(&mut self, vault_id: u64, token_id: String, buy: bool, amount: U128, min_out: U128, note: Option<String>) -> U128 {
        let mut v = self.vault(vault_id);
        require!(env::predecessor_account_id() == v.agent, "agent only");
        require!(v.kind != VaultKind::Copy, "copy vaults trade with copy_trade");
        if let Some(n) = &note {
            require!(n.chars().count() <= 140, "note longer than 140 characters");
        }
        let before = position_amount(&v, &token_id);
        self.vault_exec(&mut v, &token_id, buy, amount.0, min_out.0, note.as_deref(), None);
        // Followers copy this trade.
        v.seq += 1;
        let fraction_bps = if buy || before == 0 { 0 } else { mul_div(amount.0, BPS, before).min(BPS) as u32 };
        let mut list = self.leader_trades.get(&vault_id).cloned().unwrap_or_default();
        list.push(LeaderTrade { seq: v.seq, token_id, buy, fraction_bps, ts_ms: U64(now_ms()) });
        if list.len() > MAX_LEADER_TRADES {
            list.remove(0);
        }
        self.leader_trades.insert(vault_id, list);
        let equity = self.finish_trade(&mut v);
        self.vaults.insert(vault_id, v);
        U128(equity)
    }

    /// Mirrors trade `seq` of the leader into a copy vault. Relayer only.
    pub fn copy_trade(&mut self, copy_id: u64, seq: u64, min_out: U128) -> U128 {
        require!(env::predecessor_account_id() == self.relayer, "relayer only");
        let mut v = self.vault(copy_id);
        require!(v.kind == VaultKind::Copy, "not a copy vault");
        let leader_id = v.leader.unwrap();
        let leader = self.vault(leader_id);
        if leader.status == VaultStatus::Fired {
            v.status = VaultStatus::Fired;
            v.stop_reason = Some("the gardener was fired".into());
            v.fired_ms = U64(now_ms());
            emit("vault_fired", json!({ "vault_id": copy_id, "reason": "leader_fired" }));
            self.vaults.insert(copy_id, v);
            return U128(0);
        }
        let key = format!("{copy_id}:{seq}");
        require!(!self.copied.contains(&key), "already copied");
        let trade = self.leader_trades.get(&leader_id).and_then(|l| l.iter().find(|t| t.seq == seq).cloned()).unwrap_or_else(|| env::panic_str("no such leader trade"));
        require!(now_ms().saturating_sub(trade.ts_ms.0) <= self.config.copy_max_delay_ms.0, "too late to copy");
        require!(v.created_ms.0 <= trade.ts_ms.0, "the trade is older than the copy");
        self.normalize_positions(&mut v);
        let amount = if trade.buy {
            v.per_trade.0.min(v.cash.0)
        } else {
            let held = position_amount(&v, &trade.token_id);
            if trade.fraction_bps as u128 >= BPS { held } else { mul_div(held, trade.fraction_bps as u128, BPS) }
        };
        require!(amount > 0, "nothing to copy");
        self.copied.insert(key);
        self.vault_exec(&mut v, &trade.token_id, trade.buy, amount, min_out.0, None, Some((leader_id, seq)));
        let equity = self.finish_trade(&mut v);
        self.vaults.insert(copy_id, v);
        U128(equity)
    }

    /// Anyone can fire a vault whose equity fell past its limit, or stop one whose end date passed.
    pub fn check_vault(&mut self, vault_id: u64) -> VaultStatus {
        let mut v = self.vault(vault_id);
        if v.status == VaultStatus::Active || v.status == VaultStatus::Paused {
            self.finish_trade(&mut v);
            if v.status == VaultStatus::Active && v.expires_ms.0 > 0 && now_ms() >= v.expires_ms.0 {
                v.status = VaultStatus::Paused;
                v.stop_reason = Some("the end date passed".into());
                emit("vault_status", json!({ "vault_id": vault_id, "status": v.status, "reason": "expired" }));
            }
            self.vaults.insert(vault_id, v.clone());
        }
        v.status
    }

    // ---------------------------------------------------------------- views

    pub fn get_vault(&self, vault_id: u64) -> Option<VaultView> {
        let v = self.vaults.get(&vault_id)?.clone();
        let equity = self.equity(&v);
        let dd = if v.peak.0 > equity { mul_div(v.peak.0 - equity, BPS, v.peak.0) as u32 } else { 0 };
        Some(VaultView { vault: v, equity: U128(equity), drawdown_bps: dd })
    }

    pub fn list_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<VaultView> {
        let ids: Vec<u64> = self.vaults.keys().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).cloned().collect();
        ids.into_iter().filter_map(|id| self.get_vault(id)).collect()
    }

    pub fn leader_trades_of(&self, vault_id: u64) -> Vec<LeaderTrade> {
        self.leader_trades.get(&vault_id).cloned().unwrap_or_default()
    }

    // ---------------------------------------------------------------- internals

    pub(crate) fn vault(&self, id: u64) -> Vault {
        self.vaults.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such vault"))
    }

    #[allow(clippy::too_many_arguments)]
    fn vault_exec(&mut self, v: &mut Vault, token_id: &str, buy: bool, amount: u128, min_out: u128, note: Option<&str>, copied: Option<(u64, u64)>) {
        require!(v.status == VaultStatus::Active, "this gardener is not trading");
        let now = now_ms();
        require!(v.expires_ms.0 == 0 || now < v.expires_ms.0, "this gardener's end date passed");
        self.normalize_positions(v);
        let mut t = self.token(token_id);
        require!(matches!(t.phase, Phase::Curve | Phase::Pool), "this token is not trading");
        match &v.allowed {
            Allowed::All => {}
            Allowed::PoolOnly => require!(t.phase == Phase::Pool, "this gardener only trades tokens in their pool"),
            Allowed::Only(only) => require!(only == token_id, "this gardener only trades its own token"),
        }
        let day = (now / DAY_MS) as u32;
        if v.day != day {
            v.day = day;
            v.spent_today = U128(0);
        }
        let (rate, normal) = rates(&self.config, &t, now);
        let (near, tokens, f) = if buy {
            require!(amount <= v.cash.0, "not enough NEAR in the vault");
            require!(v.spent_today.0.saturating_add(amount) <= v.daily_limit.0, "daily limit reached");
            let idx = v.positions.iter().position(|p| p.token_id == token_id);
            require!(idx.is_some() || v.positions.len() < self.config.max_positions as usize, "too many positions");
            let f = fill_buy(&t, amount, rate, normal);
            require!(f.out > 0 && f.out >= min_out, "price moved past the slippage limit");
            self.apply_buy(&mut t, &f, now);
            v.cash = U128(v.cash.0 - f.used);
            v.spent_today = U128(v.spent_today.0 + f.used);
            match idx {
                Some(i) => {
                    v.positions[i].amount = U128(v.positions[i].amount.0 + f.out);
                    v.positions[i].cost = U128(v.positions[i].cost.0 + f.used);
                }
                None => v.positions.push(Position { token_id: token_id.to_string(), amount: U128(f.out), cost: U128(f.used) }),
            }
            t.vault_held = U128(t.vault_held.0 + f.out);
            (f.used, f.out, f)
        } else {
            let i = v.positions.iter().position(|p| p.token_id == token_id).unwrap_or_else(|| env::panic_str("no position in this token"));
            require!(amount <= v.positions[i].amount.0, "not enough coins in the vault");
            let f = fill_sell(&t, amount, rate, normal);
            require!(f.out > 0 && f.out >= min_out, "price moved past the slippage limit");
            self.apply_sell(&mut t, &f, now);
            v.cash = U128(v.cash.0 + f.out);
            let cost_part = mul_div(v.positions[i].cost.0, amount, v.positions[i].amount.0);
            if f.out > cost_part {
                v.wins += 1;
            }
            v.positions[i].amount = U128(v.positions[i].amount.0 - amount);
            v.positions[i].cost = U128(v.positions[i].cost.0 - cost_part);
            if v.positions[i].amount.0 == 0 {
                v.positions.remove(i);
            }
            t.vault_held = U128(t.vault_held.0 - amount);
            (f.out, amount, f)
        };
        let owner = v.owner.clone();
        let referred = self.distribute(&mut t, f.fee, f.rate_bps, f.normal_bps, &owner);
        self.trade_event(&t, &owner, if buy { "buy" } else { "sell" }, near, tokens, &f, referred.as_ref(), Some(v.id));
        v.trades += 1;
        emit(
            "vault_trade",
            json!({ "vault_id": v.id, "kind": v.kind, "token_id": token_id, "side": if buy { "buy" } else { "sell" },
                    "near": s(near), "tokens": s(tokens), "note": note, "copied_from": copied.map(|c| c.0), "leader_seq": copied.map(|c| c.1), "seq": v.seq + if copied.is_none() { 1 } else { 0 } }),
        );
        self.put_token(t);
    }

    /// Updates the peak and fires the vault when its loss passes the limit. Returns the equity.
    fn finish_trade(&mut self, v: &mut Vault) -> u128 {
        let equity = self.equity(v);
        if equity > v.peak.0 {
            v.peak = U128(equity);
        }
        let dd = if v.peak.0 > equity { mul_div(v.peak.0 - equity, BPS, v.peak.0) } else { 0 };
        if dd >= v.fire_bps as u128 && matches!(v.status, VaultStatus::Active | VaultStatus::Paused) {
            v.status = VaultStatus::Fired;
            v.fired_ms = U64(now_ms());
            v.stop_reason = Some(format!("down {}% from its peak", dd / 100));
            emit("vault_fired", json!({ "vault_id": v.id, "kind": v.kind, "equity": s(equity), "peak": s(v.peak.0), "drawdown_bps": dd as u32 }));
        }
        emit("vault_equity", json!({ "vault_id": v.id, "equity": s(equity), "peak": s(v.peak.0), "cash": s(v.cash.0) }));
        equity
    }

    /// Cash plus coins at spot price. Coins of a crossed token count at its new token's price.
    pub(crate) fn equity(&self, v: &Vault) -> u128 {
        let mut e = v.cash.0;
        for p in &v.positions {
            let Some(t) = self.tokens.get(&p.token_id) else { continue };
            let (t, amount) = match (&t.merged_into, t.phase) {
                (Some(into), Phase::Merged) => match self.tokens.get(into) {
                    Some(c) => (c, mul_div(p.amount.0, t.merge_rate.0, 1_000_000_000_000_000_000)),
                    None => continue,
                },
                _ => (t, p.amount.0),
            };
            e += mul_div(amount, spot_e18(t), 1_000_000_000_000_000_000);
        }
        e
    }

    /// Replaces positions in crossed tokens with the new token.
    pub(crate) fn normalize_positions(&mut self, v: &mut Vault) {
        let mut i = 0;
        while i < v.positions.len() {
            let p = v.positions[i].clone();
            let t = self.token(&p.token_id);
            if t.phase == Phase::Merged {
                let into = t.merged_into.clone().unwrap();
                let out = mul_div(p.amount.0, t.merge_rate.0, 1_000_000_000_000_000_000);
                let mut old = t;
                old.vault_held = U128(old.vault_held.0 - p.amount.0);
                self.put_token(old);
                let mut c = self.token(&into);
                c.vault_held = U128(c.vault_held.0 + out);
                self.put_token(c);
                v.positions.remove(i);
                emit("vault_converted", json!({ "vault_id": v.id, "from": p.token_id, "to": into, "amount_in": s(p.amount.0), "amount_out": s(out) }));
                match v.positions.iter().position(|q| q.token_id == into) {
                    Some(j) => {
                        v.positions[j].amount = U128(v.positions[j].amount.0 + out);
                        v.positions[j].cost = U128(v.positions[j].cost.0 + p.cost.0);
                    }
                    None => v.positions.push(Position { token_id: into.clone(), amount: U128(out), cost: p.cost }),
                }
                if let Allowed::Only(only) = &v.allowed {
                    if *only == p.token_id {
                        v.allowed = Allowed::Only(into);
                    }
                }
                continue;
            }
            i += 1;
        }
    }
}

fn position_amount(v: &Vault, token_id: &str) -> u128 {
    v.positions.iter().find(|p| p.token_id == token_id).map(|p| p.amount.0).unwrap_or(0)
}

fn check_name(name: &str) {
    let n = name.trim().chars().count();
    require!((2..=24).contains(&n), "name must be 2-24 characters");
}
