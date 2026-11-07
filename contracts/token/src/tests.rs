use super::*;
use grow_common::{ONE_NEAR, ONE_TOKEN, SUPPLY};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const DAY0: u64 = 20_000; // some day after the epoch

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(pred: &str, day: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("oak-1.grow.near"))
        .predecessor_account_id(acc(pred))
        .block_timestamp((DAY0 + day) * DAY_NS + 1_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn setup() -> Token {
    at("grow.near", 0, 0);
    let t = Token::new(
        acc("grow.near"),
        U128(SUPPLY),
        FungibleTokenMetadata { spec: "ft-1.0.0".into(), name: "Old Oak".into(), symbol: "OAK".into(), icon: None, reference: None, reference_hash: None, decimals: 18 },
    );
    t
}

fn register(t: &mut Token, who: &str, day: u64) {
    at(who, day, STORAGE_DEPOSIT);
    t.storage_deposit(None, None);
}

fn give(t: &mut Token, who: &str, tokens: u128, day: u64) {
    at("grow.near", day, 1);
    t.ft_transfer(acc(who), U128(tokens * ONE_TOKEN), None);
}

fn reward(t: &mut Token, near: u128, day: u64) {
    at("grow.near", day, near * ONE_NEAR);
    t.deposit_rewards();
}

fn claimable(t: &Token, who: &str, day: u64) -> u128 {
    at(who, day, 0);
    t.hold_info(acc(who)).claimable.0
}

fn near_eq(a: u128, b: u128) {
    let diff = a.abs_diff(b);
    assert!(diff <= 1_000, "{a} vs {b}");
}

#[test]
fn whole_supply_starts_with_the_launchpad() {
    let t = setup();
    assert_eq!(t.ft_total_supply().0, SUPPLY);
    assert_eq!(t.ft_balance_of(acc("grow.near")).0, SUPPLY);
}

#[test]
fn nothing_is_earned_before_three_days_and_it_waits() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    reward(&mut t, 10, 1);
    assert_eq!(claimable(&t, "alice.near", 1), 0);
    assert_eq!(t.reward_stats().undistributed.0, 10 * ONE_NEAR);
    // Day 3: alice has weight; the waiting 10 NEAR and the new 5 NEAR are hers.
    reward(&mut t, 5, 3);
    near_eq(claimable(&t, "alice.near", 3), 15 * ONE_NEAR);
}

#[test]
fn longer_holds_earn_more() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    register(&mut t, "bob.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    give(&mut t, "bob.near", 1_000, 7);
    // Day 10: alice x2, bob x1 (3 days): 2/3 and 1/3.
    reward(&mut t, 30, 10);
    near_eq(claimable(&t, "alice.near", 10), 20 * ONE_NEAR);
    near_eq(claimable(&t, "bob.near", 10), 10 * ONE_NEAR);
}

#[test]
fn weights_step_up_without_any_transaction() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    register(&mut t, "bob.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    give(&mut t, "bob.near", 1_000, 1);
    // Day 4: alice x1, bob x1 (3 days) -> 50/50.
    reward(&mut t, 10, 4);
    // Day 5: alice reaches x1.5 overnight, bob still x1 -> 60/40.
    reward(&mut t, 10, 5);
    near_eq(claimable(&t, "alice.near", 5), 5 * ONE_NEAR + 6 * ONE_NEAR);
    near_eq(claimable(&t, "bob.near", 5), 5 * ONE_NEAR + 4 * ONE_NEAR);
}

#[test]
fn selling_keeps_the_hold_date_and_buying_averages_it() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    // Day 10, alice sends half back (a sell): still held since day 0.
    at("alice.near", 10, 1);
    t.ft_transfer(acc("grow.near"), U128(500 * ONE_TOKEN), None);
    at("alice.near", 10, 0);
    assert_eq!(t.hold_info(acc("alice.near")).held_days, 10);
    // She buys 500 more on day 10: average of day 0 and day 10 -> day 5.
    give(&mut t, "alice.near", 500, 10);
    at("alice.near", 10, 0);
    let h = t.hold_info(acc("alice.near"));
    assert_eq!(h.held_days, 5);
    assert_eq!(h.multiplier, 150);
}

#[test]
fn rewards_are_settled_before_balances_change() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    register(&mut t, "bob.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    give(&mut t, "bob.near", 1_000, 0);
    reward(&mut t, 10, 3);
    // Alice sends everything to bob afterwards: her 5 NEAR stay hers.
    at("alice.near", 3, 1);
    t.ft_transfer(acc("bob.near"), U128(1_000 * ONE_TOKEN), None);
    reward(&mut t, 10, 4);
    near_eq(claimable(&t, "alice.near", 4), 5 * ONE_NEAR);
    // Bob: 5 from day 3, then all 10 (2000 coins, averaged to day 1 -> x1).
    near_eq(claimable(&t, "bob.near", 4), 15 * ONE_NEAR);
}

#[test]
fn claims_never_exceed_deposits() {
    let mut t = setup();
    let names = ["a.near", "b.near", "c.near", "d.near"];
    for (i, n) in names.iter().enumerate() {
        register(&mut t, n, 0);
        give(&mut t, n, 100 + 37 * i as u128, i as u64);
    }
    for day in 3..30u64 {
        reward(&mut t, 1 + day as u128 % 3, day);
        if day % 4 == 0 {
            at(names[(day as usize) % 4], day, 1);
            t.ft_transfer(acc("grow.near"), U128(7 * ONE_TOKEN), None);
        }
    }
    let mut total = 0;
    for n in names {
        at(n, 30, 0);
        total += t.claim_rewards().0;
    }
    let deposited: u128 = (3..30u64).map(|d| (1 + d as u128 % 3) * ONE_NEAR).sum();
    assert!(total <= deposited);
    assert!(deposited - total < ONE_NEAR / 1_000_000, "dust only: {}", deposited - total);
}

#[test]
fn launchpad_never_earns() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    give(&mut t, "alice.near", 1, 0);
    reward(&mut t, 10, 20);
    at("grow.near", 20, 0);
    assert_eq!(t.hold_info(acc("grow.near")).claimable.0, 0);
    near_eq(claimable(&t, "alice.near", 20), 10 * ONE_NEAR);
}

#[test]
fn crossing_keeps_hold_time() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    at("grow.near", 12, 0);
    t.transfer_with_since(acc("alice.near"), U128(10 * ONE_TOKEN), DAY0 as u32 + 1);
    at("alice.near", 12, 0);
    assert_eq!(t.hold_info(acc("alice.near")).multiplier, 200);
}

#[test]
#[should_panic(expected = "launchpad only")]
fn only_the_launchpad_burns() {
    let mut t = setup();
    at("mallory.near", 0, 0);
    t.burn(U128(1));
}

#[test]
fn burns_reduce_supply() {
    let mut t = setup();
    at("grow.near", 0, 0);
    t.burn(U128(5 * ONE_TOKEN));
    assert_eq!(t.ft_total_supply().0, SUPPLY - 5 * ONE_TOKEN);
}

#[test]
fn launchpad_sell_moves_the_holders_coins_to_the_launchpad() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    at("grow.near", 1, 0);
    let _ = t.launchpad_sell(acc("alice.near"), U128(400 * ONE_TOKEN), r#"{"action":"sell","min_out":"0","to_balance":true}"#.into());
    assert_eq!(t.ft_balance_of(acc("alice.near")).0, 600 * ONE_TOKEN);
    assert_eq!(t.ft_balance_of(acc("grow.near")).0, SUPPLY - 600 * ONE_TOKEN);
    assert_eq!(t.grow_token_version(), 2);
}

#[test]
#[should_panic(expected = "launchpad only")]
fn only_the_launchpad_can_sell_for_a_holder() {
    let mut t = setup();
    register(&mut t, "alice.near", 0);
    give(&mut t, "alice.near", 1_000, 0);
    at("mallory.near", 1, 0);
    let _ = t.launchpad_sell(acc("alice.near"), U128(400 * ONE_TOKEN), "{}".into());
}
