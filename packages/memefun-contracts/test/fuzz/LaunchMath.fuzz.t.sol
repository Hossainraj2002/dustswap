// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";

import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {HookDataLib} from "../../src/libraries/HookDataLib.sol";

/// @dev External wrappers so library reverts surface as call reverts.
contract LaunchMathHarness {
    function startTick(uint256 quoteUsdE8, uint8 decimals, bool coinIsCurrency0, uint256 fdvUsdE8)
        external
        pure
        returns (int24)
    {
        return LaunchMath.startTick(quoteUsdE8, decimals, coinIsCurrency0, fdvUsdE8);
    }

    function liquidityForSupply(int24 start, bool coinIsCurrency0) external pure returns (uint128) {
        return LaunchMath.liquidityForSupply(start, coinIsCurrency0);
    }

    function decode(bytes calldata data) external pure returns (bool, address, address) {
        return HookDataLib.decode(data);
    }
}

/// @notice Properties of the launch position for every allowed input: any quote with 6-18
///         decimals priced $0.01-$1M, opening FDV $1k-$1M, either currency ordering.
contract LaunchMathFuzzTest is Test {
    LaunchMathHarness internal harness = new LaunchMathHarness();

    function _inputs(uint64 rawQuoteUsdE8, uint8 rawDecimals, uint64 rawFdvUsdE8)
        internal
        pure
        returns (uint256 quoteUsdE8, uint8 decimals, uint256 fdvUsdE8)
    {
        quoteUsdE8 = bound(rawQuoteUsdE8, 1e6, 1e14); // $0.01 to $1,000,000
        decimals = uint8(bound(rawDecimals, 6, 18));
        fdvUsdE8 = bound(rawFdvUsdE8, 1_000e8, 1_000_000e8);
    }

    /// The coin never opens below the target FDV and at most one tick spacing above it.
    function testFuzz_startTick_opensAtOrJustAboveTarget(
        uint64 rawQuoteUsdE8,
        uint8 rawDecimals,
        uint64 rawFdvUsdE8,
        bool coinIsCurrency0
    ) public view {
        (uint256 quoteUsdE8, uint8 decimals, uint256 fdvUsdE8) = _inputs(rawQuoteUsdE8, rawDecimals, rawFdvUsdE8);
        try harness.startTick(quoteUsdE8, decimals, coinIsCurrency0, fdvUsdE8) returns (int24 tick) {
            uint160 target = LaunchMath.openingSqrtPriceX96(quoteUsdE8, decimals, coinIsCurrency0, fdvUsdE8);
            assertEq(tick % LaunchMath.TICK_SPACING, 0, "on spacing");
            assertGe(tick, LaunchMath.MIN_USABLE_TICK + LaunchMath.TICK_SPACING, "inside the usable range");
            assertLe(tick, LaunchMath.MAX_USABLE_TICK - LaunchMath.TICK_SPACING, "inside the usable range");
            if (coinIsCurrency0) {
                // Pricier coin = higher sqrt price.
                assertGe(TickMath.getSqrtPriceAtTick(tick), target, "not cheaper than target");
                assertLt(TickMath.getSqrtPriceAtTick(tick - LaunchMath.TICK_SPACING), target, "within one spacing");
            } else {
                // Pricier coin = lower sqrt price.
                assertLe(TickMath.getSqrtPriceAtTick(tick), target, "not cheaper than target");
                assertGt(TickMath.getSqrtPriceAtTick(tick + LaunchMath.TICK_SPACING), target, "within one spacing");
            }
        } catch {
            // Only an out-of-range opening price may revert, and then the sqrt price is either
            // unrepresentable or snaps outside the usable ticks: nothing launchable is rejected.
            try this.openingSqrtPrice(quoteUsdE8, decimals, coinIsCurrency0, fdvUsdE8) returns (uint160 sqrtPrice) {
                int24 raw = TickMath.getTickAtSqrtPrice(sqrtPrice);
                assertTrue(
                    raw <= LaunchMath.MIN_USABLE_TICK + 2 * LaunchMath.TICK_SPACING
                        || raw >= LaunchMath.MAX_USABLE_TICK - 2 * LaunchMath.TICK_SPACING,
                    "rejected a launchable price"
                );
            } catch {}
        }
    }

    function openingSqrtPrice(uint256 quoteUsdE8, uint8 decimals, bool coinIsCurrency0, uint256 fdvUsdE8)
        external
        pure
        returns (uint160)
    {
        return LaunchMath.openingSqrtPriceX96(quoteUsdE8, decimals, coinIsCurrency0, fdvUsdE8);
    }

    /// Either the whole supply fits in one position the PoolManager will accept, with negligible
    /// dust left for 0x...dEaD, or the opening price is rejected cleanly, and only at the coin's
    /// cheap end of the tick range where no real quote/FDV combination lands.
    function testFuzz_liquidityForSupply_fitsOrRejectsCleanly(int24 rawTick, bool coinIsCurrency0) public view {
        int24 start = int24(bound(rawTick, -887_000 / 200, 887_000 / 200)) * LaunchMath.TICK_SPACING;
        try harness.liquidityForSupply(start, coinIsCurrency0) returns (uint128 liquidity) {
            assertLe(liquidity, Pool.tickSpacingToMaxLiquidityPerTick(200), "accepted by the PoolManager");
            (int24 lower, int24 upper) = LaunchMath.launchRange(start, coinIsCurrency0);
            uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lower);
            uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
            // What the PoolManager pulls when the position is added (rounded up in its favour).
            uint256 needed = coinIsCurrency0
                ? SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true)
                : SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true);
            assertLe(needed, LaunchMath.SUPPLY, "position fits in the supply");
            assertLe(LaunchMath.SUPPLY - needed, LaunchMath.SUPPLY / 1e6, "dust below 0.0001% of supply");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), LaunchMath.OpeningPriceOutOfRange.selector, "clean revert");
            if (coinIsCurrency0) assertGt(start, 300_000, "only when the coin is extremely cheap");
            else assertLt(start, -300_000, "only when the coin is extremely cheap");
        }
    }

    function test_maxLiquidityPerTickMatchesV4() public pure {
        assertEq(LaunchMath.MAX_LIQUIDITY_PER_TICK, Pool.tickSpacingToMaxLiquidityPerTick(200));
    }

    function testFuzz_hookData_roundTripsAndRejectsJunk(address trader, address referrer, bytes calldata junk)
        public
        view
    {
        (bool ok, address t, address r) = harness.decode(HookDataLib.encode(trader, referrer));
        assertTrue(ok);
        assertEq(t, trader);
        assertEq(r, referrer);

        if (junk.length != 96) {
            (ok,,) = harness.decode(junk);
            assertFalse(ok, "wrong length is ignored");
        }
        // Dirty upper bits in an address word are rejected rather than truncated.
        bytes memory dirty = abi.encode(uint256(1), uint256(uint160(trader)) | (1 << 200), uint256(uint160(referrer)));
        (ok,,) = harness.decode(dirty);
        assertFalse(ok, "dirty address word is ignored");
        bytes memory wrongVersion = abi.encode(uint256(2), trader, referrer);
        (ok,,) = harness.decode(wrongVersion);
        assertFalse(ok, "unknown version is ignored");
    }
}
