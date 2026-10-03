// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

contract LaunchTest is MemeFunFixture {
    using StateLibrary for IPoolManager;

    // -------------------------------------------------------------------------------------------
    // The launch itself
    // -------------------------------------------------------------------------------------------

    function test_launch_eth_locksWholeSupplyAtTheOpeningPrice() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        _assertLaunched(coin, ETH, false);
    }

    function test_launch_usdc_sixDecimals() public {
        address coin = _launchSimple(USDC_ADDRESS, Mode.CREATOR, 300);
        _assertLaunched(coin, USDC_ADDRESS, false);
    }

    function test_launch_stock_coinIsCurrency0() public {
        address coin = _launchSimple(STOCK_ADDRESS, Mode.CREATOR, 500);
        assertLt(uint160(coin), uint160(STOCK_ADDRESS), "stock sorts above every B20");
        _assertLaunched(coin, STOCK_ADDRESS, true);
    }

    function _assertLaunched(address coin, address quote, bool coinIsCurrency0) internal view {
        IB20 token = IB20(coin);
        assertEq(token.totalSupply(), LaunchMath.SUPPLY, "fixed supply");
        assertEq(token.balanceOf(address(factory)), 0, "factory keeps nothing");
        assertEq(token.name(), "Sock Puppet");
        assertEq(token.symbol(), "SOCK");
        assertEq(token.contractURI(), "ipfs://bafy-sock-puppet");

        // Nobody holds any role: not the creator, the factory, the hook or the owner.
        bytes32[9] memory roles = _allB20Roles();
        address[5] memory actors = [creator, address(factory), address(hook), owner, address(B20_FACTORY)];
        for (uint256 r; r < roles.length; ++r) {
            for (uint256 a; a < actors.length; ++a) assertFalse(token.hasRole(roles[r], actors[a]), "no role exists");
        }

        // Pool: opened exactly at the computed tick, whole supply in one locked position.
        PoolKey memory key = hook.poolKeyOf(coin);
        assertEq(Currency.unwrap(coinIsCurrency0 ? key.currency0 : key.currency1), coin, "ordering");
        assertEq(Currency.unwrap(coinIsCurrency0 ? key.currency1 : key.currency0), quote, "ordering");
        assertEq(key.fee, 0, "no LP fee, the hook takes the fee");
        assertEq(key.tickSpacing, 200);

        int24 expected = LaunchMath.startTick(
            config.quotePriceUsdE8(quote), config.quote(quote).decimals, coinIsCurrency0, config.openingFdvUsdE8()
        );
        (uint160 sqrtPriceX96, int24 tick,,) = manager.getSlot0(key.toId());
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(expected), "opening price");
        assertEq(tick, expected, "opening tick");

        (int24 lower, int24 upper) = LaunchMath.launchRange(expected, coinIsCurrency0);
        uint128 positionLiquidity = manager.getPositionLiquidity(
            key.toId(), keccak256(abi.encodePacked(address(factory), lower, upper, bytes32(0)))
        );
        assertEq(positionLiquidity, LaunchMath.liquidityForSupply(expected, coinIsCurrency0), "one position, whole supply");

        // Everything is in the pool except rounding dust, which went to dEaD.
        uint256 dust = token.balanceOf(DEAD);
        assertLe(dust, LaunchMath.SUPPLY / 1e6, "dust is negligible");
        assertEq(token.balanceOf(address(manager)) + dust, LaunchMath.SUPPLY, "supply is in the pool");

        // Registry snapshot.
        IMemeFunHook.PoolConfig memory c = hook.configOf(coin);
        assertEq(c.coin, coin);
        assertEq(c.quoteIsCurrency0, !coinIsCurrency0);
        assertEq(c.platformShareBps, 2_000);
        assertEq(c.referralShareBps, 2_500);
        assertEq(c.protectionStartBps, 5_000);
        assertEq(c.protectionDurationSec, 15);
        assertEq(c.launchedAt, block.timestamp);
        assertTrue(c.seeded);
        assertEq(hook.creatorOf(coin), creator);
        assertEq(factory.launchCount(), 1);
    }

    function test_launch_openingFdvIsAtOrJustAboveTarget() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        // FDV = supply * coin price in ETH * ETH/USD. Coin is currency1: price(ETH per coin) = 1 / p.
        uint256 sqrtPriceX96 = _sqrtPrice(coin);
        uint256 coinsPerEth = sqrtPriceX96 * sqrtPriceX96 >> 192; // raw coin per raw ETH, both 18 dec
        uint256 fdvUsd = 1_000_000_000 * uint256(ETH_USD_E8) / 1e8 / coinsPerEth;
        assertGe(fdvUsd, 4_999, "never below the $5,000 target");
        assertLe(fdvUsd, 5_110, "at most one spacing (~2%) above");
    }

    function test_launch_predictCoin_matchesAndIsScopedToCreator() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        address predicted = factory.predictCoin(creator, p.salt);
        assertTrue(predicted != factory.predictCoin(alice, p.salt), "same salt, different creator, different coin");
        address coin = _launch(p);
        assertEq(coin, predicted);

        // Reusing the same salt is impossible for the creator...
        vm.expectRevert();
        this.launchAs(creator, p);
        // ...and harmless for anyone else: they get their own address.
        address other = _launchAs(alice, p);
        assertTrue(other != coin);
    }

    function launchAs(address who, MemeFunFactory.LaunchParams memory p) external returns (address) {
        return _launchAs(who, p);
    }

    // -------------------------------------------------------------------------------------------
    // First buy
    // -------------------------------------------------------------------------------------------

    function test_firstBuy_eth_paysBaseFeeNotProtection() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 300);
        p.firstBuyAmount = 1 ether;
        uint256 balanceBefore = creator.balance;
        address coin = _launch(p);

        uint256 fee = FeeMath.onGross(1 ether, 300); // 3%, not the 50% protection rate
        assertEq(balanceBefore - creator.balance, 1 ether, "paid exactly the first buy");
        assertGt(IB20(coin).balanceOf(creator), 0, "received coins");
        assertEq(_vaultClaims(Currency.wrap(ETH)), fee, "fee minted to the vault as claims");
        assertEq(vault.platformPending(Currency.wrap(ETH)), fee * 2_000 / 10_000, "platform 20%");
        assertEq(vault.creatorPending(coin), fee - fee * 2_000 / 10_000, "creator mode: the rest to the creator");
        assertEq(address(factory).balance, 0, "factory keeps no ETH");
    }

    function test_firstBuy_usdc_pullsFromCreator() public {
        MemeFunFactory.LaunchParams memory p = _params(USDC_ADDRESS, Mode.CREATOR, 100);
        p.firstBuyAmount = 250e6;
        uint256 before = usdc.balanceOf(creator);
        address coin = _launch(p);
        assertEq(before - usdc.balanceOf(creator), 250e6);
        assertGt(IB20(coin).balanceOf(creator), 0);
        assertEq(_vaultClaims(Currency.wrap(USDC_ADDRESS)), FeeMath.onGross(250e6, 100));
    }

    function test_firstBuy_stock_coinAsCurrency0() public {
        MemeFunFactory.LaunchParams memory p = _params(STOCK_ADDRESS, Mode.CREATOR, 100);
        p.firstBuyAmount = 3e8; // 3 shares
        address coin = _launch(p);
        assertGt(IB20(coin).balanceOf(creator), 0);
        assertEq(_vaultClaims(Currency.wrap(STOCK_ADDRESS)), FeeMath.onGross(3e8, 100));
    }

    function test_firstBuy_respectsMinCoins() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.firstBuyAmount = 0.01 ether;
        p.firstBuyMinCoins = type(uint256).max;
        p.expectedStartTick = _expectedStartTick(ETH, p.salt, creator);
        vm.prank(creator);
        vm.expectRevert();
        factory.launch{value: 0.01 ether}(p);
    }

    // -------------------------------------------------------------------------------------------
    // Terms are snapshotted
    // -------------------------------------------------------------------------------------------

    function test_settingsChangesNeverReachExistingCoins() public {
        address coin = _launchSimple(ETH, Mode.BURN, 400);
        IMemeFunHook.PoolConfig memory before = hook.configOf(coin);

        vm.startPrank(owner);
        config.setPlatformShareBps(5_000);
        config.setReferralShareBps(0);
        config.setLaunchProtection(9_900, 300);
        config.setFeeBounds(0, 1_000, 1_000);
        config.setModeModule(uint256(Mode.BURN), address(new StubModuleForTest()));
        vm.stopPrank();

        IMemeFunHook.PoolConfig memory afterChange = hook.configOf(coin);
        assertEq(keccak256(abi.encode(afterChange)), keccak256(abi.encode(before)), "existing coin untouched");

        // A new launch uses the new terms.
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.BURN, 1_000);
        p.salt = bytes32(uint256(77));
        address next = _launch(p);
        assertEq(hook.configOf(next).platformShareBps, 5_000);
        assertEq(hook.configOf(next).protectionStartBps, 9_900);
        assertTrue(hook.configOf(next).module != before.module);
    }

    // -------------------------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------------------------

    function test_revert_whenLaunchesPaused() public {
        vm.prank(owner);
        config.setLaunchesPaused(true);
        _expectLaunchRevert(_params(ETH, Mode.CREATOR, 100), abi.encodeWithSelector(MemeFunFactory.LaunchesPaused.selector));
    }

    function test_revert_feeOutsideBounds() public {
        _expectLaunchRevert(
            _params(ETH, Mode.CREATOR, 99),
            abi.encodeWithSelector(MemeFunFactory.FeeOutOfBounds.selector, 99, 100, 500)
        );
        _expectLaunchRevert(
            _params(ETH, Mode.CREATOR, 501),
            abi.encodeWithSelector(MemeFunFactory.FeeOutOfBounds.selector, 501, 100, 500)
        );
    }

    function test_revert_creatorKeepRules() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.creatorKeepBps = 1;
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.CreatorKeepNotAllowed.selector, 1, 0));

        p = _params(ETH, Mode.HOLDERS, 100);
        p.creatorKeepBps = 5_001;
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.CreatorKeepNotAllowed.selector, 5_001, 5_000));
    }

    function test_revert_nameSymbolUri() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.name = "";
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.InvalidName.selector));
        p.name = "This name is far too long for a memefun coin at all";
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.InvalidName.selector));
        p = _params(ETH, Mode.CREATOR, 100);
        p.symbol = "TOOLONGTICK";
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.InvalidSymbol.selector));
        p.symbol = "";
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.InvalidSymbol.selector));
    }

    function test_revert_wrongValue() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.firstBuyAmount = 1 ether;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MemeFunFactory.WrongValue.selector, 1 ether, 0.5 ether));
        factory.launch{value: 0.5 ether}(p);
    }

    function test_creationFee_goesToTreasury() public {
        vm.prank(owner);
        config.setCreationFee(0.01 ether);
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.expectedStartTick = _expectedStartTick(ETH, p.salt, creator);
        vm.prank(creator);
        factory.launch{value: 0.01 ether}(p);
        assertEq(treasury.balance, 0.01 ether);
    }

    function test_revert_startTickDrift() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.expectedStartTick = _expectedStartTick(ETH, p.salt, creator);
        // ETH doubles between the app's quote and the transaction.
        ethUsd.set(ETH_USD_E8 * 2, _now());
        vm.prank(creator);
        vm.expectPartialRevert(MemeFunFactory.StartTickDrift.selector);
        factory.launch(p);
    }

    function test_revert_stalePriceBlocksOnlyThatQuote() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        ethUsd.set(ETH_USD_E8, _now() - 2 hours);
        vm.prank(creator);
        vm.expectPartialRevert(MemeFunConfig.StalePrice.selector);
        factory.launch(p);
        // USDC launches are unaffected.
        _launchSimple(USDC_ADDRESS, Mode.CREATOR, 100);
    }

    function test_revert_disabledQuoteKindOrMode() public {
        vm.prank(owner);
        config.setQuoteKindEnabled(2, false);
        _expectLaunchRevert(
            _params(STOCK_ADDRESS, Mode.CREATOR, 100),
            abi.encodeWithSelector(MemeFunFactory.QuoteNotLaunchable.selector, STOCK_ADDRESS)
        );
        vm.prank(owner);
        config.setModeEnabled(uint256(Mode.FLOOR), false);
        _expectLaunchRevert(
            _params(ETH, Mode.FLOOR, 100), abi.encodeWithSelector(MemeFunFactory.ModeNotEnabled.selector, Mode.FLOOR)
        );
    }

    function test_revert_expired() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        p.deadline = _now() - 1;
        _expectLaunchRevert(p, abi.encodeWithSelector(MemeFunFactory.Expired.selector));
    }

    function _expectLaunchRevert(MemeFunFactory.LaunchParams memory p, bytes memory reason) internal {
        vm.prank(creator);
        vm.expectRevert(reason);
        factory.launch(p);
    }
}

contract StubModuleForTest {}
