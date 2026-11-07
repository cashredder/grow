//! Maths shared by the grow. contracts. Kept free of near-sdk so it can be tested on its own and mirrored
//! exactly by the API (`api/src/lib/curve.ts`).
#![no_std]

uint::construct_uint! {
    /// 256-bit unsigned integer for products that overflow u128 (reserve * reserve, reward * precision).
    pub struct U256(4);
}

/// Basis points: 10_000 = 100%.
pub const BPS: u128 = 10_000;

/// 1 NEAR in yoctoNEAR.
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Token decimals. 18 keeps every amount inside u128 for a 1B supply.
pub const DECIMALS: u8 = 18;
pub const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;

/// Supply and curve shape, in whole tokens / NEAR (see the spec and `grow-app/src/lib/engine.ts`).
pub const SUPPLY: u128 = 1_000_000_000 * ONE_TOKEN;
pub const VIRTUAL_TOKENS: u128 = 1_073_000_000 * ONE_TOKEN;
pub const VIRTUAL_NEAR: u128 = 1_200 * ONE_NEAR;
/// The curve ends when its token reserve falls to this: 793M tokens are sold on the curve.
pub const CURVE_END_TOKENS: u128 = 280_000_000 * ONE_TOKEN;
/// Tokens kept back for the pool that opens at graduation.
pub const POOL_TOKENS: u128 = 207_000_000 * ONE_TOKEN;

pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0, "division by zero");
    let r = U256::from(a) * U256::from(b) / U256::from(d);
    assert!(r <= U256::from(u128::MAX), "overflow");
    r.as_u128()
}

pub fn mul_div_up(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0, "division by zero");
    let p = U256::from(a) * U256::from(b);
    let d = U256::from(d);
    let r = (p + d - U256::one()) / d;
    assert!(r <= U256::from(u128::MAX), "overflow");
    r.as_u128()
}

/// x*y=k swap: how many `out` units leave a pool holding `reserve_in`/`reserve_out` when `amount_in` arrives.
/// Rounded down, so the pool never gives out more than k allows.
pub fn swap_out(reserve_in: u128, reserve_out: u128, amount_in: u128) -> u128 {
    if amount_in == 0 {
        return 0;
    }
    mul_div(reserve_out, amount_in, reserve_in + amount_in)
}

/// Input needed for exactly `amount_out`, rounded up.
pub fn swap_in(reserve_in: u128, reserve_out: u128, amount_out: u128) -> u128 {
    assert!(amount_out < reserve_out, "not enough liquidity");
    mul_div_up(reserve_in, amount_out, reserve_out - amount_out)
}

/// Trade fee right now. For the first `window_ms` the fee falls linearly from `start_bps` to `fee_bps`.
pub fn fee_bps_at(fee_bps: u16, created_ms: u64, now_ms: u64, window_ms: u64, start_bps: u16) -> u16 {
    let age = now_ms.saturating_sub(created_ms);
    if age >= window_ms || start_bps <= fee_bps {
        return fee_bps;
    }
    let extra = (start_bps - fee_bps) as u64 * (window_ms - age) / window_ms;
    fee_bps + extra as u16
}

/// Where one fee goes. Mirrors `splitFee` in the front end.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    pub dev: u128,
    pub holders: u128,
    pub buyback: u128,
    pub referrer: u128,
    pub platform: u128,
}

/// `fee` was charged at `rate_bps`; only the part at the token's normal `normal_bps` is shared. Anything above
/// it (the launch window) always goes to the platform, so a dev who snipes their own token through other
/// wallets cannot win it back. Of the shared part: dev 30% (of which `redirect_pct` can go to holders or a
/// buyback), holders 10%, and of the remaining 60% a referrer gets a tenth.
pub fn split_fee(fee: u128, normal_bps: u16, rate_bps: u16, redirect_pct: u8, redirect_to_holders: bool, referred: bool) -> Split {
    if fee == 0 {
        return Split::default();
    }
    let normal_part = if rate_bps == 0 { 0 } else if normal_bps >= rate_bps { fee } else { mul_div(fee, normal_bps as u128, rate_bps as u128) };
    let sniper_extra = fee - normal_part;
    let dev_gross = normal_part * 30 / 100;
    let moved = dev_gross * redirect_pct as u128 / 100;
    let holders_base = normal_part * 10 / 100;
    let rest = normal_part - dev_gross - holders_base;
    let referrer = if referred { rest / 10 } else { 0 };
    Split {
        dev: dev_gross - moved,
        holders: holders_base + if redirect_to_holders { moved } else { 0 },
        buyback: if redirect_to_holders { 0 } else { moved },
        referrer,
        platform: rest - referrer + sniper_extra,
    }
}

/// Hold weight in hundredths: none before 3 days, then x1, x1.5 at 5 days and x2 at 10 days.
pub fn hold_multiplier(age_days: u32) -> u128 {
    if age_days >= 10 {
        200
    } else if age_days >= 5 {
        150
    } else if age_days >= 3 {
        100
    } else {
        0
    }
}

/// The days on which a holder's weight steps up, and by how much (hundredths of the balance).
pub const TIER_STEPS: [(u32, u128); 3] = [(3, 100), (5, 50), (10, 50)];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_never_breaks_k() {
        let (x, y) = (VIRTUAL_NEAR, VIRTUAL_TOKENS);
        let out = swap_out(x, y, 10 * ONE_NEAR);
        let k0 = U256::from(x) * U256::from(y);
        let k1 = U256::from(x + 10 * ONE_NEAR) * U256::from(y - out);
        assert!(k1 >= k0);
    }

    #[test]
    fn swap_in_round_trips() {
        let (x, y) = (VIRTUAL_NEAR, VIRTUAL_TOKENS);
        let want = 5_000_000 * ONE_TOKEN;
        let need = swap_in(x, y, want);
        assert!(swap_out(x, y, need) >= want);
        assert!(swap_out(x, y, need - 1) < want);
    }

    #[test]
    fn sniper_fee_decays() {
        assert_eq!(fee_bps_at(100, 0, 0, 60_000, 5_000), 5_000);
        assert_eq!(fee_bps_at(100, 0, 30_000, 60_000, 5_000), 2_550);
        assert_eq!(fee_bps_at(100, 0, 60_000, 60_000, 5_000), 100);
        assert_eq!(fee_bps_at(0, 0, 90_000, 60_000, 5_000), 0);
    }

    #[test]
    fn split_matches_the_spec() {
        // 1 NEAR fee at the normal rate, referred: dev 0.3, holders 0.1, referrer 0.06, platform 0.54.
        let s = split_fee(ONE_NEAR, 100, 100, 0, true, true);
        assert_eq!(s.dev, ONE_NEAR * 30 / 100);
        assert_eq!(s.holders, ONE_NEAR * 10 / 100);
        assert_eq!(s.referrer, ONE_NEAR * 6 / 100);
        assert_eq!(s.platform, ONE_NEAR * 54 / 100);
        assert_eq!(s.dev + s.holders + s.referrer + s.platform + s.buyback, ONE_NEAR);
    }

    #[test]
    fn launch_window_extra_goes_to_the_platform() {
        // Charged at 50% while the normal fee is 1%: 49/50 of the fee is platform-only.
        let fee = 50 * ONE_NEAR;
        let s = split_fee(fee, 100, 5_000, 0, true, false);
        assert_eq!(s.dev, ONE_NEAR * 30 / 100);
        assert_eq!(s.platform, 49 * ONE_NEAR + ONE_NEAR * 60 / 100);
        assert_eq!(s.dev + s.holders + s.referrer + s.platform + s.buyback, fee);
    }

    #[test]
    fn redirect_moves_the_dev_share() {
        let s = split_fee(ONE_NEAR, 100, 100, 50, false, false);
        assert_eq!(s.dev, ONE_NEAR * 15 / 100);
        assert_eq!(s.buyback, ONE_NEAR * 15 / 100);
        assert_eq!(s.holders, ONE_NEAR * 10 / 100);
    }

    #[test]
    fn curve_shape_matches_the_front_end() {
        // Selling the curve down to 280M tokens raises 1200 * 1.073e9 / 280e6 - 1200 ≈ 3398.57 NEAR.
        let k = U256::from(VIRTUAL_NEAR) * U256::from(VIRTUAL_TOKENS);
        let base_end = (k / U256::from(CURVE_END_TOKENS)).as_u128();
        let raise = base_end - VIRTUAL_NEAR;
        assert!(raise > 3398 * ONE_NEAR && raise < 3399 * ONE_NEAR);
        assert_eq!(SUPPLY - (VIRTUAL_TOKENS - CURVE_END_TOKENS), POOL_TOKENS);
    }
}
