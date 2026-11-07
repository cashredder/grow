use super::*;
use crate::create::CreateArgs;
use crate::market::fill_buy;
use grow_common::{mul_div, swap_out, BPS, ONE_TOKEN, POOL_TOKENS};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::test_vm_config;
use near_sdk::testing_env;
use near_sdk::RuntimeFeesConfig;

const T0: u64 = 1_800_000_000_000; // ms

fn a(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, ms: u64, deposit: u128, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(a("grow.near"))
        .predecessor_account_id(a(pred))
        .signer_account_id(a(pred))
        .block_timestamp(ms * 1_000_000)
        .block_height(ms / 1000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000_000))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

use near_sdk::{Gas, PromiseResult};

fn at(pred: &str, ms: u64, deposit: u128) {
    ctx(pred, ms, deposit, vec![]);
}

fn ok() -> Vec<PromiseResult> {
    vec![PromiseResult::Successful(vec![])]
}

fn setup() -> Launchpad {
    at("owner.near", T0, 0);
    let mut l = Launchpad::new(a("owner.near"), a("treasury.near"), a("relayer.near"));
    at("owner.near", T0, 0);
    l.token_code.insert(0, vec![0u8; 2_000]);
    l
}

fn launch(l: &mut Launchpad, dev: &str, ticker: &str, gardener: bool, ms: u64) -> String {
    let need = l.config.create_fee.0 + l.config.token_storage.0;
    at(dev, ms, need);
    l.create_token(CreateArgs {
        name: format!("{ticker} token"),
        ticker: ticker.into(),
        reference: None,
        reference_hash: None,
        icon: None,
        fee_bps: Some(100),
        redirect_pct: None,
        redirect_to: None,
        gardener: Some(gardener),
        gardener_strategy: None,
        dev_buy: None,
    });
    let id = l.tokens.keys().last().cloned().unwrap();
    ctx("grow.near", ms, 0, ok());
    l.on_token_created(id.clone(), a(dev), U128(0), U128(0), U128(need));
    id
}

fn buy(l: &mut Launchpad, who: &str, id: &str, near: u128, ms: u64) -> u128 {
    let reg = !l.registered.contains(&reg_key(id, &a(who)));
    at(who, ms, near * ONE_NEAR + if reg { STORAGE_DEPOSIT } else { 0 });
    let before = l.token(id).tok_reserve.0;
    l.buy(id.into(), U128(0), None);
    let t = l.token(id);
    if t.phase == Phase::Pool && before > t.tok_reserve.0 + POOL_TOKENS {
        return before - CURVE_END_TOKENS;
    }
    before.saturating_sub(t.tok_reserve.0)
}

fn sell(l: &mut Launchpad, who: &str, id: &str, tokens: u128, ms: u64) {
    let account = l.token(id).account.clone();
    at(account.as_str(), ms, 0);
    let _ = l.ft_on_transfer(a(who), U128(tokens), r#"{"action":"sell","min_out":"0"}"#.into());
}

#[test]
fn launch_opens_a_curve() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let t = l.token(&id);
    assert!(id.starts_with("oak-"));
    assert_eq!(t.account.as_str(), format!("{id}.grow.near"));
    assert_eq!(t.phase, Phase::Curve);
    assert_eq!(t.near_reserve.0, VIRTUAL_NEAR);
    assert_eq!(market_inventory(&t), SUPPLY);
    assert_eq!(l.platform_earned.0, ONE_NEAR);
}

#[test]
fn failed_deploy_refunds_and_forgets() {
    let mut l = setup();
    let need = l.config.create_fee.0 + l.config.token_storage.0;
    at("dev.near", T0, need);
    l.create_token(CreateArgs { name: "Moss".into(), ticker: "MOSS".into(), reference: None, reference_hash: None, icon: None, fee_bps: None, redirect_pct: None, redirect_to: None, gardener: None, gardener_strategy: None, dev_buy: None });
    let id = l.tokens.keys().last().cloned().unwrap();
    ctx("grow.near", T0, 0, vec![PromiseResult::Failed]);
    l.on_token_created(id.clone(), a("dev.near"), U128(0), U128(0), U128(need));
    assert!(l.get_token(id).is_none());
    assert_eq!(l.platform_earned.0, 0);
}

#[test]
fn launch_window_fee_falls_to_normal() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let t = l.token(&id);
    assert_eq!(market::rates(&l.config, &t, T0).0, 5_000);
    assert_eq!(market::rates(&l.config, &t, T0 + 30_000).0, 2_550);
    assert_eq!(market::rates(&l.config, &t, T0 + 60_000).0, 100);
}

#[test]
fn buys_follow_the_curve_and_split_the_fee() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    let got = buy(&mut l, "alice.near", &id, 100, ms);
    let net = 100 * ONE_NEAR * 99 / 100;
    assert_eq!(got, swap_out(VIRTUAL_NEAR, VIRTUAL_TOKENS, net));
    let t = l.token(&id);
    let fee = ONE_NEAR; // 1% of 100 NEAR
    assert_eq!(t.dev_earned.0, fee * 30 / 100);
    assert_eq!(t.pending_holders.0, fee * 10 / 100);
    assert_eq!(l.platform_earned.0, ONE_NEAR + fee * 60 / 100);
    assert!(l.registered.contains(&reg_key(&id, &a("alice.near"))));
}

#[test]
fn selling_returns_near_minus_the_fee() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    let got = buy(&mut l, "alice.near", &id, 100, ms);
    let t = l.token(&id);
    let gross = swap_out(t.tok_reserve.0, t.near_reserve.0, got);
    sell(&mut l, "alice.near", &id, got, ms + 1);
    let t2 = l.token(&id);
    assert_eq!(t.near_reserve.0 - t2.near_reserve.0, gross);
    // A round trip on the curve loses the two fees and a little rounding, nothing more.
    assert!(t2.near_reserve.0 >= VIRTUAL_NEAR);
}

#[test]
fn the_buy_that_sells_out_the_curve_opens_the_pool() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    let before_balance = l.platform_earned.0;
    buy(&mut l, "whale.near", &id, 10_000, ms);
    let t = l.token(&id);
    assert_eq!(t.phase, Phase::Pool);
    assert_eq!(t.tok_reserve.0, POOL_TOKENS);
    // ~3398.6 NEAR raised moves into the pool.
    assert!(t.near_reserve.0 > 3_398 * ONE_NEAR && t.near_reserve.0 < 3_399 * ONE_NEAR);
    assert_eq!(t.pool_open_near, t.near_reserve);
    assert!(l.platform_earned.0 > before_balance);
    // Pool trades pay 0.5%.
    assert_eq!(market::rates(&l.config, &t, ms).0, 50);
}

#[test]
fn referrers_earn_a_tenth_of_the_platform_share_for_90_days() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    at("bob.near", ms, 100 * ONE_NEAR + STORAGE_DEPOSIT);
    l.buy(id.clone(), U128(0), Some(a("ref.near")));
    assert_eq!(l.credits_of(a("ref.near")).0, ONE_NEAR * 6 / 100);
    // Self-referral is ignored, and the first referrer sticks.
    at("bob.near", ms + 1, 100 * ONE_NEAR);
    l.buy(id.clone(), U128(0), Some(a("other.near")));
    assert_eq!(l.credits_of(a("other.near")).0, 0);
    // After 90 days nothing more.
    let before = l.credits_of(a("ref.near")).0;
    at("bob.near", ms + 91 * DAY_MS, 100 * ONE_NEAR);
    l.buy(id, U128(0), None);
    assert_eq!(l.credits_of(a("ref.near")).0, before);
}

#[test]
#[should_panic(expected = "slippage")]
fn min_out_protects_buyers() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    at("alice.near", T0 + 120_000, 10 * ONE_NEAR + STORAGE_DEPOSIT);
    l.buy(id, U128(1_000_000_000 * ONE_TOKEN), None);
}

#[test]
fn redirect_to_buyback_and_buyback_caps() {
    let mut l = setup();
    let need = l.config.create_fee.0 + l.config.token_storage.0;
    at("dev.near", T0, need);
    l.create_token(CreateArgs { name: "Bonsai".into(), ticker: "BNS".into(), reference: None, reference_hash: None, icon: None, fee_bps: Some(500), redirect_pct: Some(100), redirect_to: Some("buyback".into()), gardener: None, gardener_strategy: None, dev_buy: None });
    let id = l.tokens.keys().last().cloned().unwrap();
    ctx("grow.near", T0, 0, ok());
    l.on_token_created(id.clone(), a("dev.near"), U128(0), U128(0), U128(need));
    let ms = T0 + 120_000;
    buy(&mut l, "alice.near", &id, 2_000, ms);
    let t = l.token(&id);
    assert_eq!(t.dev_earned.0, 0);
    let pool = t.buyback_pool.0;
    assert_eq!(pool, 100 * ONE_NEAR * 30 / 100);
    at("anyone.near", ms + 1_000, 0);
    l.buyback(id.clone());
    let t2 = l.token(&id);
    let cap = VIRTUAL_NEAR * 50 / BPS;
    assert_eq!(pool - t2.buyback_pool.0, cap.min(pool));
    assert!(t2.burned.0 > 0);
}

#[test]
#[should_panic(expected = "one buyback per block")]
fn one_buyback_per_block() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let mut t = l.token(&id);
    t.buyback_pool = U128(100 * ONE_NEAR);
    l.put_token(t);
    at("x.near", T0 + 120_000, 0);
    l.buyback(id.clone());
    at("x.near", T0 + 120_000, 0);
    l.buyback(id);
}

#[test]
fn vault_trades_within_limits_and_is_fired_at_30_percent() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    let seed_coins = buy(&mut l, "seed.near", &id, 500, ms);
    at("owner.near", ms, 100 * ONE_NEAR);
    let vid = l.create_house_vault("Oak".into(), "trend".into(), U128(80 * ONE_NEAR));
    at("relayer.near", ms + 1, 0);
    l.vault_trade(vid, id.clone(), true, U128(80 * ONE_NEAR), U128(0), Some("Volume is rising".into()));
    let v = l.get_vault(vid).unwrap();
    assert_eq!(v.vault.cash.0, 20 * ONE_NEAR);
    assert_eq!(v.vault.status, VaultStatus::Active);
    assert_eq!(l.token(&id).vault_held.0, v.vault.positions[0].amount.0);
    // The early buyer dumps everything: the vault's coins lose about 45%, its equity about 37%.
    sell(&mut l, "seed.near", &id, seed_coins, ms + 2);
    at("anyone.near", ms + 3, 0);
    let status = l.check_vault(vid);
    let v = l.get_vault(vid).unwrap();
    assert!(v.drawdown_bps >= 3_000, "drawdown {}", v.drawdown_bps);
    assert_eq!(status, VaultStatus::Fired);
    assert_eq!(v.vault.status, VaultStatus::Fired);
}

#[test]
#[should_panic(expected = "daily limit reached")]
fn vault_daily_limit() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    at("owner.near", T0 + 120_000, 100 * ONE_NEAR);
    let vid = l.create_house_vault("Oak".into(), "trend".into(), U128(10 * ONE_NEAR));
    at("relayer.near", T0 + 120_001, 0);
    l.vault_trade(vid, id.clone(), true, U128(6 * ONE_NEAR), U128(0), None);
    at("relayer.near", T0 + 120_002, 0);
    l.vault_trade(vid, id, true, U128(6 * ONE_NEAR), U128(0), None);
}

#[test]
#[should_panic(expected = "agent only")]
fn only_the_agent_trades_a_vault() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    at("alice.near", T0 + 120_000, 10 * ONE_NEAR);
    let vid = l.create_vault("Mine".into(), "steady".into(), None, U128(5 * ONE_NEAR), 3_000, Allowed::All, 30);
    at("mallory.near", T0 + 120_001, 0);
    l.vault_trade(vid, id, true, U128(ONE_NEAR), U128(0), None);
}

#[test]
fn copies_follow_the_leader_once_and_in_time() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    at("owner.near", ms, 100 * ONE_NEAR);
    let leader = l.create_house_vault("Oak".into(), "trend".into(), U128(100 * ONE_NEAR));
    at("bob.near", ms, 20 * ONE_NEAR);
    let copy = l.copy_vault(leader, U128(5 * ONE_NEAR), 3_000);
    at("relayer.near", ms + 10, 0);
    l.vault_trade(leader, id.clone(), true, U128(30 * ONE_NEAR), U128(0), None);
    at("relayer.near", ms + 20, 0);
    l.copy_trade(copy, 1, U128(0));
    let c = l.get_vault(copy).unwrap().vault;
    assert_eq!(c.cash.0, 15 * ONE_NEAR);
    // The leader sells half; the copy sells half of its own position.
    let lp = l.get_vault(leader).unwrap().vault.positions[0].amount.0;
    at("relayer.near", ms + 30, 0);
    l.vault_trade(leader, id.clone(), false, U128(lp / 2), U128(0), None);
    let before = c.positions[0].amount.0;
    at("relayer.near", ms + 40, 0);
    l.copy_trade(copy, 2, U128(0));
    let after = l.get_vault(copy).unwrap().vault.positions[0].amount.0;
    let sold = before - after;
    assert!(sold.abs_diff(before / 2) <= before / 1_000);
}

#[test]
#[should_panic(expected = "already copied")]
fn a_trade_is_copied_once() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    at("owner.near", ms, 100 * ONE_NEAR);
    let leader = l.create_house_vault("Oak".into(), "trend".into(), U128(100 * ONE_NEAR));
    at("bob.near", ms, 20 * ONE_NEAR);
    let copy = l.copy_vault(leader, U128(5 * ONE_NEAR), 3_000);
    at("relayer.near", ms + 10, 0);
    l.vault_trade(leader, id, true, U128(30 * ONE_NEAR), U128(0), None);
    at("relayer.near", ms + 20, 0);
    l.copy_trade(copy, 1, U128(0));
    at("relayer.near", ms + 21, 0);
    l.copy_trade(copy, 1, U128(0));
}

#[test]
#[should_panic(expected = "too late to copy")]
fn stale_trades_are_not_copied() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    at("owner.near", ms, 100 * ONE_NEAR);
    let leader = l.create_house_vault("Oak".into(), "trend".into(), U128(100 * ONE_NEAR));
    at("bob.near", ms, 20 * ONE_NEAR);
    let copy = l.copy_vault(leader, U128(5 * ONE_NEAR), 3_000);
    at("relayer.near", ms + 10, 0);
    l.vault_trade(leader, id, true, U128(30 * ONE_NEAR), U128(0), None);
    at("relayer.near", ms + 10 + 121_000, 0);
    l.copy_trade(copy, 1, U128(0));
}

#[test]
fn dev_gardener_receives_dev_fees_and_trades_its_token_only() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", true, T0);
    let t = l.token(&id);
    let vid = t.dev_vault.unwrap();
    buy(&mut l, "alice.near", &id, 100, T0 + 120_000);
    let v = l.get_vault(vid).unwrap().vault;
    assert_eq!(v.cash.0, ONE_NEAR * 30 / 100);
    assert_eq!(l.token(&id).dev_earned.0, 0);
    assert_eq!(v.allowed, Allowed::Only(id.clone()));
}

#[test]
fn crossing_prices_the_new_token_so_supply_is_exact() {
    let mut l = setup();
    let x = launch(&mut l, "ann.near", "OAK", false, T0);
    let y = launch(&mut l, "ben.near", "MOSS", false, T0);
    let ms = T0 + 120_000;
    buy(&mut l, "alice.near", &x, 800, ms);
    buy(&mut l, "bob.near", &y, 300, ms);
    at("ann.near", ms + 1, l.config.token_storage.0);
    let cid = l.propose_cross(x.clone(), y.clone(), 6_000, "Oak Moss".into(), "OMOSS".into(), None);
    at("ben.near", ms + 2, 0);
    l.accept_cross(cid);
    at("anyone.near", ms + 2 + DAY_MS, 0);
    l.finalize_cross(cid);
    let c = l.get_crossing(cid).unwrap();
    let new_id = c.new_token.clone().unwrap();
    ctx("grow.near", ms + 3 + DAY_MS, 0, ok());
    l.on_cross_deployed(cid);
    let (ta, tb, tc) = (l.token(&x), l.token(&y), l.token(&new_id));
    assert_eq!(ta.phase, Phase::Merged);
    assert_eq!(tc.phase, Phase::Pool);
    assert_eq!(tc.co_dev, Some(a("ben.near")));
    // Coins outside the markets convert; with the pool's coins that is the whole supply.
    let outside_a = SUPPLY - ta.burned.0;
    let outside_b = SUPPLY - tb.burned.0;
    let converted = mul_div(outside_a, c.rate_a.0, 1_000_000_000_000_000_000) + mul_div(outside_b, c.rate_b.0, 1_000_000_000_000_000_000);
    let total = converted + tc.tok_reserve.0;
    assert!(total <= SUPPLY);
    assert!(SUPPLY - total < SUPPLY / 1_000_000, "off by {}", SUPPLY - total);
    // Dev rewards vest and split 60/40.
    assert!(tc.vest_until_ms.0 > ms + DAY_MS);
    assert_eq!(tc.split_bps, 6_000);
}

#[test]
#[should_panic(expected = "still vesting")]
fn crossed_dev_rewards_vest() {
    let mut l = setup();
    let x = launch(&mut l, "ann.near", "OAK", false, T0);
    let mut t = l.token(&x);
    t.co_dev = Some(a("ben.near"));
    t.vest_until_ms = U64(T0 + 10 * DAY_MS);
    t.dev_earned = U128(ONE_NEAR);
    l.put_token(t);
    at("ann.near", T0 + DAY_MS, 0);
    l.claim_dev(x);
}

#[test]
fn quote_matches_execution() {
    let mut l = setup();
    let id = launch(&mut l, "dev.near", "OAK", false, T0);
    let ms = T0 + 120_000;
    at("x.near", ms, 0);
    let q = l.quote_buy(id.clone(), U128(50 * ONE_NEAR));
    let got = buy(&mut l, "alice.near", &id, 50, ms);
    assert_eq!(q.out.0, got);
    let t = l.token(&id);
    let f = fill_buy(&t, ONE_NEAR, 100, 100);
    assert!(f.out > 0);
}
