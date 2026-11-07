//! Launching a token: one call creates `<id>.grow.near`, deploys the token contract, mints the supply here and,
//! if asked, makes the dev's first buy in the same flow. If anything fails, everything attached is refunded.
use crate::events::{emit, s};
use crate::market::fill_buy;
use crate::*;
use grow_common::{mul_div, mul_div_up, swap_in, BPS};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{Gas, PromiseOrValue};

const GAS_TOKEN_INIT: Gas = Gas::from_tgas(30);
const GAS_ON_CREATED: Gas = Gas::from_tgas(60);

#[near(serializers = [json])]
pub struct CreateArgs {
    pub name: String,
    pub ticker: String,
    /// Link to the off-chain metadata (picture, description, socials), content-addressed by the API.
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
    /// Small data-URI icon (NEP-148). Optional; the picture normally lives behind `reference`.
    pub icon: Option<String>,
    pub fee_bps: Option<u16>,
    /// Share of the dev's fee given away: 0, 25, 50 or 100.
    pub redirect_pct: Option<u8>,
    /// "holders" or "buyback".
    pub redirect_to: Option<String>,
    /// Connect a gardener to manage dev rewards. Only possible at launch.
    pub gardener: Option<bool>,
    pub gardener_strategy: Option<String>,
    /// NEAR to spend on the dev's first buy (at the normal fee, at most `max_dev_buy_bps` of the supply).
    pub dev_buy: Option<U128>,
}

pub(crate) fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

pub(crate) fn valid_ticker(t: &str) -> bool {
    (2..=8).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub(crate) fn valid_reference(r: &Option<String>) -> bool {
    r.as_ref().map(|r| r.len() <= 256 && (r.starts_with("https://") || r.starts_with("ipfs://"))).unwrap_or(true)
}

pub(crate) fn blank_token(id: &str, account: AccountId, name: &str, ticker: &str, creator: AccountId, now: u64) -> TokenState {
    TokenState {
        id: id.to_string(),
        account,
        name: name.to_string(),
        ticker: ticker.to_string(),
        reference: None,
        creator,
        co_dev: None,
        split_bps: 10_000,
        fee_bps: 100,
        created_ms: U64(now),
        phase: Phase::Deploying,
        near_reserve: U128(VIRTUAL_NEAR),
        tok_reserve: U128(VIRTUAL_TOKENS),
        burned: U128(0),
        vault_held: U128(0),
        redirect_pct: 0,
        redirect_to_holders: true,
        dev_vault: None,
        dev_earned: U128(0),
        dev_claimed: U128(0),
        vest_until_ms: U64(0),
        pending_holders: U128(0),
        buyback_pool: U128(0),
        pool_open_near: U128(0),
        last_buyback_block: U64(0),
        price_cum: U128(0),
        price_ts: U64(now),
        crossing: None,
        merged_into: None,
        merge_rate: U128(0),
        parents: None,
        volume: U128(0),
        trades: U64(0),
    }
}

#[near]
impl Launchpad {
    /// Launches a token. Attach `create_fee + token_storage + dev_buy` (+0.00125 NEAR registration with a dev buy).
    #[payable]
    pub fn create_token(&mut self, args: CreateArgs) -> Promise {
        require!(!self.config.launches_paused, "launches are paused");
        let creator = env::predecessor_account_id();
        let name = args.name.trim().to_string();
        require!((2..=32).contains(&name.chars().count()), "name must be 2-32 characters");
        require!(!name.chars().any(|c| c.is_control()), "name has control characters");
        let ticker = args.ticker.trim().to_string();
        require!(valid_ticker(&ticker), "ticker must be 2-8 letters or digits, in capitals");
        require!(valid_reference(&args.reference), "reference must be an https or ipfs link");
        require!(args.icon.as_ref().map(|i| i.len() <= 8_192 && i.starts_with("data:image/")).unwrap_or(true), "icon must be a small data:image URI");
        let fee_bps = args.fee_bps.unwrap_or(self.config.default_fee_bps);
        require!(fee_bps <= self.config.max_fee_bps, "trade fee above the maximum");
        let redirect_pct = args.redirect_pct.unwrap_or(0);
        require!(matches!(redirect_pct, 0 | 25 | 50 | 100), "redirect must be 0, 25, 50 or 100%");
        let redirect_to_holders = match args.redirect_to.as_deref() {
            None | Some("holders") => true,
            Some("buyback") => false,
            _ => env::panic_str("redirect_to must be holders or buyback"),
        };
        let dev_buy = args.dev_buy.map(|v| v.0).unwrap_or(0);
        let reg = if dev_buy > 0 { STORAGE_DEPOSIT } else { 0 };
        let attached = env::attached_deposit().as_yoctonear();
        let need = self.config.create_fee.0 + self.config.token_storage.0 + dev_buy + reg;
        require!(attached >= need, format!("attach {} yoctoNEAR", need));

        let id = format!("{}-{}", ticker.to_lowercase(), base36(self.next_token));
        self.next_token += 1;
        let account: AccountId = format!("{id}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("bad token account"));
        let now = now_ms();
        let mut t = blank_token(&id, account.clone(), &name, &ticker, creator.clone(), now);
        t.reference = args.reference.clone();
        t.fee_bps = fee_bps;
        t.redirect_pct = redirect_pct;
        t.redirect_to_holders = redirect_to_holders;
        if args.gardener.unwrap_or(false) {
            let strategy = args.gardener_strategy.clone().unwrap_or_else(|| "steady".into());
            let vid = self.new_vault(VaultKind::Dev, creator.clone(), self.relayer.clone(), format!("{ticker} gardener"), strategy, 0, 5_000, self.config.dev_vault_daily_limit.0, Allowed::Only(id.clone()), 0, None, 0);
            t.dev_vault = Some(vid);
        }
        self.put_token(t);
        self.platform_earned = U128(self.platform_earned.0 + self.config.create_fee.0);

        let metadata = json!({
            "spec": "ft-1.0.0", "name": name, "symbol": ticker, "icon": args.icon, "reference": args.reference,
            "reference_hash": args.reference_hash, "decimals": grow_common::DECIMALS,
        });
        let init = json!({ "launchpad": env::current_account_id(), "total_supply": U128(SUPPLY), "metadata": metadata });
        let p = self.deploy_token_code(Promise::new(account).create_account().transfer(NearToken::from_yoctonear(self.config.token_storage.0)));
        p.function_call("new", init.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_TOKEN_INIT).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_CREATED)
                .on_token_created(id, creator, U128(dev_buy), U128(attached - self.config.create_fee.0 - self.config.token_storage.0 - dev_buy - reg), U128(attached)),
        )
    }

    #[private]
    pub fn on_token_created(&mut self, token_id: String, creator: AccountId, dev_buy: U128, extra: U128, attached: U128) -> PromiseOrValue<()> {
        let mut t = self.token(&token_id);
        if !crate::promise_ok() {
            // Nothing was created: undo and give everything back.
            if let Some(v) = t.dev_vault {
                self.vaults.remove(&v);
            }
            self.tokens.remove(&token_id);
            self.platform_earned = U128(self.platform_earned.0 - self.config.create_fee.0);
            emit("token_failed", json!({ "token_id": token_id, "creator": creator }));
            Promise::new(creator).transfer(NearToken::from_yoctonear(attached.0)).detach();
            return PromiseOrValue::Value(());
        }
        let now = now_ms();
        // The launch window starts when trading can start.
        t.phase = Phase::Curve;
        t.created_ms = U64(now);
        t.price_ts = U64(now);
        emit(
            "token_created",
            json!({
                "token_id": t.id, "account": t.account, "name": t.name, "ticker": t.ticker, "creator": t.creator,
                "reference": t.reference, "fee_bps": t.fee_bps, "redirect_pct": t.redirect_pct,
                "redirect_to": if t.redirect_to_holders { "holders" } else { "buyback" }, "dev_vault": t.dev_vault,
                "near_reserve": s(t.near_reserve.0), "tok_reserve": s(t.tok_reserve.0),
            }),
        );
        if extra.0 > 0 {
            Promise::new(creator.clone()).transfer(NearToken::from_yoctonear(extra.0)).detach();
        }
        if dev_buy.0 == 0 {
            self.put_token(t);
            return PromiseOrValue::Value(());
        }
        // The dev's buy pays the normal fee (no launch-window fee) and is capped at max_dev_buy_bps of the supply.
        let cap = mul_div(SUPPLY, self.config.max_dev_buy_bps as u128, BPS);
        let mut f = fill_buy(&t, dev_buy.0, t.fee_bps, t.fee_bps);
        if f.out > cap {
            let net = swap_in(t.near_reserve.0, t.tok_reserve.0, cap);
            let used = mul_div_up(net, BPS, BPS - t.fee_bps as u128);
            f = fill_buy(&t, used, t.fee_bps, t.fee_bps);
        }
        self.apply_buy(&mut t, &f, now);
        let referred = self.distribute(&mut t, f.fee, f.rate_bps, f.normal_bps, &creator);
        self.trade_event(&t, &creator, "buy", f.used, f.out, &f, referred.as_ref(), None);
        emit("dev_buy", json!({ "token_id": t.id, "creator": creator, "near": s(f.used), "tokens": s(f.out) }));
        self.put_token(t.clone());
        if f.used < dev_buy.0 {
            Promise::new(creator.clone()).transfer(NearToken::from_yoctonear(dev_buy.0 - f.used)).detach();
        }
        PromiseOrValue::Promise(self.send_tokens(&t, &creator, f.out, true))
    }

    pub(crate) fn deploy_token_code(&self, p: Promise) -> Promise {
        match self.token_code_hash {
            Some(hash) => p.use_global_contract(hash),
            None => {
                let code = self.token_code.get(&0).cloned().unwrap_or_else(|| env::panic_str("token code is not set"));
                p.deploy_contract(code)
            }
        }
    }
}
