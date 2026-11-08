//! The whole market on a sandbox chain, with the real contracts: a launch, the buy that sells out the curve
//! and opens the pool, trading in the pool, and holder rewards after three days of holding.
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const YOCTO: f64 = 1e24;

fn step(s: &str) {
    eprintln!("[e2e] {s}");
}

fn wasm(name: &str) -> Vec<u8> {
    let dir = std::env::var("WASM_DIR").unwrap_or_else(|_| "../target/near".into());
    std::fs::read(format!("{dir}/{name}/{name}.wasm")).unwrap_or_else(|e| panic!("build {name} with cargo near first: {e}"))
}

fn near(v: &Value) -> f64 {
    v.as_str().unwrap().parse::<f64>().unwrap() / YOCTO
}

async fn account(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn balance(a: &Account) -> anyhow::Result<f64> {
    Ok(a.view_account().await?.balance.as_yoctonear() as f64 / YOCTO)
}

async fn token(lp: &Contract, id: &str) -> anyhow::Result<Value> {
    Ok(lp.view("get_token").args_json(json!({ "token_id": id })).await?.json()?)
}

#[tokio::test]
async fn launch_curve_pool_and_hold_rewards() -> anyhow::Result<()> {
    step("starting the sandbox");
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    step("deploying the launchpad");
    let lp_account = account(&root, "grow", 200).await?;
    let lp = lp_account.deploy(&wasm("grow_launchpad")).await?.into_result()?;
    let owner = account(&root, "owner", 100).await?;
    lp.call("new").args_json(json!({ "owner": owner.id(), "treasury": owner.id(), "relayer": owner.id() })).transact().await?.into_result()?;
    owner.call(lp.id(), "set_token_code").args(wasm("grow_token")).max_gas().transact().await?.into_result()?;
    let mut cfg: Value = lp.view("get_config").await?.json()?;
    cfg["token_storage"] = json!("2500000000000000000000000");
    owner.call(lp.id(), "set_config").args_json(json!({ "config": cfg })).transact().await?.into_result()?;

    step("launching OAK");
    let dev = account(&root, "dev", 50).await?;
    dev.call(lp.id(), "create_token")
        .args_json(json!({ "args": { "name": "Old Oak", "ticker": "OAK" } }))
        .deposit(NearToken::from_millinear(3_600))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let list: Value = lp.view("list_tokens").args_json(json!({})).await?.json()?;
    let id = list[0]["id"].as_str().unwrap().to_string();
    let token_account: near_workspaces::AccountId = list[0]["account"].as_str().unwrap().parse()?;
    assert_eq!(list[0]["phase"], "Curve");
    // Past the launch window, so the fee is the normal 1%.
    worker.fast_forward(200).await?;

    let alice = account(&root, "alice", 100).await?;
    alice.call(lp.id(), "buy").args_json(json!({ "token_id": id, "min_out": "1" })).deposit(NearToken::from_near(10)).max_gas().transact().await?.into_result()?;
    let alice_coins: Value = alice.view(&token_account, "ft_balance_of").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    assert!(near(&alice_coins) > 0.0);

    // The whale's buy sells out the curve: it is capped, the rest comes back, and the pool opens in the same call.
    step("the whale buys out the curve");
    let whale = account(&root, "whale", 6_000).await?;
    let before = balance(&whale).await?;
    whale.call(lp.id(), "buy").args_json(json!({ "token_id": id, "min_out": "1" })).deposit(NearToken::from_near(5_000)).max_gas().transact().await?.into_result()?;
    let spent = before - balance(&whale).await?;
    let t = token(&lp, &id).await?;
    assert_eq!(t["phase"], "Pool", "the curve sold out: {t}");
    let pool_near = near(&t["near_reserve"]);
    assert!((3_300.0..3_400.0).contains(&pool_near), "about 3398.6 NEAR raised, less fees, moves into the pool: {pool_near}");
    assert!(spent > 3_300.0 && spent < 3_500.0, "the capped buy spent {spent} NEAR and the rest came back");

    step("selling in the pool");
    // Trading in the pool: the whale sells 1% of its coins at the pool fee.
    let whale_coins: Value = whale.view(&token_account, "ft_balance_of").args_json(json!({ "account_id": whale.id() })).await?.json()?;
    let sell = (whale_coins.as_str().unwrap().parse::<u128>()? / 100).to_string();
    whale
        .call(&token_account, "ft_transfer_call")
        .args_json(json!({ "receiver_id": lp.id(), "amount": sell, "msg": "{\"action\":\"sell\",\"min_out\":\"1\"}" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let t2 = token(&lp, &id).await?;
    assert!(near(&t2["near_reserve"]) < pool_near, "the sale took NEAR out of the pool");

    // Three days later alice's coins count for rewards: push the holders' share of the fees and claim it.
    step("fast-forwarding three days");
    for _ in 0..12 {
        let h: Value = alice.view(&token_account, "hold_info").args_json(json!({ "account_id": alice.id() })).await?.json()?;
        if h["held_days"].as_u64().unwrap_or(0) >= 3 {
            break;
        }
        worker.fast_forward(30_000).await?;
        step("  +30000 blocks");
    }
    let h: Value = alice.view(&token_account, "hold_info").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    assert!(h["held_days"].as_u64().unwrap() >= 3, "fast-forwarded three days: {h}");
    step("pushing and claiming rewards");
    alice.call(lp.id(), "push_rewards").args_json(json!({ "token_id": id })).max_gas().transact().await?.into_result()?;
    let h: Value = alice.view(&token_account, "hold_info").args_json(json!({ "account_id": alice.id() })).await?.json()?;
    let claimable = near(&h["claimable"]);
    assert!(claimable > 0.0, "alice earns after three days: {h}");
    let before = balance(&alice).await?;
    alice.call(&token_account, "claim_rewards").max_gas().transact().await?.into_result()?;
    let after = balance(&alice).await?;
    assert!(after > before, "the claim paid NEAR: {before} -> {after}");
    println!("pool {pool_near:.2} NEAR, alice claimed {claimable:.4} NEAR");
    Ok(())
}

/// Closing a gardener sends its coins and NEAR back (this returned a joint promise before, which NEAR rejects).
#[tokio::test]
async fn closing_a_gardener_pays_back() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let lp = account(&root, "grow", 200).await?.deploy(&wasm("grow_launchpad")).await?.into_result()?;
    let owner = account(&root, "owner", 100).await?;
    lp.call("new").args_json(json!({ "owner": owner.id(), "treasury": owner.id(), "relayer": owner.id() })).transact().await?.into_result()?;
    owner.call(lp.id(), "set_token_code").args(wasm("grow_token")).max_gas().transact().await?.into_result()?;
    let mut cfg: Value = lp.view("get_config").await?.json()?;
    cfg["token_storage"] = json!("2500000000000000000000000");
    owner.call(lp.id(), "set_config").args_json(json!({ "config": cfg })).transact().await?.into_result()?;
    let dev = account(&root, "dev", 50).await?;
    dev.call(lp.id(), "create_token").args_json(json!({ "args": { "name": "Fern Leaf", "ticker": "FERN" } })).deposit(NearToken::from_millinear(3_600)).max_gas().transact().await?.into_result()?;
    let list: Value = lp.view("list_tokens").args_json(json!({})).await?.json()?;
    let id = list[0]["id"].as_str().unwrap().to_string();
    let token_account: near_workspaces::AccountId = list[0]["account"].as_str().unwrap().parse()?;
    worker.fast_forward(200).await?;

    // A gardener of bob's, traded by bob himself, buys the token and is then closed.
    let bob = account(&root, "bob", 50).await?;
    let vid: u64 = bob
        .call(lp.id(), "create_vault")
        .args_json(json!({ "name": "Bob", "strategy": "custom", "agent": bob.id(), "daily_limit": "10000000000000000000000000", "stop_loss_bps": 5000, "allowed": "All", "days": 7 }))
        .deposit(NearToken::from_near(5))
        .max_gas()
        .transact()
        .await?
        .json()?;
    bob.call(lp.id(), "vault_trade").args_json(json!({ "vault_id": vid, "token_id": id, "buy": true, "amount": "2000000000000000000000000", "min_out": "1", "note": null })).max_gas().transact().await?.into_result()?;
    let before = balance(&bob).await?;
    bob.call(lp.id(), "close_vault").args_json(json!({ "vault_id": vid })).max_gas().transact().await?.into_result()?;
    let v: Value = lp.view("get_vault").args_json(json!({ "vault_id": vid })).await?.json()?;
    assert_eq!(v["vault"]["status"], "Closed");
    let coins: Value = bob.view(&token_account, "ft_balance_of").args_json(json!({ "account_id": bob.id() })).await?.json()?;
    assert!(coins.as_str().unwrap().parse::<u128>()? > 0, "the vault's coins came to bob");
    assert!(balance(&bob).await? > before + 2.5, "the vault's NEAR came back to bob");
    Ok(())
}
