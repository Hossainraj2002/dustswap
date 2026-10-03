// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {HookDataLib} from "../../src/libraries/HookDataLib.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {TestToken} from "../utils/TestTokens.sol";

/// @notice The fee engine: every swap type, both currency orderings, launch protection,
///         referrals, exemptions and fee lowering. Each test checks what the trader actually paid
///         or received against the formula, and that the vault received exactly the fee.
contract FeesTest is MemeFunFixture {
    struct Outcome {
        uint256 quoteMoved; // paid by a buyer (gross) or received by a seller (net)
        uint256 coinMoved; // received by a buyer or paid by a seller
        uint256 fee; // claims the vault gained
    }

    // -------------------------------------------------------------------------------------------
    // The four swap types, coin as currency1 (ETH) and as currency0 (stock)
    // -------------------------------------------------------------------------------------------

    function test_buyExactIn_eth() public {
        _checkBuyExactIn(_launchAfterProtection(ETH, 300), 1 ether);
    }

    function test_buyExactIn_stockCoinIsCurrency0() public {
        _checkBuyExactIn(_launchAfterProtection(STOCK_ADDRESS, 300), 7e8);
    }

    function test_sellExactIn_eth() public {
        address coin = _launchAfterProtection(ETH, 300);
        _swap(alice, coin, true, true, 2 ether); // alice gets coins to sell
        _checkSellExactIn(coin, IB20(coin).balanceOf(alice) / 3);
    }

    function test_sellExactIn_stockCoinIsCurrency0() public {
        address coin = _launchAfterProtection(STOCK_ADDRESS, 300);
        _swap(alice, coin, true, true, 20e8);
        _checkSellExactIn(coin, IB20(coin).balanceOf(alice) / 3);
    }

    function test_buyExactOut_eth() public {
        _checkBuyExactOut(_launchAfterProtection(ETH, 500), 1_000_000e18);
    }

    function test_buyExactOut_stockCoinIsCurrency0() public {
        _checkBuyExactOut(_launchAfterProtection(STOCK_ADDRESS, 500), 1_000_000e18);
    }

    function test_sellExactOut_eth() public {
        address coin = _launchAfterProtection(ETH, 500);
        _swap(alice, coin, true, true, 3 ether);
        _checkSellExactOut(coin, 0.5 ether);
    }

    function test_sellExactOut_stockCoinIsCurrency0() public {
        address coin = _launchAfterProtection(STOCK_ADDRESS, 500);
        _swap(alice, coin, true, true, 30e8);
        _checkSellExactOut(coin, 4e8);
    }

    function _checkBuyExactIn(address coin, uint256 amountIn) internal {
        uint256 rate = hook.currentFeeBps(coin);
        Outcome memory o = _swap(alice, coin, true, true, amountIn);
        assertEq(o.quoteMoved, amountIn, "buyer paid exactly the input");
        assertEq(o.fee, FeeMath.onGross(amountIn, rate), "fee = ceil(X * r)");
        assertGt(o.coinMoved, 0);
        _assertHookClean(coin);
    }

    function _checkSellExactIn(address coin, uint256 coinsIn) internal {
        uint256 rate = hook.currentFeeBps(coin);
        Outcome memory o = _swap(alice, coin, false, true, coinsIn);
        assertEq(o.coinMoved, coinsIn, "seller paid exactly the coins");
        // The pool released quoteMoved + fee; the fee is the rate of that gross amount.
        assertEq(o.fee, FeeMath.onGross(o.quoteMoved + o.fee, rate), "fee = ceil(Y * r)");
        _assertHookClean(coin);
    }

    function _checkBuyExactOut(address coin, uint256 coinsOut) internal {
        uint256 rate = hook.currentFeeBps(coin);
        Outcome memory o = _swap(alice, coin, true, false, coinsOut);
        assertEq(o.coinMoved, coinsOut, "buyer got exactly the coins asked for");
        // The buyer paid the pool's input plus the fee; the fee is the gross-up of that input.
        assertEq(o.fee, FeeMath.onNet(o.quoteMoved - o.fee, rate), "fee = ceil(Y * r / (1 - r))");
        _assertHookClean(coin);
    }

    function _checkSellExactOut(address coin, uint256 quoteOut) internal {
        uint256 rate = hook.currentFeeBps(coin);
        Outcome memory o = _swap(alice, coin, false, false, quoteOut);
        assertEq(o.quoteMoved, quoteOut, "seller got exactly the quote asked for");
        assertEq(o.fee, FeeMath.onNet(quoteOut, rate), "fee = ceil(N * r / (1 - r))");
        _assertHookClean(coin);
    }

    // -------------------------------------------------------------------------------------------
    // Launch protection
    // -------------------------------------------------------------------------------------------

    function test_launchProtection_decaysOverFifteenSeconds() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        // vm.getBlockTimestamp, not block.timestamp: via-IR re-reads a cached timestamp after vm.warp.
        uint256 launchedAt = vm.getBlockTimestamp();
        _assertProtectionAt(coin, launchedAt, 0);
        _assertProtectionAt(coin, launchedAt, 2);
        _assertProtectionAt(coin, launchedAt, 8);
        _assertProtectionAt(coin, launchedAt, 14);
        _assertProtectionAt(coin, launchedAt, 15);
        assertEq(hook.currentFeeBps(coin), 100, "back to the coin's own fee");
    }

    function _assertProtectionAt(address coin, uint256 launchedAt, uint256 offset) internal {
        vm.warp(launchedAt + offset);
        uint256 expectedRate = FeeMath.launchFeeBps(100, 5_000, 15, offset);
        assertEq(hook.currentFeeBps(coin), expectedRate, "rate");
        Outcome memory o = _swap(alice, coin, true, true, 0.1 ether);
        assertEq(o.fee, FeeMath.onGross(0.1 ether, expectedRate), "protection fee charged");
    }

    function test_launchProtection_sameBlockSniperPaysHalf() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        Outcome memory o = _swap(alice, coin, true, true, 10 ether);
        assertEq(o.fee, 5 ether, "a same-block sniper pays 50%");
    }

    // -------------------------------------------------------------------------------------------
    // Splits, referrals and exemptions
    // -------------------------------------------------------------------------------------------

    function test_split_communityModeWithCreatorKeep() public {
        // Holder rewards, creator keeps 30% of the community share.
        address coin = _launchCommunity(ETH, Mode.HOLDERS, 400, 3_000);
        Outcome memory o = _swap(alice, coin, true, true, 1 ether);
        FeeMath.Split memory s = FeeMath.split(o.fee, false, 2_000, 2_500, 3_000, false);
        assertEq(vault.platformPending(Currency.wrap(ETH)), s.platform);
        assertEq(vault.creatorPending(coin), s.creator);
        assertEq(vault.destinationPending(coin), s.destination);
        assertEq(s.platform + s.creator + s.destination, o.fee, "conservation");
    }

    function test_router_referralPaidFromPlatformShare() public {
        address coin = _launchAfterProtection(ETH, 200);
        vm.prank(alice);
        router.buy{value: 1 ether}(_trade(coin, 1 ether, referrer));
        uint256 fee = FeeMath.onGross(1 ether, 200);
        FeeMath.Split memory s = FeeMath.split(fee, true, 2_000, 2_500, 0, true);
        assertGt(s.referral, 0);
        assertEq(vault.referralPending(referrer, Currency.wrap(ETH)), s.referral, "referrer earns 25% of platform");
        assertEq(vault.platformPending(Currency.wrap(ETH)), s.platform, "platform keeps the rest");
        assertEq(vault.creatorPending(coin), s.creator);
    }

    function test_router_selfReferralIsDropped() public {
        address coin = _launchAfterProtection(ETH, 200);
        vm.prank(alice);
        router.buy{value: 1 ether}(_trade(coin, 1 ether, alice));
        assertEq(vault.referralPending(alice, Currency.wrap(ETH)), 0, "no self-referral");
        uint256 fee = FeeMath.onGross(1 ether, 200);
        assertEq(vault.platformPending(Currency.wrap(ETH)), fee * 2_000 / 10_000, "platform keeps all of its share");
    }

    function test_hookDataFromOtherRoutersIsIgnored() public {
        address coin = _launchAfterProtection(ETH, 200);
        // A different router passes perfectly formed hookData naming a referrer: ignored.
        _swapWithHookData(alice, coin, true, true, 1 ether, HookDataLib.encode(alice, referrer));
        assertEq(vault.referralPending(referrer, Currency.wrap(ETH)), 0, "only MemeFunRouter can refer");
    }

    function test_router_sell_and_minimumOutput() public {
        address coin = _launchAfterProtection(ETH, 200);
        vm.prank(alice);
        uint256 coins = router.buy{value: 1 ether}(_trade(coin, 1 ether, address(0)));
        vm.startPrank(alice);
        IB20(coin).approve(address(router), coins);
        MemeFunRouter.TradeParams memory p = _trade(coin, coins, address(0));
        p.minAmountOut = 10 ether; // impossible
        vm.expectPartialRevert(MemeFunRouter.InsufficientOutput.selector);
        router.sell(p);
        p.minAmountOut = 0;
        uint256 before = alice.balance;
        uint256 out = router.sell(p);
        vm.stopPrank();
        assertEq(alice.balance - before, out, "seller received the output");
        assertLt(out, 1 ether, "round trip pays two fees");
    }

    function test_router_ignoresBuilderCodeSuffix() public {
        address coin = _launchAfterProtection(ETH, 200);
        bytes memory call = abi.encodeCall(MemeFunRouter.buy, (_trade(coin, 0.5 ether, referrer)));
        // The production ERC-8021 builder-code suffix the app appends to every transaction.
        bytes memory suffix = hex"62635f74706f6c666a686f0b0080218021802180218021802180218021";
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 0.5 ether}(bytes.concat(call, suffix));
        assertTrue(ok, "suffix ignored");
        assertGt(IB20(coin).balanceOf(alice), 0);
        assertGt(vault.referralPending(referrer, Currency.wrap(ETH)), 0, "arguments decoded intact");
    }

    // -------------------------------------------------------------------------------------------
    // Creator controls
    // -------------------------------------------------------------------------------------------

    function test_lowerFee_onlyDownAndOnlyByCreator() public {
        address coin = _launchAfterProtection(ETH, 500);
        vm.prank(alice);
        vm.expectRevert(MemeFunHook.NotCreator.selector);
        hook.lowerFee(coin, 100);

        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(MemeFunHook.FeeNotLower.selector, 500, 500));
        hook.lowerFee(coin, 500);
        hook.lowerFee(coin, 250);
        vm.expectRevert(abi.encodeWithSelector(MemeFunHook.FeeNotLower.selector, 250, 300));
        hook.lowerFee(coin, 300);
        vm.stopPrank();

        Outcome memory o = _swap(alice, coin, true, true, 1 ether);
        assertEq(o.fee, FeeMath.onGross(1 ether, 250), "new fee applies");
    }

    function test_lowerFee_toZero_noFeeNoClaims() public {
        address coin = _launchAfterProtection(ETH, 500);
        vm.prank(creator);
        hook.lowerFee(coin, 0);
        uint256 claimsBefore = _vaultClaims(Currency.wrap(ETH));
        Outcome memory o = _swap(alice, coin, true, true, 1 ether);
        assertEq(o.fee, 0);
        assertEq(_vaultClaims(Currency.wrap(ETH)), claimsBefore, "nothing minted");
        assertGt(o.coinMoved, 0, "trading still works");
    }

    function test_creatorRole_isTwoStep() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        vm.prank(creator);
        hook.proposeCreator(coin, bob);
        assertEq(hook.creatorOf(coin), creator, "not moved until accepted");
        vm.prank(alice);
        vm.expectRevert(MemeFunHook.NotPendingCreator.selector);
        hook.acceptCreator(coin);
        vm.prank(bob);
        hook.acceptCreator(coin);
        assertEq(hook.creatorOf(coin), bob);
        vm.prank(creator);
        vm.expectRevert(MemeFunHook.NotCreator.selector);
        hook.lowerFee(coin, 50);
    }

    // -------------------------------------------------------------------------------------------
    // Trade event
    // -------------------------------------------------------------------------------------------

    /// @dev Field order of the Trade event's data (the non-indexed fields).
    struct TradeLog {
        bool isBuy;
        uint256 quoteAmount;
        uint256 coinAmount;
        uint256 fee;
        uint256 feeBps;
        address referrer;
        uint160 sqrtPriceX96;
        int24 tick;
    }

    function test_tradeEvent_describesTheTraderSide() public {
        address coin = _launchAfterProtection(ETH, 300);
        vm.recordLogs();
        vm.prank(alice);
        uint256 coins = router.buy{value: 1 ether}(_trade(coin, 1 ether, referrer));
        TradeLog memory t = _onlyTradeLog(coin, alice);
        assertTrue(t.isBuy);
        assertEq(t.quoteAmount, 1 ether, "gross paid");
        assertEq(t.coinAmount, coins);
        assertEq(t.fee, FeeMath.onGross(1 ether, 300));
        assertEq(t.feeBps, 300);
        assertEq(t.referrer, referrer);
        _assertPostSwapPrice(coin, t);
    }

    function test_tradeEvent_carriesThePriceTheSwapLeft() public {
        // Stock pair: the coin is currency0 here, so this also covers the other ordering.
        address coin = _launchAfterProtection(address(stock), 300);
        uint160 launchPrice = _sqrtPrice(coin);

        vm.recordLogs();
        uint256 coins = _routerBuyStock(coin, 10e8);
        TradeLog memory bought = _onlyTradeLog(coin, alice);
        _assertPostSwapPrice(coin, bought);
        assertTrue(bought.sqrtPriceX96 != launchPrice, "a buy moves the price");

        vm.startPrank(alice);
        IB20(coin).approve(address(router), coins / 2);
        vm.recordLogs();
        router.sell(_trade(coin, coins / 2, address(0)));
        vm.stopPrank();
        TradeLog memory sold = _onlyTradeLog(coin, alice);
        assertFalse(sold.isBuy);
        _assertPostSwapPrice(coin, sold);
        assertTrue(sold.sqrtPriceX96 != bought.sqrtPriceX96, "a sell moves it back");
    }

    // -------------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------------

    function _launchAfterProtection(address quote, uint16 feeBps) internal returns (address coin) {
        coin = _launchSimple(quote, Mode.CREATOR, feeBps);
        _skip(15);
        vm.roll(vm.getBlockNumber() + 8);
    }

    function _launchCommunity(address quote, Mode mode, uint16 feeBps, uint16 keepBps) internal returns (address coin) {
        MemeFunFactory.LaunchParams memory p = _params(quote, mode, feeBps);
        p.creatorKeepBps = keepBps;
        coin = _launch(p);
        _skip(15);
    }

    function _trade(address coin, uint256 amountIn, address ref) internal view returns (MemeFunRouter.TradeParams memory) {
        return MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: amountIn,
            minAmountOut: 0,
            recipient: address(0),
            referrer: ref,
            deadline: _now() + 60
        });
    }

    function _routerBuyStock(address coin, uint256 amountIn) internal returns (uint256 coins) {
        vm.startPrank(alice);
        stock.approve(address(router), amountIn);
        coins = router.buy(_trade(coin, amountIn, address(0)));
        vm.stopPrank();
    }

    /// @dev The one Trade event among the recorded logs, with its coin and trader topics checked.
    function _onlyTradeLog(address coin, address trader) internal returns (TradeLog memory t) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != MemeFunHook.Trade.selector) continue;
            ++found;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), coin, "coin topic");
            assertEq(address(uint160(uint256(logs[i].topics[3]))), trader, "trader is the router user");
            t = abi.decode(logs[i].data, (TradeLog));
        }
        assertEq(found, 1, "exactly one Trade");
    }

    function _assertPostSwapPrice(address coin, TradeLog memory t) internal view {
        (uint160 sqrtPriceX96, int24 tick) = _slot0(coin);
        assertEq(t.sqrtPriceX96, sqrtPriceX96, "event price is the pool price after the swap");
        assertEq(t.tick, tick, "event tick is the pool tick after the swap");
    }

    function _swap(address who, address coin, bool isBuy, bool exactIn, uint256 amount) internal returns (Outcome memory) {
        return _swapWithHookData(who, coin, isBuy, exactIn, amount, "");
    }

    /// @dev Swaps through v4-core's test router: a non-MemeFunRouter caller, both exact-in and
    ///      exact-out, so the hook's handling of every swap type is exercised directly.
    function _swapWithHookData(address who, address coin, bool isBuy, bool exactIn, uint256 amount, bytes memory hookData)
        internal
        returns (Outcome memory o)
    {
        PoolKey memory key = hook.poolKeyOf(coin);
        Currency quote = hook.quoteCurrencyOf(coin);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(quote);
        bool zeroForOne = isBuy == quoteIsCurrency0;

        uint256 claimsBefore = _vaultClaims(quote);
        uint256 value;
        if (quote.isAddressZero() && isBuy) value = exactIn ? amount : 100 ether;

        vm.startPrank(who);
        if (!quote.isAddressZero()) TestToken(Currency.unwrap(quote)).approve(address(swapRouter), type(uint256).max);
        IB20(coin).approve(address(swapRouter), type(uint256).max);
        BalanceDelta delta = swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: exactIn ? -int256(amount) : int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
        vm.stopPrank();

        int128 quoteDelta = quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 coinDelta = quoteIsCurrency0 ? delta.amount1() : delta.amount0();
        o.quoteMoved = _abs(quoteDelta);
        o.coinMoved = _abs(coinDelta);
        o.fee = _vaultClaims(quote) - claimsBefore;
    }

    function _assertHookClean(address coin) internal view {
        Currency quote = hook.quoteCurrencyOf(coin);
        assertEq(manager.balanceOf(address(hook), quote.toId()), 0, "hook holds no claims");
        assertEq(manager.balanceOf(address(hook), uint256(uint160(coin))), 0, "hook holds no coin claims");
    }

    function _abs(int128 v) internal pure returns (uint256) {
        return v < 0 ? uint256(-int256(v)) : uint256(int256(v));
    }
}

