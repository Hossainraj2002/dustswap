// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {Mode, PriceSource, QuoteKind} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {MockAggregator, TestToken} from "../utils/TestTokens.sol";

/// @dev External wrapper so LaunchMath reverts can be asserted.
contract LaunchMathCaller {
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
}

/// @notice The owner's whole admin surface and every guard on it, plus edge reverts elsewhere.
contract AdminAndEdgesTest is MemeFunFixture {
    // -------------------------------------------------------------------------------------------
    // Config: only the owner, always within the caps
    // -------------------------------------------------------------------------------------------

    function test_config_everySetterIsOwnerOnly() public {
        bytes[] memory calls = new bytes[](14);
        calls[0] = abi.encodeCall(MemeFunConfig.setCreationFee, (0));
        calls[1] = abi.encodeCall(MemeFunConfig.setFeeBounds, (100, 500, 100));
        calls[2] = abi.encodeCall(MemeFunConfig.setPlatformShareBps, (100));
        calls[3] = abi.encodeCall(MemeFunConfig.setReferralShareBps, (100));
        calls[4] = abi.encodeCall(MemeFunConfig.setCreatorKeepMaxBps, (100));
        calls[5] = abi.encodeCall(MemeFunConfig.setLaunchProtection, (100, 1));
        calls[6] = abi.encodeCall(MemeFunConfig.setOpeningFdvUsd, (5_000e8));
        calls[7] = abi.encodeCall(MemeFunConfig.setLaunchesPaused, (true));
        calls[8] = abi.encodeCall(MemeFunConfig.setModeEnabled, (0, true));
        calls[9] = abi.encodeCall(MemeFunConfig.setQuoteKindEnabled, (0, true));
        calls[10] = abi.encodeCall(MemeFunConfig.setTreasury, (alice));
        calls[11] = abi.encodeCall(MemeFunConfig.setPriceKeeper, (alice));
        calls[12] = abi.encodeCall(MemeFunConfig.setRewardsPublisher, (alice));
        calls[13] = abi.encodeCall(MemeFunConfig.setQuoteEnabled, (ETH, false));
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(alice);
            (bool ok, bytes memory ret) = address(config).call(calls[i]);
            assertFalse(ok, "owner only");
            assertEq(bytes4(ret), Ownable.OwnableUnauthorizedAccount.selector);
        }
    }

    function test_config_capsCannotBeExceeded() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("creationFee"), 0.05 ether + 1, 0.05 ether));
        config.setCreationFee(0.05 ether + 1);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("feeMaxBps"), 1_001, 1_000));
        config.setFeeBounds(100, 1_001, 100);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidFeeBounds.selector, 300, 500, 200));
        config.setFeeBounds(300, 500, 200);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("platformShareBps"), 5_001, 5_000));
        config.setPlatformShareBps(5_001);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("referralShareBps"), 5_001, 5_000));
        config.setReferralShareBps(5_001);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("creatorKeepMaxBps"), 5_001, 5_000));
        config.setCreatorKeepMaxBps(5_001);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("protectionStartBps"), 9_901, 9_900));
        config.setLaunchProtection(9_901, 15);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.ValueAboveCap.selector, bytes32("protectionDurationSec"), 301, 300));
        config.setLaunchProtection(5_000, 301);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidOpeningFdv.selector, 999e8));
        config.setOpeningFdvUsd(999e8);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidOpeningFdv.selector, 1_000_001e8));
        config.setOpeningFdvUsd(1_000_001e8);
        vm.stopPrank();
    }

    function test_config_settersApplyAndEmit() public {
        vm.startPrank(owner);
        vm.expectEmit(address(config));
        emit MemeFunConfig.SettingUpdated("creationFee", 0, 0.01 ether);
        config.setCreationFee(0.01 ether);
        config.setFeeBounds(0, 1_000, 250);
        config.setPlatformShareBps(3_000);
        config.setReferralShareBps(1_000);
        config.setCreatorKeepMaxBps(2_500);
        config.setLaunchProtection(9_900, 300);
        config.setOpeningFdvUsd(69_000e8);
        config.setLaunchesPaused(true);
        vm.stopPrank();

        MemeFunConfig.LaunchTerms memory t = config.launchTerms();
        assertEq(t.creationFee, 0.01 ether);
        assertEq(t.feeMinBps, 0);
        assertEq(t.feeMaxBps, 1_000);
        assertEq(t.defaultFeeBps, 250);
        assertEq(t.platformShareBps, 3_000);
        assertEq(t.referralShareBps, 1_000);
        assertEq(t.creatorKeepMaxBps, 2_500);
        assertEq(t.protectionStartBps, 9_900);
        assertEq(t.protectionDurationSec, 300);
        assertTrue(t.launchesPaused);
        assertEq(config.openingFdvUsdE8(), 69_000e8);
    }

    function test_config_modesAndKinds() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidMode.selector, 4));
        config.setModeEnabled(4, true);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidKind.selector, 4));
        config.setQuoteKindEnabled(4, true);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidModule.selector, Mode.CREATOR, address(burnVault)));
        config.setModeModule(0, address(burnVault));
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidModule.selector, Mode.BURN, alice));
        config.setModeModule(1, alice); // no code
        vm.stopPrank();

        // A community mode cannot be enabled before it has a module.
        MemeFunConfig fresh = new MemeFunConfig(owner, treasury);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidModule.selector, Mode.BURN, address(0)));
        fresh.setModeEnabled(1, true);
        assertTrue(fresh.modeInfo(Mode.CREATOR).enabled, "creator mode is on from day one");
        assertFalse(fresh.kindEnabled(QuoteKind.STOCK), "stocks start off");
        assertFalse(fresh.kindEnabled(QuoteKind.TOKEN), "other tokens start off");
    }

    function test_config_quoteListingRules() public {
        TestToken weird = new TestToken("Weird", "WRD", 4);
        TestToken fine = new TestToken("Fine", "FINE", 6);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.QuoteAlreadyListed.selector, ETH));
        config.listQuote(ETH, QuoteKind.NATIVE, PriceSource.FIXED, address(0), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidQuote.selector, address(fine)));
        config.listQuote(address(fine), QuoteKind.NATIVE, PriceSource.FIXED, address(0), 1e8, 0); // only ETH is native
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidQuote.selector, address(weird)));
        config.listQuote(address(weird), QuoteKind.STABLE, PriceSource.FIXED, address(0), 1e8, 0); // 4 decimals
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.listQuote(address(fine), QuoteKind.STABLE, PriceSource.FIXED, address(0), 0, 0); // no price
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.listQuote(address(fine), QuoteKind.STABLE, PriceSource.CHAINLINK, alice, 0, 1 hours); // feed without code
        MockAggregator badFeed = new MockAggregator(18, 1e18);
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.listQuote(address(fine), QuoteKind.STABLE, PriceSource.CHAINLINK, address(badFeed), 0, 1 hours); // 18 dec
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.listQuote(address(fine), QuoteKind.STOCK, PriceSource.MANUAL, address(0), 1e8, 8 days); // age above cap

        config.listQuote(address(fine), QuoteKind.STABLE, PriceSource.FIXED, address(0), 1e8, 0);
        assertFalse(config.isLaunchableQuote(address(fine)), "listed disabled");
        config.setQuoteEnabled(address(fine), true);
        assertTrue(config.isLaunchableQuote(address(fine)));
        config.updateQuotePricing(address(fine), PriceSource.MANUAL, address(0), 2e8, 1 days);
        assertEq(config.quotePriceUsdE8(address(fine)), 2e8);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.QuoteNotListed.selector, alice));
        config.updateQuotePricing(alice, PriceSource.FIXED, address(0), 1e8, 0);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.QuoteNotListed.selector, alice));
        config.setQuoteEnabled(alice, true);
        vm.stopPrank();
        assertEq(config.quotes().length, 4);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.QuoteNotListed.selector, alice));
        config.quotePriceUsdE8(alice);
    }

    function test_config_manualPriceKeeperIsBounded() public {
        address keeper = makeAddr("keeper");
        vm.prank(owner);
        config.setPriceKeeper(keeper);

        vm.prank(alice);
        vm.expectRevert(MemeFunConfig.NotPriceKeeper.selector);
        config.setManualPrice(STOCK_ADDRESS, STOCK_USD_E8);

        vm.startPrank(keeper);
        config.setManualPrice(STOCK_ADDRESS, STOCK_USD_E8 * 12 / 10); // +20%: allowed
        vm.expectPartialRevert(MemeFunConfig.PriceMoveTooLarge.selector);
        config.setManualPrice(STOCK_ADDRESS, STOCK_USD_E8 * 2); // +67%: refused
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.setManualPrice(ETH, 1e8); // not a manual quote
        vm.expectRevert(MemeFunConfig.InvalidPriceConfig.selector);
        config.setManualPrice(STOCK_ADDRESS, 0);
        vm.stopPrank();

        vm.prank(owner); // the owner may correct by any amount
        config.setManualPrice(STOCK_ADDRESS, STOCK_USD_E8 * 3);
        assertEq(config.quotePriceUsdE8(STOCK_ADDRESS), uint256(STOCK_USD_E8) * 3);

        _skip(4 days + 1);
        vm.expectPartialRevert(MemeFunConfig.StalePrice.selector);
        config.quotePriceUsdE8(STOCK_ADDRESS);
    }

    function test_config_chainlinkGuards() public {
        ethUsd.set(0, _now());
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.InvalidPrice.selector, ETH));
        config.quotePriceUsdE8(ETH);
        ethUsd.set(ETH_USD_E8, _now() + 1); // from the future
        vm.expectPartialRevert(MemeFunConfig.StalePrice.selector);
        config.quotePriceUsdE8(ETH);
    }

    function test_config_rolesAndOwnership() public {
        vm.startPrank(owner);
        vm.expectRevert(MemeFunConfig.ZeroAddress.selector);
        config.setTreasury(address(0));
        config.setTreasury(bob);
        config.setRewardsPublisher(address(0));
        vm.expectRevert(MemeFunConfig.OwnershipCannotBeRenounced.selector);
        config.renounceOwnership();
        config.transferOwnership(bob);
        vm.stopPrank();
        assertEq(config.owner(), owner, "two-step: not moved yet");
        vm.prank(bob);
        config.acceptOwnership();
        assertEq(config.owner(), bob);
        assertEq(config.treasury(), bob);
        assertEq(config.rewardsPublisher(), address(0));

        vm.expectRevert(MemeFunConfig.ZeroAddress.selector);
        new MemeFunConfig(owner, address(0));
    }

    // -------------------------------------------------------------------------------------------
    // Router: permits, recipients, refunds
    // -------------------------------------------------------------------------------------------

    function test_router_buyWithPermitUsdc() public {
        address coin = _launchSimple(USDC_ADDRESS, Mode.CREATOR, 100);
        _skip(15);
        (address signer, uint256 key) = makeAddrAndKey("permitBuyer");
        usdc.mint(signer, 1_000e6);
        MemeFunRouter.Permit memory permit = _signPermit(usdc, signer, key, address(router), 500e6);
        MemeFunRouter.TradeParams memory p = _trade(coin, 500e6, bob); // coins go to bob
        vm.prank(signer);
        uint256 out = router.buyWithPermit(p, permit);
        assertEq(IB20(coin).balanceOf(bob), out, "recipient got the coins");
        assertEq(usdc.balanceOf(signer), 500e6);
    }

    function test_router_sellWithPermitOnTheCoin() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        _skip(15);
        (address signer, uint256 key) = makeAddrAndKey("permitSeller");
        deal(signer, 2 ether);
        vm.prank(signer);
        uint256 coins = router.buy{value: 1 ether}(_trade(coin, 1 ether, address(0)));
        MemeFunRouter.Permit memory permit = _signB20Permit(IB20(coin), signer, key, address(router), coins);
        uint256 before = signer.balance;
        vm.prank(signer);
        uint256 out = router.sellWithPermit(_trade(coin, coins, address(0)), permit);
        assertEq(signer.balance - before, out, "one signature, one transaction");
    }

    function test_router_permitFailureFallsBackToAllowance() public {
        address coin = _launchSimple(USDC_ADDRESS, Mode.CREATOR, 100);
        _skip(15);
        MemeFunRouter.Permit memory junk;
        vm.startPrank(alice);
        usdc.approve(address(router), 100e6);
        uint256 out = router.buyWithPermit(_trade(coin, 100e6, address(0)), junk);
        vm.stopPrank();
        assertGt(out, 0, "a bad permit does not block a trade with an allowance");
    }

    // -------------------------------------------------------------------------------------------
    // Vault, hook and distributor edges
    // -------------------------------------------------------------------------------------------

    function test_vault_claimGuards() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 300);
        vm.startPrank(creator);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.claimCreator(coin, address(0));
        address[] memory coins = new address[](1);
        coins[0] = coin;
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claimCreatorMany(coins, creator);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.claimCreatorMany(coins, address(0));
        vm.stopPrank();
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        vault.claimReferral(Currency.wrap(ETH), address(0));
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claimReferral(Currency.wrap(ETH), alice);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claimPlatform(Currency.wrap(USDC_ADDRESS));
    }

    function test_hook_viewsAndRegistryGuards() public {
        vm.expectRevert(abi.encodeWithSelector(MemeFunHook.UnknownCoin.selector, alice));
        hook.poolKeyOf(alice);
        assertEq(hook.moduleOf(alice), address(0), "unknown coin has no module");

        address coin = _launchSimple(ETH, Mode.FLOOR, 200);
        PoolId id = hook.poolIdOf(coin);
        assertEq(hook.configOfPool(id).coin, coin);
        assertEq(hook.moduleOf(coin), address(floorVault));
        assertEq(hook.blockStartSqrtPriceX96(id), _sqrtPrice(coin), "no swap yet this block: the live price");

        // registerPool validates the key against the config.
        IMemeFunHook.PoolConfig memory c = hook.configOf(coin);
        c.coin = address(0xB2);
        PoolKey memory key = hook.poolKeyOf(coin);
        key.fee = 3_000;
        vm.prank(address(factory));
        vm.expectRevert(MemeFunHook.InvalidPoolKey.selector);
        hook.registerPool(key, c, alice);
        key.fee = 0;
        key.hooks = IHooks(address(0));
        vm.prank(address(factory));
        vm.expectRevert(MemeFunHook.InvalidPoolKey.selector);
        hook.registerPool(key, c, alice);
    }

    function test_holders_publishShapeGuards() public {
        address coin = _launchSimple(ETH, Mode.HOLDERS, 500);
        _skip(15);
        vm.prank(alice);
        router.buy{value: 5 ether}(_trade(coin, 5 ether, address(0)));
        address[] memory coins = new address[](1);
        coins[0] = coin;
        uint256[] memory totals = new uint256[](2);
        vm.startPrank(publisher);
        vm.expectRevert(HolderRewardDistributor.EmptyRoot.selector);
        holders.publishEpoch(1, bytes32(0), coins, totals);
        vm.expectRevert(HolderRewardDistributor.LengthMismatch.selector);
        holders.publishEpoch(1, bytes32(uint256(1)), coins, totals);
        address[] memory twice = new address[](2);
        twice[0] = coin;
        twice[1] = coin;
        totals[0] = 1;
        totals[1] = 1;
        vm.expectRevert(abi.encodeWithSelector(HolderRewardDistributor.DuplicateCoin.selector, coin));
        holders.publishEpoch(1, bytes32(uint256(1)), twice, totals);
        vm.stopPrank();

        vm.expectRevert(HolderRewardDistributor.EpochUnavailable.selector);
        holders.releaseEpoch(7, coins);
        vm.prank(owner);
        vm.expectRevert(HolderRewardDistributor.EpochUnavailable.selector);
        holders.vetoEpoch(7);
        assertFalse(holders.isClaimed(1, coin, 0));
    }

    function test_launchMath_rejectsUnlaunchableInputs() public {
        LaunchMathCaller caller = new LaunchMathCaller();
        vm.expectRevert(LaunchMath.InvalidPriceInput.selector);
        caller.startTick(0, 18, false, 5_000e8);
        vm.expectRevert(LaunchMath.InvalidPriceInput.selector);
        caller.startTick(1e8, 19, false, 5_000e8);
        vm.expectRevert(LaunchMath.InvalidPriceInput.selector);
        caller.startTick(1e8, 18, false, 0);
        // A raw price of 1e-40 (an absurdly valuable 6-decimal quote) is below the smallest sqrt
        // price v4 can represent.
        vm.expectRevert(LaunchMath.OpeningPriceOutOfRange.selector);
        caller.startTick(1e30, 6, true, 1_000e8);
        // An absurdly cheap quote at the top FDV is still launchable: nothing realistic is refused.
        assertEq(caller.startTick(1, 18, true, 1_000_000e8) % 200, 0);
        vm.expectRevert(LaunchMath.OpeningPriceOutOfRange.selector);
        caller.liquidityForSupply(-886_000, false);
    }


    // -------------------------------------------------------------------------------------------
    // Remaining guard paths
    // -------------------------------------------------------------------------------------------

    function test_vault_claimCreatorManyRequiresEveryCoin() public {
        address mine = _launchSimple(ETH, Mode.CREATOR, 300);
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 300);
        address theirs = _launchAs(alice, p);
        address[] memory coins = new address[](2);
        coins[0] = mine;
        coins[1] = theirs;
        vm.prank(creator);
        vm.expectRevert(FeeVault.NotCreator.selector);
        vault.claimCreatorMany(coins, creator);
    }

    function test_config_manualPriceForUnlistedQuote() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MemeFunConfig.QuoteNotListed.selector, alice));
        config.setManualPrice(alice, 1e8);
    }

    function test_factory_uriAndTreasuryGuards() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
        bytes memory longUri = new bytes(257);
        for (uint256 i; i < longUri.length; ++i) longUri[i] = "a";
        p.contractURI = string(longUri);
        vm.prank(creator);
        vm.expectRevert(MemeFunFactory.InvalidUri.selector);
        factory.launch(p);

        // A treasury that cannot take ETH blocks only launches that pay a creation fee.
        RejectsEth rejecting = new RejectsEth();
        vm.startPrank(owner);
        config.setTreasury(address(rejecting));
        config.setCreationFee(0.001 ether);
        vm.stopPrank();
        p = _params(ETH, Mode.CREATOR, 100);
        p.expectedStartTick = _expectedStartTick(ETH, p.salt, creator);
        vm.prank(creator);
        vm.expectRevert(MemeFunFactory.EthTransferFailed.selector);
        factory.launch{value: 0.001 ether}(p);
    }

    function test_hook_creatorAndInitializeGuards() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        vm.prank(alice);
        vm.expectRevert(MemeFunHook.NotCreator.selector);
        hook.proposeCreator(coin, alice);

        // Even the factory cannot initialize a pool it never registered.
        PoolKey memory key = hook.poolKeyOf(coin);
        key.currency1 = Currency.wrap(address(0xB2000000000000000000000000000000000000FF));
        vm.prank(address(factory));
        vm.expectRevert();
        manager.initialize(key, 79228162514264337593543950336);
    }

    function test_launchMath_topOfRangeAndNegativeTicks() public {
        LaunchMathCaller caller = new LaunchMathCaller();
        // Representable, but it snaps to tick 887,200: past the last usable launch tick.
        vm.expectRevert(LaunchMath.OpeningPriceOutOfRange.selector);
        caller.startTick(339e26, 6, false, 1_000e8);
        // A coin worth more than one raw quote unit per raw coin: a negative tick, floored.
        int24 tick = caller.startTick(1, 18, false, 1_000_000e8);
        assertLt(tick, 0);
        assertEq(tick % 200, 0);
    }

    function test_floor_evenDustBecomesLiquidity_butNothingIsRefused() public {
        address coin = _launchSimple(ETH, Mode.FLOOR, 100);
        _nextBlock();
        vm.expectRevert(FloorVault.NothingToAdd.selector);
        floorVault.addFloor(coin); // no fees yet
        _skip(15);
        // A 1-wei trade leaves a 1-wei floor share; at real prices even that is liquidity.
        vm.prank(alice);
        router.buy{value: 1}(_trade(coin, 1, address(0)));
        _nextBlock();
        (,, uint128 liquidity, uint256 used) = floorVault.addFloor(coin);
        assertGt(liquidity, 0);
        assertLe(used, 1);
    }

    function test_holders_lateClaimsAndZeroLeaves() public {
        address coin = _launchSimple(ETH, Mode.HOLDERS, 500);
        _skip(15);
        vm.prank(alice);
        router.buy{value: 5 ether}(_trade(coin, 5 ether, address(0)));
        uint256 pot = vault.destinationPending(coin);
        // A one-leaf epoch paying 0 (the root is the leaf).
        bytes32 root = holders.leaf(1, coin, 0, alice, 0);
        address[] memory coins = new address[](1);
        coins[0] = coin;
        uint256[] memory totals = new uint256[](1);
        totals[0] = pot;
        vm.prank(publisher);
        holders.publishEpoch(1, root, coins, totals);
        _skip(12 hours);
        HolderRewardDistributor.Claim memory c = HolderRewardDistributor.Claim({
            epoch: 1,
            coin: coin,
            index: 0,
            account: alice,
            amount: 0,
            proof: new bytes32[](0)
        });
        uint256 before = alice.balance;
        holders.claim(c);
        assertEq(alice.balance, before, "zero leaf pays nothing and does not revert");

        _skip(90 days);
        c.index = 1;
        vm.expectRevert(HolderRewardDistributor.ClaimPeriodOver.selector);
        holders.claim(c);
    }

    // -------------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------------

    function _trade(address coin, uint256 amountIn, address recipient) internal view returns (MemeFunRouter.TradeParams memory) {
        return MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: amountIn,
            minAmountOut: 0,
            recipient: recipient,
            referrer: address(0),
            deadline: _now() + 60
        });
    }

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _signPermit(TestToken token, address signer, uint256 key, address spender, uint256 value)
        internal
        view
        returns (MemeFunRouter.Permit memory p)
    {
        p.value = value;
        p.deadline = _now() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, signer, spender, value, token.nonces(signer), p.deadline))
            )
        );
        (p.v, p.r, p.s) = vm.sign(key, digest);
    }

    function _signB20Permit(IB20 token, address signer, uint256 key, address spender, uint256 value)
        internal
        view
        returns (MemeFunRouter.Permit memory p)
    {
        p.value = value;
        p.deadline = _now() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, signer, spender, value, token.nonces(signer), p.deadline))
            )
        );
        (p.v, p.r, p.s) = vm.sign(key, digest);
    }
}

contract RejectsEth {
    receive() external payable {
        revert("no ETH");
    }
}
