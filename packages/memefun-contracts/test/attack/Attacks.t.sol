// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {BuybackBurnVault} from "../../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

/// @notice Adversarial cases beyond the unit suites: protection at its cap, dust, direct calls to
///         callbacks and hooks, stray ETH, and fee exemptions that must not leak to outsiders.
contract AttacksTest is MemeFunFixture {
    function test_exactOutputSellAtTheNinetyNinePercentCap() public {
        vm.prank(owner);
        config.setLaunchProtection(9_900, 300);
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.firstBuyAmount = 5 ether; // the creator holds coins to sell
        address coin = _launch(p);

        // Same block: the fee is 99%. Asking for 0.001 ETH out means the pool pays 0.1 ETH.
        uint256 claimsBefore = _vaultClaims(Currency.wrap(ETH));
        (uint256 received,) = _swapAs(creator, coin, false, false, 0.001 ether);
        assertEq(received, 0.001 ether, "seller got exactly what they asked for");
        assertEq(_vaultClaims(Currency.wrap(ETH)) - claimsBefore, FeeMath.onNet(0.001 ether, 9_900), "99x fee");
        assertEq(FeeMath.onNet(0.001 ether, 9_900), 0.099 ether);
    }

    function test_dustSwapsCannotBreakAccounting() public {
        address coin = _launchSimple(ETH, Mode.BURN, 500);
        _skip(15);
        uint256 claimsBefore = _vaultClaims(Currency.wrap(ETH));
        (uint256 paid, uint256 coins) = _swapAs(alice, coin, true, true, 1); // 1 wei
        assertEq(paid, 1);
        assertEq(_vaultClaims(Currency.wrap(ETH)) - claimsBefore, 1, "a 1-wei trade pays a 1-wei fee");
        assertEq(coins, 0, "and buys nothing: the fee rounds up");
        assertEq(
            _vaultClaims(Currency.wrap(ETH)),
            vault.platformPending(Currency.wrap(ETH)) + vault.creatorPending(coin) + vault.destinationPending(coin),
            "still exactly solvent"
        );
    }

    function test_hookCallbacksOnlyFromThePoolManager() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        PoolKey memory key = hook.poolKeyOf(coin);
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: 0});
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(alice, key, params, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.afterSwap(alice, key, params, BalanceDelta.wrap(0), "");
    }

    function test_unlockCallbacksOnlyFromThePoolManager() public {
        bytes memory junk = abi.encode(uint256(1));
        vm.expectRevert(MemeFunFactory.NotPoolManager.selector);
        factory.unlockCallback(junk);
        vm.expectRevert(MemeFunRouter.NotPoolManager.selector);
        router.unlockCallback(junk);
        vm.expectRevert(FeeVault.NotPoolManager.selector);
        vault.unlockCallback(junk);
        vm.expectRevert(BuybackBurnVault.NotPoolManager.selector);
        burnVault.unlockCallback(junk);
        vm.expectRevert(FloorVault.NotPoolManager.selector);
        floorVault.unlockCallback(junk);
        vm.expectRevert(HolderRewardDistributor.NotPoolManager.selector);
        holders.unlockCallback(junk);
    }

    function test_strayEthIsRefusedEverywhere() public {
        address payable[7] memory targets = [
            payable(address(factory)),
            payable(address(router)),
            payable(address(hook)),
            payable(address(vault)),
            payable(address(burnVault)),
            payable(address(floorVault)),
            payable(address(holders))
        ];
        for (uint256 i; i < targets.length; ++i) {
            vm.prank(alice);
            (bool ok,) = targets[i].call{value: 1 ether}("");
            assertFalse(ok, "no contract accepts ETH it could strand");
        }
    }

    function test_onlyTheCoinsOwnBuybackVaultIsFeeExempt() public {
        address coin = _launchSimple(ETH, Mode.BURN, 500);
        _skip(15);
        // Anyone else, whatever they claim to be, pays the full fee.
        uint256 claimsBefore = _vaultClaims(Currency.wrap(ETH));
        _swapAs(address(burnVault), coin, true, true, 1 ether); // tx sender spoofed, PoolManager caller is the router
        assertEq(_vaultClaims(Currency.wrap(ETH)) - claimsBefore, FeeMath.onGross(1 ether, 500), "charged");
    }

    function test_routerRejectsWrongValueAndExpiredTrades() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        MemeFunRouter.TradeParams memory p = MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: 1 ether,
            minAmountOut: 0,
            recipient: address(0),
            referrer: address(0),
            deadline: _now() + 60
        });
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(MemeFunRouter.WrongValue.selector, 1 ether, 0.5 ether));
        router.buy{value: 0.5 ether}(p);
        p.deadline = _now() - 1;
        vm.expectRevert(MemeFunRouter.Expired.selector);
        router.buy{value: 1 ether}(p);
        p.deadline = _now() + 60;
        p.amountIn = 0;
        vm.expectRevert(MemeFunRouter.ZeroAmount.selector);
        router.buy(p);
        vm.stopPrank();
    }

    function _swapAs(address who, address coin, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (uint256 quoteMoved, uint256 coinMoved)
    {
        PoolKey memory key = hook.poolKeyOf(coin);
        Currency quote = hook.quoteCurrencyOf(coin);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(quote);
        bool zeroForOne = isBuy == quoteIsCurrency0;
        uint256 value = quote.isAddressZero() && isBuy ? (exactIn ? amount : 100 ether) : 0;
        deal(who, who.balance + value);
        vm.startPrank(who);
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
        int128 q = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 c = quoteIsCurrency0 ? delta.amount1() : delta.amount0();
        quoteMoved = q < 0 ? uint256(-int256(q)) : uint256(int256(q));
        coinMoved = c < 0 ? uint256(-int256(c)) : uint256(int256(c));
    }
}
