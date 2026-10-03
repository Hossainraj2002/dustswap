// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {TestToken} from "../utils/TestTokens.sol";

/// @notice Randomized end-to-end check of the fee engine on real pools: any swap type, either
///         currency ordering, any coin fee, any moment inside or after launch protection, any
///         amount. Every run must charge exactly the formula, keep the vault's claims equal to
///         what it owes, and leave the hook holding nothing.
contract FeeEngineFuzzTest is MemeFunFixture {
    address internal coin;
    address internal quote;

    function _setUpPool(bool stockPair, uint16 rawFee, uint8 rawMode) internal {
        quote = stockPair ? STOCK_ADDRESS : ETH;
        Mode mode = Mode(rawMode % 4);
        uint16 feeBps = uint16(bound(rawFee, 100, 500));
        coin = _launch(_params(quote, mode, feeBps));
        // Seed alice with coins so sells of any size are possible later in the run.
        _skip(15);
        _swap(true, true, stockPair ? 100e8 : 30 ether);
    }

    function testFuzz_everySwapChargesExactlyTheFormula(
        bool stockPair,
        uint16 rawFee,
        uint8 rawMode,
        uint8 rawKind,
        uint256 rawAmount,
        uint8 rawElapsed
    ) public {
        _setUpPool(stockPair, rawFee, rawMode);
        // Re-enter launch protection territory for some runs by launching a fresh coin.
        if (rawElapsed % 3 == 0) {
            coin = _launch(_params(quote, Mode.CREATOR, uint16(bound(rawFee, 100, 500))));
            _skip(bound(rawElapsed, 0, 20));
            _swap(true, true, stockPair ? 100e8 : 30 ether);
        }

        uint256 rate = hook.currentFeeBps(coin);
        uint256 kind = rawKind % 4; // 0 buy-in, 1 sell-in, 2 buy-out, 3 sell-out
        bool isBuy = kind == 0 || kind == 2;
        bool exactIn = kind < 2;
        uint256 amount = _boundAmount(kind, rawAmount, stockPair);
        if (amount == 0) return;

        Currency q = Currency.wrap(quote);
        uint256 claimsBefore = _vaultClaims(q);
        (uint256 quoteMoved, uint256 coinMoved) = _swap(isBuy, exactIn, amount);
        uint256 fee = _vaultClaims(q) - claimsBefore;

        if (kind == 0) {
            assertEq(quoteMoved, amount, "buy in: paid the input");
            assertEq(fee, FeeMath.onGross(amount, rate), "buy in: ceil(X r)");
        } else if (kind == 1) {
            assertEq(coinMoved, amount, "sell in: paid the coins");
            assertEq(fee, FeeMath.onGross(quoteMoved + fee, rate), "sell in: ceil(Y r)");
        } else if (kind == 2) {
            assertEq(coinMoved, amount, "buy out: got the coins");
            assertEq(fee, FeeMath.onNet(quoteMoved - fee, rate), "buy out: ceil(Y r/(1-r))");
        } else {
            assertEq(quoteMoved, amount, "sell out: got the quote");
            assertEq(fee, FeeMath.onNet(amount, rate), "sell out: ceil(N r/(1-r))");
        }

        // The vault owns exactly what its ledgers say, and the hook ends with nothing.
        assertEq(_vaultClaims(q), _owed(q), "claims == ledgers");
        assertEq(manager.balanceOf(address(hook), q.toId()), 0, "hook holds no claims");
        assertEq(IB20(coin).totalSupply(), 1_000_000_000e18, "supply fixed");
    }

    function _boundAmount(uint256 kind, uint256 raw, bool stockPair) internal view returns (uint256) {
        uint256 coins = IB20(coin).balanceOf(alice);
        if (kind == 0) return bound(raw, 1, stockPair ? 200e8 : 50 ether);
        if (kind == 1) return coins == 0 ? 0 : bound(raw, 1, coins);
        if (kind == 2) return bound(raw, 1, 50_000_000e18); // up to 5% of supply
        // Exact-out sell: ask for at most a fraction of what alice's coins are worth.
        return bound(raw, 1, stockPair ? 5e8 : 1 ether);
    }

    function _owed(Currency q) internal view returns (uint256 total) {
        total = vault.platformPending(q) + vault.referralPending(referrer, q);
        // Every coin launched in this run used `quote`.
        for (uint256 i = 1; i <= _launched.length; ++i) {
            address c = _launched[i - 1];
            total += vault.creatorPending(c) + vault.destinationPending(c);
        }
    }

    address[] internal _launched;

    function _launch(MemeFunFactory.LaunchParams memory p) internal override returns (address c) {
        c = super._launch(p);
        _launched.push(c);
    }

    function _swap(bool isBuy, bool exactIn, uint256 amount) internal returns (uint256 quoteMoved, uint256 coinMoved) {
        PoolKey memory key = hook.poolKeyOf(coin);
        Currency q = Currency.wrap(quote);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == quote;
        bool zeroForOne = isBuy == quoteIsCurrency0;
        uint256 value = q.isAddressZero() && isBuy ? (exactIn ? amount : 500 ether) : 0;
        if (value != 0) deal(alice, alice.balance + value);

        vm.startPrank(alice);
        if (!q.isAddressZero()) TestToken(quote).approve(address(swapRouter), type(uint256).max);
        IB20(coin).approve(address(swapRouter), type(uint256).max);
        BalanceDelta delta = swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: exactIn ? -int256(amount) : int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        int128 qd = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 cd = quoteIsCurrency0 ? delta.amount1() : delta.amount0();
        quoteMoved = qd < 0 ? uint256(-int256(qd)) : uint256(int256(qd));
        coinMoved = cd < 0 ? uint256(-int256(cd)) : uint256(int256(cd));
    }
}

