// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {BuybackBurnVault} from "../../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {Mode, PriceSource, QuoteKind} from "../../src/types/MemeFunTypes.sol";
import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {TestToken} from "../utils/TestTokens.sol";

contract MultiLaunchTest is MemeFunFixture {
    using StateLibrary for IPoolManager;

    address[5] internal quotes;
    bytes32 private constant MARKET_EVENT = keccak256(
        "MarketLaunched(address,address,bytes32,uint256,uint256,(bytes32,uint8,address,uint256,uint256,uint256,uint256,uint256,uint256,int24,uint128,uint256,uint256,uint256,uint256))"
    );

    function setUp() public override {
        super.setUp();
        quotes[0] = ETH;
        quotes[1] = USDC_ADDRESS;
        quotes[2] = STOCK_ADDRESS;
        for (uint256 i = 3; i < 5; ++i) {
            TestToken token = new TestToken("Other USD", "USD", i == 3 ? 18 : 6);
            quotes[i] = address(token);
            token.mint(creator, 1_000_000 * 10 ** token.decimals());
            vm.startPrank(owner);
            config.listQuote(
                address(token), QuoteKind.STABLE, PriceSource.FIXED, address(0), 1e8, 0
            );
            config.setQuoteEnabled(address(token), true);
            vm.stopPrank();
        }
    }

    function _multiParams(
        Mode mode,
        uint256 count,
        bool firstBuys
    )
        internal
        returns (MemeFunFactory.LaunchParams memory base, MemeFunFactory.PairParams[] memory pairs)
    {
        base = _params(ETH, mode, 300);
        pairs = new MemeFunFactory.PairParams[](count);
        for (uint256 i; i < count; ++i) {
            uint256 amount;
            if (firstBuys) amount = i == 0 ? 0.05 ether : 10 ** config.quote(quotes[i]).decimals;
            pairs[i] = MemeFunFactory.PairParams(
                quotes[i],
                amount,
                amount == 0 ? 0 : 1,
                _expectedStartTick(quotes[i], base.salt, creator),
                0
            );
        }
        base.quote = pairs[0].quote;
        base.firstBuyAmount = pairs[0].firstBuyAmount;
        base.firstBuyMinCoins = pairs[0].firstBuyMinCoins;
        base.expectedStartTick = pairs[0].expectedStartTick;
        base.maxTickDrift = pairs[0].maxTickDrift;
    }

    function _multi(
        Mode mode,
        uint256 count,
        bool firstBuys
    )
        internal
        returns (address coin, PoolId[] memory ids, uint256[] memory bought)
    {
        (MemeFunFactory.LaunchParams memory base, MemeFunFactory.PairParams[] memory pairs) =
            _multiParams(mode, count, firstBuys);
        vm.startPrank(creator);
        for (uint256 i; i < count; ++i) {
            if (pairs[i].quote != ETH) {
                TestToken(pairs[i].quote).approve(address(factory), pairs[i].firstBuyAmount);
            }
        }
        (coin, ids, bought) = factory.launchMulti{
            value: base.firstBuyAmount + config.launchTerms().creationFee
        }(
            base, pairs
        );
        vm.stopPrank();
    }

    function test_twoMarketsAllocateOneSupply() public {
        _assertAllocation(2);
    }

    function test_threeMarketsAllocateOneSupply() public {
        _assertAllocation(3);
    }

    function test_fiveMarketsAllocateOneSupply() public {
        _assertAllocation(5);
    }

    function _assertAllocation(uint256 count) internal {
        vm.recordLogs();
        (address coin, PoolId[] memory ids, uint256[] memory bought) =
            _multi(Mode.CREATOR, count, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 allocated;
        uint256 deposited;
        uint256 events;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory) || logs[i].topics[0] != MARKET_EVENT) continue;
            (uint256 allocation, uint256 used, MemeFunFactory.LaunchRecord memory record) =
                abi.decode(logs[i].data, (uint256, uint256, MemeFunFactory.LaunchRecord));
            assertEq(PoolId.unwrap(record.poolId), PoolId.unwrap(ids[events]));
            assertEq(
                record.openingFdvUsdE8, config.openingFdvUsdE8(), "each market uses global FDV"
            );
            bool coinIs0 = uint160(coin) < uint160(quotes[events]);
            assertEq(
                record.startTick,
                LaunchMath.startTick(
                    config.quotePriceUsdE8(quotes[events]),
                    config.quote(quotes[events]).decimals,
                    coinIs0,
                    config.openingFdvUsdE8()
                ),
                "price uses total supply"
            );
            assertEq(
                record.liquidity,
                LaunchMath.liquidityForAmount(record.startTick, coinIs0, allocation)
            );
            assertEq(
                allocation,
                events + 1 == count
                    ? LaunchMath.SUPPLY - (LaunchMath.SUPPLY / count) * events
                    : LaunchMath.SUPPLY / count
            );
            assertGt(used, 0);
            assertLe(used, allocation);
            allocated += allocation;
            deposited += used;
            ++events;
        }
        assertEq(events, count);
        assertEq(allocated, LaunchMath.SUPPLY);
        assertEq(deposited, IB20(coin).balanceOf(address(manager)));
        assertEq(deposited + IB20(coin).balanceOf(DEAD), LaunchMath.SUPPLY);
        assertEq(IB20(coin).balanceOf(address(factory)), 0);
        assertEq(address(factory).balance, 0);
        assertEq(IB20(coin).totalSupply(), LaunchMath.SUPPLY);
        assertEq(factory.launchCount(), 1, "one launch per coin");
        assertEq(hook.poolIdsOf(coin).length, count);
        assertEq(hook.poolKeysOf(coin).length, count);
        assertEq(PoolId.unwrap(hook.poolIdOf(coin)), PoolId.unwrap(ids[0]), "legacy primary");
        for (uint256 i; i < count; ++i) {
            assertEq(bought[i], 0);
            assertEq(PoolId.unwrap(hook.poolIdFor(coin, quotes[i])), PoolId.unwrap(ids[i]));
            assertEq(hook.configOfPool(ids[i]).coin, coin);
            assertTrue(hook.configFor(coin, quotes[i]).seeded);
        }
    }

    function test_duplicateAndMarketCountGuards() public {
        (MemeFunFactory.LaunchParams memory base, MemeFunFactory.PairParams[] memory pairs) =
            _multiParams(Mode.CREATOR, 2, false);
        pairs[1] = pairs[0];
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MemeFunFactory.DuplicateQuote.selector, ETH));
        factory.launchMulti(base, pairs);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MemeFunFactory.InvalidMarketCount.selector, 0));
        factory.launchMulti(base, new MemeFunFactory.PairParams[](0));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MemeFunFactory.InvalidMarketCount.selector, 6));
        factory.launchMulti(base, new MemeFunFactory.PairParams[](6));
        assertEq(factory.launchCount(), 0);
    }

    function test_primaryFieldsCannotSilentlyDisagree() public {
        (MemeFunFactory.LaunchParams memory base, MemeFunFactory.PairParams[] memory pairs) =
            _multiParams(Mode.CREATOR, 2, false);
        base.quote = USDC_ADDRESS;
        vm.prank(creator);
        vm.expectRevert(MemeFunFactory.PrimaryPairMismatch.selector);
        factory.launchMulti(base, pairs);
    }

    function test_lastMarketDriftRollsBackCoinAndEarlierPools() public {
        (MemeFunFactory.LaunchParams memory base, MemeFunFactory.PairParams[] memory pairs) =
            _multiParams(Mode.CREATOR, 3, false);
        address predicted = factory.predictCoin(creator, base.salt);
        pairs[2].expectedStartTick += 200;
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                MemeFunFactory.StartTickDrift.selector,
                pairs[2].expectedStartTick,
                pairs[2].expectedStartTick - 200
            )
        );
        factory.launchMulti(base, pairs);
        assertEq(factory.launchCount(), 0);
        assertEq(hook.creatorOf(predicted), address(0));
        vm.expectRevert(abi.encodeWithSelector(MemeFunHook.UnknownCoin.selector, predicted));
        hook.poolKeyOf(predicted);
        vm.prank(creator);
        pairs[2].expectedStartTick -= 200;
        (address coin,,) = factory.launchMulti(base, pairs);
        assertEq(coin, predicted, "same salt succeeds after atomic rollback");
    }

    function test_firstBuysAndCreatorTransferKeepEachCurrencySeparate() public {
        uint256 ethBefore = creator.balance;
        uint256 usdcBefore = usdc.balanceOf(creator);
        uint256 stockBefore = stock.balanceOf(creator);
        (address coin, PoolId[] memory ids, uint256[] memory bought) = _multi(Mode.CREATOR, 3, true);
        assertEq(ethBefore - creator.balance, 0.05 ether);
        assertEq(usdcBefore - usdc.balanceOf(creator), 1e6);
        assertEq(stockBefore - stock.balanceOf(creator), 1e8);
        assertEq(IB20(coin).balanceOf(creator), bought[0] + bought[1] + bought[2]);
        assertEq(address(factory).balance, 0);
        assertEq(IB20(coin).balanceOf(address(factory)), 0);
        vm.prank(creator);
        hook.proposeCreator(coin, bob);
        vm.prank(bob);
        hook.acceptCreator(coin);
        for (uint256 i; i < 3; ++i) {
            uint256 input = i == 0 ? 0.05 ether : 10 ** config.quote(quotes[i]).decimals;
            uint256 fee = FeeMath.onGross(input, 300);
            uint256 owed = fee - fee * config.launchTerms().platformShareBps / 10_000;
            assertEq(vault.creatorPendingFor(coin, quotes[i]), owed);
            assertEq(
                manager.balanceOf(address(vault), Currency.wrap(quotes[i]).toId()),
                fee,
                "no quote-unit mixing"
            );
            vm.prank(creator);
            vm.expectRevert(FeeVault.NotCreator.selector);
            vault.claimCreatorFor(coin, quotes[i], creator);
            uint256 before = _balance(Currency.wrap(quotes[i]), alice);
            vm.prank(bob);
            vault.claimCreatorFor(coin, quotes[i], alice);
            assertEq(
                _balance(Currency.wrap(quotes[i]), alice) - before,
                owed,
                "new creator owns unclaimed fee"
            );
            assertEq(vault.creatorPendingFor(coin, quotes[i]), 0);
        }
        vm.prank(bob);
        hook.lowerFee(coin, 50);
        for (uint256 i; i < 3; ++i) {
            assertEq(hook.configOfPool(ids[i]).feeBps, 50);
        }
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MemeFunHook.FeeNotLower.selector, 50, 100));
        hook.lowerFee(coin, 100);
        vm.prank(bob);
        hook.lowerFee(coin, 0);
        for (uint256 i; i < 3; ++i) {
            assertEq(hook.configOfPool(ids[i]).feeBps, 0);
        }
    }

    function test_partialNativeFirstBuyRefundsAndChargesCreationFeeOnce() public {
        // An extreme valid oracle price makes the finite launch range exhaustible in uint128
        // quote units, exercising the refund branch while the secondary USDC market stays full.
        ethUsd.set(1e39, _now());
        vm.prank(owner);
        config.setCreationFee(0.01 ether);
        (MemeFunFactory.LaunchParams memory base, MemeFunFactory.PairParams[] memory pairs) =
            _multiParams(Mode.CREATOR, 2, false);
        pairs[0].firstBuyAmount = 1e32;
        pairs[0].firstBuyMinCoins = 1;
        base.firstBuyAmount = pairs[0].firstBuyAmount;
        base.firstBuyMinCoins = pairs[0].firstBuyMinCoins;
        vm.deal(creator, 2e32);
        uint256 before = creator.balance;
        vm.recordLogs();
        vm.prank(creator);
        (address coin,, uint256[] memory bought) =
            factory.launchMulti{value: 1e32 + 0.01 ether}(base, pairs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 spent;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory) || logs[i].topics[0] != MARKET_EVENT) continue;
            (,, MemeFunFactory.LaunchRecord memory record) =
                abi.decode(logs[i].data, (uint256, uint256, MemeFunFactory.LaunchRecord));
            if (address(uint160(uint256(logs[i].topics[2]))) == ETH) spent = record.firstBuyQuote;
        }
        assertGt(spent, 0);
        assertLt(spent, pairs[0].firstBuyAmount, "finite range refunds unused native input");
        assertEq(before - creator.balance, spent + 0.01 ether);
        assertEq(treasury.balance, 0.01 ether, "creation fee is per coin");
        assertGt(bought[0], 0);
        assertEq(bought[1], 0);
        assertEq(IB20(coin).balanceOf(creator), bought[0]);
        assertEq(vault.creatorPendingFor(coin, USDC_ADDRESS), 0);
        assertEq(address(factory).balance, 0);
        assertEq(IB20(coin).balanceOf(address(factory)), 0);
    }

    function test_secondaryTradesUseTheirOwnQuotes() public {
        (address coin,,) = _multi(Mode.CREATOR, 3, false);
        _skip(15);
        MemeFunRouter.TradeParams memory p =
            MemeFunRouter.TradeParams(coin, 20e6, 1, alice, referrer, _now() + 60);
        vm.startPrank(alice);
        usdc.approve(address(router), p.amountIn);
        uint256 received = router.buyFor(p, USDC_ADDRESS);
        assertGt(received, 0);
        IB20(coin).approve(address(router), received);
        p.amountIn = received;
        router.sellFor(p, USDC_ADDRESS);
        vm.stopPrank();
        assertGt(vault.creatorPendingFor(coin, USDC_ADDRESS), 0);
        assertGt(vault.referralPending(referrer, Currency.wrap(USDC_ADDRESS)), 0);
        assertEq(vault.creatorPending(coin), 0, "legacy view only primary ETH market");
        assertEq(vault.creatorPendingFor(coin, STOCK_ADDRESS), 0);
        assertEq(address(router).balance, 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_burnMarketsHaveIndependentFeesAndCooldowns() public {
        (address coin,,) = _multi(Mode.BURN, 3, true);
        _nextBlock();
        uint256 otherPending = vault.destinationPendingFor(coin, STOCK_ADDRESS);
        uint256 deadBefore = IB20(coin).balanceOf(DEAD);
        (, uint256 burnedEth) = burnVault.executeBuyback(coin);
        (, uint256 burnedUsdc) = burnVault.executeBuybackFor(coin, USDC_ADDRESS);
        assertGt(burnedEth, 0);
        assertGt(burnedUsdc, 0);
        assertEq(IB20(coin).balanceOf(DEAD) - deadBefore, burnedEth + burnedUsdc);
        assertEq(vault.destinationPendingFor(coin, STOCK_ADDRESS), otherPending);
        assertEq(burnVault.lastBuybackAtFor(coin, STOCK_ADDRESS), 0);
        assertEq(
            manager.balanceOf(address(burnVault), Currency.wrap(ETH).toId()),
            burnVault.balanceOf(coin)
        );
        assertEq(
            manager.balanceOf(address(burnVault), Currency.wrap(USDC_ADDRESS).toId()),
            burnVault.balanceOfFor(coin, USDC_ADDRESS)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackBurnVault.CoolingDown.selector, _now() + burnVault.COOLDOWN()
            )
        );
        burnVault.executeBuybackFor(coin, USDC_ADDRESS);
    }

    function test_floorMarketsHaveIndependentPermanentBands() public {
        (address coin, PoolId[] memory ids,) = _multi(Mode.FLOOR, 3, true);
        _nextBlock();
        uint256 ethPending = vault.destinationPending(coin);
        (,, uint128 usdcLiquidity, uint256 usdcUsed) = floorVault.addFloorFor(coin, USDC_ADDRESS);
        (,, uint128 stockLiquidity, uint256 stockUsed) = floorVault.addFloorFor(coin, STOCK_ADDRESS);
        assertGt(usdcLiquidity, 0);
        assertGt(stockLiquidity, 0);
        assertGt(usdcUsed, 0);
        assertGt(stockUsed, 0);
        assertEq(vault.destinationPending(coin), ethPending);
        assertFalse(floorVault.hasFloor(coin));
        assertTrue(floorVault.hasFloorFor(coin, USDC_ADDRESS));
        assertTrue(floorVault.hasFloorFor(coin, STOCK_ADDRESS));
        assertEq(
            manager.balanceOf(address(floorVault), Currency.wrap(USDC_ADDRESS).toId()),
            floorVault.balanceOfFor(coin, USDC_ADDRESS)
        );
        assertEq(
            manager.balanceOf(address(floorVault), Currency.wrap(STOCK_ADDRESS).toId()),
            floorVault.balanceOfFor(coin, STOCK_ADDRESS)
        );
        vm.expectRevert(
            abi.encodeWithSelector(FloorVault.CoolingDown.selector, _now() + floorVault.COOLDOWN())
        );
        floorVault.addFloorFor(coin, STOCK_ADDRESS);
        assertEq(uint8(hook.configOfPool(ids[2]).mode), uint8(Mode.FLOOR));
    }

    function test_holderEpochsBindBudgetProofAndBitmapToEachMarket() public {
        (address coin, PoolId[] memory allIds,) = _multi(Mode.HOLDERS, 3, true);
        PoolId[] memory ids = new PoolId[](2);
        uint256[] memory totals = new uint256[](2);
        bytes32[] memory leaves = new bytes32[](2);
        for (uint256 i; i < 2; ++i) {
            ids[i] = allIds[i];
            totals[i] = vault.destinationPendingFor(coin, quotes[i]);
            leaves[i] = holders.leafFor(1, ids[i], 0, alice, totals[i]);
        }
        bytes32 root = leaves[0] < leaves[1]
            ? keccak256(abi.encodePacked(leaves[0], leaves[1]))
            : keccak256(abi.encodePacked(leaves[1], leaves[0]));
        vm.prank(publisher);
        holders.publishEpochFor(1, root, ids, totals);
        assertTrue(holders.epochPoolLeaves(1));
        _skip(12 hours);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaves[1];
        HolderRewardDistributor.PoolClaim memory c =
            HolderRewardDistributor.PoolClaim(1, ids[0], 0, alice, totals[0], proof);
        uint256 before = alice.balance;
        holders.claimFor(c);
        assertEq(alice.balance - before, totals[0]);
        assertTrue(holders.isClaimedFor(1, ids[0], 0));
        assertFalse(
            holders.isClaimedFor(1, ids[1], 0), "same index remains valid in another market"
        );
        c.poolId = ids[1];
        vm.expectRevert(HolderRewardDistributor.InvalidProof.selector);
        holders.claimFor(c);
        proof[0] = leaves[0];
        c.proof = proof;
        c.amount = totals[1];
        uint256 usdcBefore = usdc.balanceOf(alice);
        holders.claimFor(c);
        assertEq(usdc.balanceOf(alice) - usdcBefore, totals[1]);
        assertEq(holders.epochClaimedFor(1, ids[0]), totals[0]);
        assertEq(holders.epochClaimedFor(1, ids[1]), totals[1]);
        assertGt(vault.destinationPendingFor(coin, STOCK_ADDRESS), 0, "unpublished quote unchanged");
        HolderRewardDistributor.Claim memory old =
            HolderRewardDistributor.Claim(1, coin, 0, alice, totals[0], proof);
        vm.expectRevert(HolderRewardDistributor.WrongLeafFormat.selector);
        holders.claim(old);
    }

    function test_holderVetoReturnsOnlyEachMarketsOwnBudget() public {
        (address coin, PoolId[] memory ids,) = _multi(Mode.HOLDERS, 3, true);
        PoolId[] memory reserved = new PoolId[](2);
        uint256[] memory totals = new uint256[](2);
        for (uint256 i; i < 2; ++i) {
            reserved[i] = ids[i];
            totals[i] = vault.destinationPendingFor(coin, quotes[i]);
        }
        vm.prank(publisher);
        holders.publishEpochFor(1, bytes32(uint256(1)), reserved, totals);
        vm.prank(owner);
        holders.vetoEpoch(1);
        vm.recordLogs();
        holders.releaseEpochFor(1, ids);
        holders.releaseEpochFor(1, ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "only reserved markets emit a release once");
        for (uint256 i; i < 2; ++i) {
            assertEq(holders.availableFor(coin, quotes[i]), totals[i]);
            assertTrue(holders.epochReleasedFor(1, ids[i]));
            assertEq(
                manager.balanceOf(address(holders), Currency.wrap(quotes[i]).toId()), totals[i]
            );
        }
        assertFalse(holders.epochReleasedFor(1, ids[2]), "absent market is not marked released");
        assertEq(holders.availableFor(coin, quotes[2]), 0);
        assertGt(
            vault.destinationPendingFor(coin, quotes[2]), 0, "absent market fees stay in vault"
        );
    }
}
