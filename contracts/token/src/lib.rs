//! A grow. token: a plain NEP-141 fungible token (NEP-145 storage, NEP-148 metadata) that also pays its
//! holders in NEAR.
//!
//! The launchpad mints the whole supply to itself at creation. It is the only privileged account and can only
//! burn its own coins and hand out coins with a kept hold time (when two tokens cross). No owner, no mint after
//! creation, no pause, no blacklist, no tax.
//!
//! Hold rewards. The launchpad sends each token its holders' share of trading fees (`deposit_rewards`). Every
//! holder earns in proportion to `balance x multiplier`, where the multiplier depends on how long the coins
//! have been held: nothing before 3 days, x1 from day 3, x1.5 from day 5 and x2 from day 10. Weights step up
//! at day boundaries, so the contract keeps the total weight exact with a small schedule of future steps (at
//! most ~11 days ahead) and settles each holder lazily, segment by segment, using the reward index at the
//! start of each step day. Everything is on-chain; nothing depends on the API.
//!
//! Hold time is one "since" day per holder. Coins received are averaged in at today's date, coins sent keep
//! it (so selling never makes the rest younger), and coins given back by a failed `ft_transfer_call` keep the
//! sender's date.
use grow_common::{hold_multiplier, U256, TIER_STEPS};
use near_sdk::collections::TreeMap;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,

};

const DAY_NS: u64 = 86_400_000_000_000;
/// Fixed-point scale of the reward index.
const PREC: u128 = 1_000_000_000_000_000_000_000_000; // 1e24
const STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(5);
const GAS_FOR_TRANSFER_CALL: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Holders,
    Snapshots,
    Steps,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Holder {
    pub balance: u128,
    /// Day (since the Unix epoch) the coins count as held from.
    pub since: u32,
    /// Rewards are settled up to this day and this reward index.
    pub settled_day: u32,
    pub settled_acc: [u64; 4],
    pub claimable: u128,
}

#[near(serializers = [json])]
pub struct HoldInfo {
    pub balance: U128,
    pub since_day: u32,
    pub held_days: u32,
    /// Hundredths: 0, 100, 150 or 200.
    pub multiplier: u32,
    pub claimable: U128,
}

#[near(serializers = [json])]
pub struct RewardStats {
    pub total_weight: U128,
    pub index: String,
    pub undistributed: U128,
    pub liability: U128,
    pub paid: U128,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[ext_contract(ext_ft_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    launchpad: AccountId,
    metadata: FungibleTokenMetadata,
    total_supply: u128,
    holders: LookupMap<AccountId, Holder>,
    /// Reward index (reward per unit of weight, scaled by PREC).
    acc: [u64; 4],
    /// Reward index at the start of every day that received rewards.
    snapshots: TreeMap<u32, [u64; 4]>,
    /// Weight changes that take effect at the start of a day.
    steps: TreeMap<u32, i128>,
    last_day: u32,
    total_weight: u128,
    /// Rewards that arrived while nobody had weight yet; paid out with the next deposit.
    undistributed: u128,
    /// NEAR owed to holders (deposited minus claimed). The rest of the balance pays for storage.
    liability: u128,
    paid: u128,
}

fn to_u256(x: [u64; 4]) -> U256 {
    U256(x)
}

fn today() -> u32 {
    (env::block_timestamp() / DAY_NS) as u32
}

fn event(standard: &str, version: &str, name: &str, data: String) {
    env::log_str(&format!(r#"EVENT_JSON:{{"standard":"{standard}","version":"{version}","event":"{name}","data":[{data}]}}"#));
}

fn json_str(s: &str) -> String {
    near_sdk::serde_json::to_string(s).unwrap()
}

#[near]
impl Token {
    #[init]
    pub fn new(launchpad: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        require!(metadata.decimals == grow_common::DECIMALS, "decimals must be 18");
        let mut t = Self {
            launchpad: launchpad.clone(),
            metadata,
            total_supply: total_supply.0,
            holders: LookupMap::new(Key::Holders),
            acc: [0; 4],
            snapshots: TreeMap::new(Key::Snapshots),
            steps: TreeMap::new(Key::Steps),
            last_day: today(),
            total_weight: 0,
            undistributed: 0,
            liability: 0,
            paid: 0,
        };
        t.holders.insert(launchpad.clone(), Holder { balance: total_supply.0, since: today(), settled_day: today(), ..Default::default() });
        event("nep141", "1.0.0", "ft_mint", format!(r#"{{"owner_id":{},"amount":"{}"}}"#, json_str(launchpad.as_str()), total_supply.0));
        t
    }

    // ---------------------------------------------------------------- NEP-141

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0, None, memo);
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        near_sdk::assert_one_yocto();
        require!(env::prepaid_gas() > GAS_FOR_TRANSFER_CALL, "more gas is needed");
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0, None, memo);
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(env::prepaid_gas().saturating_sub(GAS_FOR_TRANSFER_CALL))
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).ft_resolve_transfer(sender, receiver_id, amount))
            .into()
    }

    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result_checked(0, 16_384) {
            Ok(v) => near_sdk::serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            _ => amount.0,
        };
        if unused == 0 {
            return amount;
        }
        let back = self.holders.get(&receiver_id).map(|h| h.balance.min(unused)).unwrap_or(0);
        if back > 0 {
            if self.holders.contains_key(&sender_id) {
                let since = self.holders.get(&sender_id).map(|h| h.since);
                self.transfer(&receiver_id, &sender_id, back, since, Some("refund".into()));
            } else {
                // The sender unregistered meanwhile: the coins are burned rather than lost to the receiver.
                self.burn_from(&receiver_id, back);
            }
        }
        U128(amount.0 - back)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.holders.get(&account_id).map(|h| h.balance).unwrap_or(0))
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }

    // ---------------------------------------------------------------- NEP-145

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit().as_yoctonear();
        if self.holders.contains_key(&account) {
            if deposit > 0 {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(deposit)).detach();
            }
        } else {
            require!(deposit >= STORAGE_DEPOSIT, "attach at least 0.00125 NEAR");
            let d = today();
            self.holders.insert(account, Holder { since: d, settled_day: d, settled_acc: self.acc, ..Default::default() });
            if deposit > STORAGE_DEPOSIT {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(deposit - STORAGE_DEPOSIT)).detach();
            }
        }
        StorageBalance { total: U128(STORAGE_DEPOSIT), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.holders.contains_key(&account_id).then(|| StorageBalance { total: U128(STORAGE_DEPOSIT), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_DEPOSIT), max: Some(U128(STORAGE_DEPOSIT)) }
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        near_sdk::assert_one_yocto();
        require!(amount.map(|a| a.0).unwrap_or(0) == 0, "nothing to withdraw: storage is registration only");
        StorageBalance { total: U128(STORAGE_DEPOSIT), available: U128(0) }
    }

    /// Closes an empty account and returns its storage deposit. Unclaimed rewards are paid out first.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        require!(account != self.launchpad, "the launchpad stays registered");
        if !self.holders.contains_key(&account) {
            return false;
        }
        let d = self.roll();
        let mut h = self.holders.get(&account).unwrap().clone();
        self.settle(&mut h, d);
        if h.balance > 0 {
            require!(force.unwrap_or(false), "the account still holds coins; pass force to burn them");
            self.unweight(&h, d);
            self.total_supply -= h.balance;
            event("nep141", "1.0.0", "ft_burn", format!(r#"{{"owner_id":{},"amount":"{}"}}"#, json_str(account.as_str()), h.balance));
        }
        self.holders.remove(&account);
        let out = h.claimable;
        self.liability -= out;
        self.paid += out;
        Promise::new(account).transfer(NearToken::from_yoctonear(STORAGE_DEPOSIT + out)).detach();
        true
    }

    // ---------------------------------------------------------------- rewards

    /// Adds NEAR to the holders' rewards. Anyone may top it up; the launchpad sends the holders' fee share.
    #[payable]
    pub fn deposit_rewards(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR");
        let d = self.roll();
        self.liability += amount;
        let pot = amount + self.undistributed;
        if self.total_weight == 0 {
            self.undistributed = pot;
        } else {
            if self.snapshots.get(&d).is_none() {
                self.snapshots.insert(&d, &self.acc);
            }
            let add = U256::from(pot) * U256::from(PREC) / U256::from(self.total_weight);
            self.acc = (to_u256(self.acc) + add).0;
            self.undistributed = 0;
        }
        event("grow-token", "1.0.0", "reward_deposit", format!(r#"{{"amount":"{amount}","total_weight":"{}"}}"#, self.total_weight));
    }

    /// Pays the caller's rewards.
    pub fn claim_rewards(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let d = self.roll();
        let mut h = self.holders.get(&account).cloned().unwrap_or_else(|| env::panic_str("not registered"));
        self.settle(&mut h, d);
        let out = h.claimable;
        h.claimable = 0;
        self.holders.insert(account.clone(), h);
        if out > 0 {
            self.liability -= out;
            self.paid += out;
            Promise::new(account.clone()).transfer(NearToken::from_yoctonear(out)).detach();
            event("grow-token", "1.0.0", "reward_claim", format!(r#"{{"owner_id":{},"amount":"{out}"}}"#, json_str(account.as_str())));
        }
        U128(out)
    }

    pub fn hold_info(&self, account_id: AccountId) -> HoldInfo {
        let d = today();
        let Some(h) = self.holders.get(&account_id).cloned() else {
            return HoldInfo { balance: U128(0), since_day: d, held_days: 0, multiplier: 0, claimable: U128(0) };
        };
        let excluded = account_id == self.launchpad;
        let claimable = if excluded { 0 } else { h.claimable + self.pending(&h, d) };
        let age = d.saturating_sub(h.since);
        HoldInfo {
            balance: U128(h.balance),
            since_day: h.since,
            held_days: age,
            multiplier: if excluded { 0 } else { hold_multiplier(age) as u32 },
            claimable: U128(claimable),
        }
    }

    pub fn reward_stats(&self) -> RewardStats {
        RewardStats {
            total_weight: U128(self.total_weight_at(today())),
            index: to_u256(self.acc).to_string(),
            undistributed: U128(self.undistributed),
            liability: U128(self.liability),
            paid: U128(self.paid),
        }
    }

    pub fn launchpad_id(&self) -> AccountId {
        self.launchpad.clone()
    }

    // ---------------------------------------------------------------- launchpad only

    /// Burns coins the launchpad holds (buybacks, crossings).
    pub fn burn(&mut self, amount: U128) {
        require!(env::predecessor_account_id() == self.launchpad, "launchpad only");
        let lp = self.launchpad.clone();
        self.burn_from(&lp, amount.0);
    }

    /// Hands out coins with a given hold date, so holders of two crossed tokens keep their hold time.
    pub fn transfer_with_since(&mut self, receiver_id: AccountId, amount: U128, since_day: u32) {
        require!(env::predecessor_account_id() == self.launchpad, "launchpad only");
        require!(since_day <= today(), "since cannot be in the future");
        let lp = self.launchpad.clone();
        self.transfer(&lp, &receiver_id, amount.0, Some(since_day), Some("crossing".into()));
    }

    // ---------------------------------------------------------------- internals

    fn is_excluded(&self, a: &AccountId) -> bool {
        *a == self.launchpad
    }

    fn transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128, incoming_since: Option<u32>, memo: Option<String>) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        require!(self.holders.contains_key(to), "the receiver is not registered");
        let d = self.roll();
        let mut a = self.holders.get(from).cloned().unwrap_or_else(|| env::panic_str("the sender is not registered"));
        require!(a.balance >= amount, "not enough balance");
        let mut b = self.holders.get(to).cloned().unwrap();

        if !self.is_excluded(from) {
            self.settle(&mut a, d);
            self.unweight(&a, d);
        }
        a.balance -= amount;
        if !self.is_excluded(from) {
            self.weight(&a, d);
        }

        if !self.is_excluded(to) {
            self.settle(&mut b, d);
            self.unweight(&b, d);
            let s_in = incoming_since.unwrap_or(d).min(d) as u128;
            b.since = if b.balance == 0 { s_in as u32 } else { ((b.balance * b.since as u128 + amount * s_in) / (b.balance + amount)) as u32 };
        }
        b.balance += amount;
        if !self.is_excluded(to) {
            self.weight(&b, d);
        }
        self.holders.insert(from.clone(), a);
        self.holders.insert(to.clone(), b);
        let memo = memo.map(|m| format!(r#","memo":{}"#, json_str(&m))).unwrap_or_default();
        event(
            "nep141",
            "1.0.0",
            "ft_transfer",
            format!(r#"{{"old_owner_id":{},"new_owner_id":{},"amount":"{amount}"{memo}}}"#, json_str(from.as_str()), json_str(to.as_str())),
        );
    }

    fn burn_from(&mut self, from: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        let d = self.roll();
        let mut a = self.holders.get(from).cloned().unwrap_or_else(|| env::panic_str("not registered"));
        require!(a.balance >= amount, "not enough balance");
        if !self.is_excluded(from) {
            self.settle(&mut a, d);
            self.unweight(&a, d);
        }
        a.balance -= amount;
        if !self.is_excluded(from) {
            self.weight(&a, d);
        }
        self.total_supply -= amount;
        self.holders.insert(from.clone(), a);
        event("nep141", "1.0.0", "ft_burn", format!(r#"{{"owner_id":{},"amount":"{amount}"}}"#, json_str(from.as_str())));
    }

    /// Applies weight steps that took effect on or before today.
    fn roll(&mut self) -> u32 {
        let d = today();
        if d > self.last_day {
            while let Some(day) = self.steps.min() {
                if day > d {
                    break;
                }
                let delta = self.steps.remove(&day).unwrap();
                self.total_weight = (self.total_weight as i128 + delta) as u128;
            }
            self.last_day = d;
        }
        d
    }

    fn total_weight_at(&self, d: u32) -> u128 {
        let mut w = self.total_weight as i128;
        if d > self.last_day {
            for (day, delta) in self.steps.iter() {
                if day > d {
                    break;
                }
                w += delta;
            }
        }
        w as u128
    }

    /// Reward index at the start of day `d` (d <= today). Rewards only arrive on days with a snapshot, so a day
    /// without one has the index of the next snapshot day, or the current index if there is none.
    fn acc_at_start(&self, d: u32) -> U256 {
        match self.snapshots.ceil_key(&d) {
            Some(k) => to_u256(self.snapshots.get(&k).unwrap()),
            None => to_u256(self.acc),
        }
    }

    fn pending(&self, h: &Holder, d: u32) -> u128 {
        if h.balance == 0 {
            return 0;
        }
        let mut start_acc = to_u256(h.settled_acc);
        let mut start_day = h.settled_day;
        let mut sum = U256::zero();
        for (step, _) in TIER_STEPS {
            let b = h.since + step;
            if b <= h.settled_day || b > d {
                continue;
            }
            let a = self.acc_at_start(b);
            let m = hold_multiplier(start_day.saturating_sub(h.since));
            sum += U256::from(h.balance) * U256::from(m) * (a - start_acc);
            start_acc = a;
            start_day = b;
        }
        let m = hold_multiplier(start_day.saturating_sub(h.since));
        sum += U256::from(h.balance) * U256::from(m) * (to_u256(self.acc) - start_acc);
        (sum / U256::from(PREC)).as_u128()
    }

    fn settle(&self, h: &mut Holder, d: u32) {
        h.claimable += self.pending(h, d);
        h.settled_acc = self.acc;
        h.settled_day = d;
    }

    /// Removes a holder's weight today and their scheduled steps.
    fn unweight(&mut self, h: &Holder, d: u32) {
        if h.balance == 0 {
            return;
        }
        let now = h.balance * hold_multiplier(d.saturating_sub(h.since));
        self.total_weight -= now;
        for (step, inc) in TIER_STEPS {
            let day = h.since + step;
            if day > d {
                self.add_step(day, -((h.balance * inc) as i128));
            }
        }
    }

    fn weight(&mut self, h: &Holder, d: u32) {
        if h.balance == 0 {
            return;
        }
        self.total_weight += h.balance * hold_multiplier(d.saturating_sub(h.since));
        for (step, inc) in TIER_STEPS {
            let day = h.since + step;
            if day > d {
                self.add_step(day, (h.balance * inc) as i128);
            }
        }
    }

    fn add_step(&mut self, day: u32, delta: i128) {
        let v = self.steps.get(&day).unwrap_or(0) + delta;
        if v == 0 {
            self.steps.remove(&day);
        } else {
            self.steps.insert(&day, &v);
        }
    }
}

#[cfg(test)]
mod tests;
