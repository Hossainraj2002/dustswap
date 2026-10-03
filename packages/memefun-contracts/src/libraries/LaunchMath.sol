// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title LaunchMath
/// @notice The shape of every memefun launch: the whole fixed supply in ONE single-sided position
///         that starts at the opening price and runs to the far end of the tick range, so the coin
///         trades along a constant-product curve from the first block.
///
/// @dev Integer-exact mirror of apps/memefun/src/core/pool.ts (`openingSqrtPriceX96`,
///      `startTickExact`, `createLaunchPool`); test/vectors replays the TS results against it.
library LaunchMath {
    /// @notice 1,000,000,000 coins with 18 decimals. Minted once, never again.
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    int24 internal constant TICK_SPACING = 200;
    /// @dev TickMath.minUsableTick(200) / maxUsableTick(200).
    int24 internal constant MIN_USABLE_TICK = -887_200;
    int24 internal constant MAX_USABLE_TICK = 887_200;

    /// @dev Pool.tickSpacingToMaxLiquidityPerTick(200): uint128.max over the 8,874 ticks from
    ///      -4437 to 4436 spacings (v4 rounds the minimum down). Pinned by a unit test.
    uint256 internal constant MAX_LIQUIDITY_PER_TICK = type(uint128).max / 8_874;

    uint256 private constant Q96 = 1 << 96;
    uint256 private constant Q128 = 1 << 128;
    uint256 private constant Q192 = 1 << 192;
    /// @dev Below this raw price, price * 2^192 fits in 256 bits and full precision is used.
    uint256 private constant FULL_PRECISION_PRICE_LIMIT = 1 << 64;

    error InvalidPriceInput();
    error OpeningPriceOutOfRange();

    /// @notice Opening sqrt price for an opening fully diluted value.
    /// @param quoteUsdE8 USD price of one whole quote unit, 8 decimals.
    /// @param quoteDecimals Quote token decimals (6-18).
    /// @param coinIsCurrency0 True when the coin's address sorts below the quote's.
    /// @param fdvUsdE8 Target opening FDV in USD, 8 decimals.
    /// @dev The raw Uniswap price (currency1 raw units per currency0 raw unit) is num / den.
    ///      Full precision computes sqrt(price * 2^192). For a raw price of 2^64 or more (an
    ///      expensive 8-decimal stock at a low FDV) that product would overflow, so the price is
    ///      taken as sqrt(price * 2^128) * 2^32 instead. The TS mirror takes the same branch.
    function openingSqrtPriceX96(uint256 quoteUsdE8, uint8 quoteDecimals, bool coinIsCurrency0, uint256 fdvUsdE8)
        internal
        pure
        returns (uint160)
    {
        if (quoteUsdE8 == 0 || fdvUsdE8 == 0 || quoteDecimals > 18) revert InvalidPriceInput();
        uint256 coinSide = quoteUsdE8 * SUPPLY;
        uint256 quoteSide = fdvUsdE8 * 10 ** quoteDecimals;
        (uint256 num, uint256 den) = coinIsCurrency0 ? (quoteSide, coinSide) : (coinSide, quoteSide);

        uint256 sqrtPrice = num / den < FULL_PRECISION_PRICE_LIMIT
            ? Math.sqrt(FullMath.mulDiv(num, Q192, den))
            : Math.sqrt(FullMath.mulDiv(num, Q128, den)) << 32;
        if (sqrtPrice < TickMath.MIN_SQRT_PRICE || sqrtPrice >= TickMath.MAX_SQRT_PRICE) {
            revert OpeningPriceOutOfRange();
        }
        return uint160(sqrtPrice);
    }

    /// @notice Opening tick, snapped to the spacing in the direction that makes the coin slightly
    ///         MORE expensive: the real opening FDV is never below target, at most one spacing
    ///         (about 2%) above it.
    function startTick(uint256 quoteUsdE8, uint8 quoteDecimals, bool coinIsCurrency0, uint256 fdvUsdE8)
        internal
        pure
        returns (int24 snapped)
    {
        uint160 sqrtPrice = openingSqrtPriceX96(quoteUsdE8, quoteDecimals, coinIsCurrency0, fdvUsdE8);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPrice);
        if (coinIsCurrency0) {
            // A higher tick is a pricier coin: round the true (fractional) tick up. getTickAtSqrtPrice
            // floors, so step up first unless the price sits exactly on a tick.
            snapped = _ceilToSpacing(TickMath.getSqrtPriceAtTick(tick) == sqrtPrice ? tick : tick + 1);
        } else {
            // A higher tick is a cheaper coin: round down.
            snapped = _floorToSpacing(tick);
        }
        if (snapped < MIN_USABLE_TICK + TICK_SPACING || snapped > MAX_USABLE_TICK - TICK_SPACING) {
            revert OpeningPriceOutOfRange();
        }
    }

    /// @notice Tick range of the launch position. Coin-only liquidity sits above the price when
    ///         the coin is currency0 and below it when the coin is currency1.
    function launchRange(int24 start, bool coinIsCurrency0) internal pure returns (int24 tickLower, int24 tickUpper) {
        return coinIsCurrency0 ? (start, MAX_USABLE_TICK) : (MIN_USABLE_TICK, start);
    }

    /// @notice Liquidity of the launch position holding the whole supply. Rounds down, so the
    ///         position never needs more than SUPPLY; the factory sends the dust to 0x...dEaD.
    /// @dev Same formulas as LiquidityAmounts.getLiquidityForAmount0/1, kept in 256 bits so an
    ///      opening price too close to the end of the tick range fails with a clear error. The
    ///      binding limit is v4's per-tick cap for spacing 200, not uint128: past roughly tick
    ///      350,000 on the coin's cheap side, the whole supply cannot be one position.
    function liquidityForSupply(int24 start, bool coinIsCurrency0) internal pure returns (uint128) {
        (int24 tickLower, int24 tickUpper) = launchRange(start, coinIsCurrency0);
        uint256 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint256 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint256 liquidity = coinIsCurrency0
            ? FullMath.mulDiv(SUPPLY, FullMath.mulDiv(sqrtLower, sqrtUpper, Q96), sqrtUpper - sqrtLower)
            : FullMath.mulDiv(SUPPLY, Q96, sqrtUpper - sqrtLower);
        if (liquidity > MAX_LIQUIDITY_PER_TICK) revert OpeningPriceOutOfRange();
        return uint128(liquidity);
    }

    function _floorToSpacing(int24 tick) private pure returns (int24) {
        int24 compressed = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) compressed--;
        return compressed * TICK_SPACING;
    }

    function _ceilToSpacing(int24 tick) private pure returns (int24) {
        int24 compressed = tick / TICK_SPACING;
        if (tick > 0 && tick % TICK_SPACING != 0) compressed++;
        return compressed * TICK_SPACING;
    }
}
