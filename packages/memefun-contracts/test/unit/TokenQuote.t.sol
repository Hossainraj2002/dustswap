// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {Mode, PriceSource, QuoteKind} from "../../src/types/MemeFunTypes.sol";
import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {TestToken} from "../utils/TestTokens.sol";

/// @notice Other crypto assets have their own kind and real opening valuation, not a $1 peg.
contract TokenQuoteTest is MemeFunFixture {
    uint64 private constant TOKEN_USD_E8 = 12_500; // $0.000125 per whole token.
    uint32 private constant MAX_AGE = 15 minutes;

    function test_tokenKind_preservesExistingIndicesAndRequiresOwnerEnablement() public {
        assertEq(uint256(QuoteKind.NATIVE), 0);
        assertEq(uint256(QuoteKind.STABLE), 1);
        assertEq(uint256(QuoteKind.STOCK), 2);
        assertEq(uint256(QuoteKind.TOKEN), 3);
        assertEq(uint256(PriceSource.FIXED), 0);
        assertEq(uint256(PriceSource.CHAINLINK), 1);
        assertEq(uint256(PriceSource.MANUAL), 2);

        MemeFunConfig fresh = new MemeFunConfig(owner, treasury);
        assertTrue(fresh.kindEnabled(QuoteKind.NATIVE));
        assertTrue(fresh.kindEnabled(QuoteKind.STABLE));
        assertFalse(fresh.kindEnabled(QuoteKind.STOCK));
        assertFalse(fresh.kindEnabled(QuoteKind.TOKEN));

        TestToken token = _listedToken(18);
        assertFalse(config.isLaunchableQuote(address(token)), "kind is not implicitly enabled");
        MemeFunFactory.LaunchParams memory p = _params(address(token), Mode.CREATOR, 100);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(MemeFunFactory.QuoteNotLaunchable.selector, address(token))
        );
        factory.launch(p);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        config.setQuoteKindEnabled(3, true);

        vm.prank(owner);
        config.setQuoteKindEnabled(3, true);
        assertTrue(config.isLaunchableQuote(address(token)));
        assertTrue(config.isLaunchableQuote(ETH), "native kind is unchanged");
        assertTrue(config.isLaunchableQuote(USDC_ADDRESS), "stable kind is unchanged");
        assertTrue(config.isLaunchableQuote(STOCK_ADDRESS), "stock kind is unchanged");
    }

    function test_tokenKind_manualPriceSetsActualOpeningTickAndPaysFeesInToken() public {
        TestToken token = _enabledToken(18);
        token.mint(creator, 100_000e18);
        MemeFunFactory.LaunchParams memory p = _params(address(token), Mode.CREATOR, 100);
        p.firstBuyAmount = 10_000e18;
        address predicted = factory.predictCoin(creator, p.salt);
        bool coinIsCurrency0 = uint160(predicted) < uint160(address(token));
        int24 expectedTick = LaunchMath.startTick(TOKEN_USD_E8, 18, coinIsCurrency0, 5000e8);
        int24 falsePegTick = LaunchMath.startTick(1e8, 18, coinIsCurrency0, 5000e8);
        assertEq(p.expectedStartTick, expectedTick, "opening uses the asset's real USD value");
        assertTrue(expectedTick != falsePegTick, "a $1 peg would initialize a different price");
        address coin = _launch(p);
        assertEq(coin, predicted);
        assertGt(IB20(coin).balanceOf(creator), 0);
        assertEq(config.quotePriceUsdE8(address(token)), TOKEN_USD_E8);
        assertEq(uint256(config.quote(address(token)).kind), 3);
        assertEq(vault.creatorPendingFor(coin, address(token)), 80e18);
        assertEq(vault.platformPending(hook.quoteCurrencyOf(coin)), 20e18);
    }

    function test_tokenKind_stalePriceBlocksNewLaunchesButExistingPoolStillTrades() public {
        TestToken token = _enabledToken(18);
        address coin = _launchSimple(address(token), Mode.CREATOR, 100);
        MemeFunFactory.LaunchParams memory stale = _params(address(token), Mode.CREATOR, 100);
        address predicted = factory.predictCoin(creator, stale.salt);
        _skip(MAX_AGE + 1);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                MemeFunConfig.StalePrice.selector, address(token), _now() - MAX_AGE - 1
            )
        );
        factory.launch(stale);
        assertEq(predicted.code.length, 0, "stale launch leaves no token contract");

        token.mint(alice, 10_000e18);
        vm.startPrank(alice);
        token.approve(address(router), 10_000e18);
        uint256 bought = router.buy(
            MemeFunRouter.TradeParams({
                coin: coin,
                amountIn: 10_000e18,
                minAmountOut: 1,
                recipient: address(0),
                referrer: address(0),
                deadline: _now() + 1 hours
            })
        );
        vm.stopPrank();
        assertGt(bought, 0, "trading does not depend on opening-price freshness");
        vm.prank(owner);
        config.setManualPrice(address(token), TOKEN_USD_E8);
        address nextCoin = _launchSimple(address(token), Mode.CREATOR, 100);
        assertTrue(nextCoin != coin, "fresh price permits a new launch");
    }

    function test_tokenKind_keepsDecimalBoundsAndAuthenticatesManualPriceKeeper() public {
        TestToken low = new TestToken("Unsupported", "LOW", 5);
        TestToken high = new TestToken("Unsupported", "HIGH", 19);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidQuote.selector, address(low)));
        config.listQuote(
            address(low), QuoteKind.TOKEN, PriceSource.MANUAL, address(0), TOKEN_USD_E8, MAX_AGE
        );
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidQuote.selector, address(high)));
        config.listQuote(
            address(high), QuoteKind.TOKEN, PriceSource.MANUAL, address(0), TOKEN_USD_E8, MAX_AGE
        );
        vm.stopPrank();
        TestToken six = _listedToken(6);
        TestToken eighteen = _listedToken(18);
        assertEq(config.quote(address(six)).decimals, 6);
        assertEq(config.quote(address(eighteen)).decimals, 18);

        address keeper = makeAddr("tokenPriceKeeper");
        vm.prank(owner);
        config.setPriceKeeper(keeper);
        vm.prank(alice);
        vm.expectRevert(MemeFunConfig.NotPriceKeeper.selector);
        config.setManualPrice(address(six), TOKEN_USD_E8);
        vm.startPrank(keeper);
        config.setManualPrice(address(six), TOKEN_USD_E8 * 12 / 10);
        vm.expectPartialRevert(MemeFunConfig.PriceMoveTooLarge.selector);
        config.setManualPrice(address(six), TOKEN_USD_E8 * 2);
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.setManualPrice(address(six), 0);
        vm.stopPrank();
    }

    function _listedToken(uint8 decimals) private returns (TestToken token) {
        token = new TestToken("Meme quote", "MEME", decimals);
        vm.startPrank(owner);
        config.listQuote(
            address(token), QuoteKind.TOKEN, PriceSource.MANUAL, address(0), TOKEN_USD_E8, MAX_AGE
        );
        config.setQuoteEnabled(address(token), true);
        vm.stopPrank();
    }

    function _enabledToken(uint8 decimals) private returns (TestToken token) {
        token = _listedToken(decimals);
        vm.prank(owner);
        config.setQuoteKindEnabled(uint256(QuoteKind.TOKEN), true);
    }
}
