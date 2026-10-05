// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";
import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

/// @notice Adversarial multi-pair checks: a failed leg or claim must never partially move funds.
contract MultiPairIsolationTest is MemeFunFixture {
    function test_unregisteredPairCannotSpendOrChangeAnotherMarket() public {
        (address coin,) = _launchTwo(Mode.CREATOR);
        uint256 ethBefore = alice.balance;
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 nativePending = vault.creatorPendingFor(coin, ETH);
        uint256 stablePending = vault.creatorPendingFor(coin, USDC_ADDRESS);

        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(MemeFunHook.UnknownPair.selector, coin, STOCK_ADDRESS)
        );
        router.buyFor{value: 1 ether}(_tradeParams(coin, 1 ether), STOCK_ADDRESS);
        vm.stopPrank();

        assertEq(alice.balance, ethBefore);
        assertEq(usdc.balanceOf(alice), usdcBefore);
        assertEq(vault.creatorPendingFor(coin, ETH), nativePending);
        assertEq(vault.creatorPendingFor(coin, USDC_ADDRESS), stablePending);
    }

    function test_failedSecondaryFirstBuyRollsBackTheTokenAndEveryMarket() public {
        MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 500);
        p.firstBuyAmount = 1 ether;
        MemeFunFactory.PairParams[] memory pairs = _pairs(p);
        pairs[1].firstBuyAmount = 100e6;
        address predicted = factory.predictCoin(creator, p.salt);
        uint256 nativeBefore = creator.balance;
        uint256 stableBefore = usdc.balanceOf(creator);
        uint256 treasuryBefore = treasury.balance;
        uint256 countBefore = factory.launchCount();
        uint256 value = config.launchTerms().creationFee + p.firstBuyAmount;

        // The first market is funded, but the creator deliberately gives no secondary allowance.
        vm.prank(creator);
        vm.expectRevert();
        factory.launchMulti{value: value}(p, pairs);

        assertEq(factory.launchCount(), countBefore);
        assertEq(hook.creatorOf(predicted), address(0), "registry creation rolled back");
        assertEq(creator.balance, nativeBefore, "native first buy and creation fee rolled back");
        assertEq(usdc.balanceOf(creator), stableBefore);
        assertEq(treasury.balance, treasuryBefore);
        assertEq(usdc.balanceOf(address(factory)), 0);
        assertEq(address(factory).balance, 0);
    }

    function test_wrongModuleCannotPullEitherPairPot() public {
        (address coin,) = _launchTwo(Mode.CREATOR);
        _skip(15);
        _buyFor(coin, ETH, 1 ether);
        _buyFor(coin, USDC_ADDRESS, 1000e6);
        uint256 nativePending = vault.creatorPendingFor(coin, ETH);
        uint256 stablePending = vault.creatorPendingFor(coin, USDC_ADDRESS);

        vm.expectRevert(abi.encodeWithSelector(FloorVault.NotFloorCoin.selector, coin));
        floorVault.addFloorFor(coin, USDC_ADDRESS);

        assertEq(vault.creatorPendingFor(coin, ETH), nativePending);
        assertEq(vault.creatorPendingFor(coin, USDC_ADDRESS), stablePending);
    }

    function test_invalidSecondPoolClaimRollsBackTheValidFirstClaim() public {
        (address coin, PoolId[] memory ids) = _launchTwo(Mode.HOLDERS);
        _skip(15);
        _buyFor(coin, ETH, 1 ether);
        _buyFor(coin, USDC_ADDRESS, 1000e6);
        uint256 nativePot = vault.destinationPendingFor(coin, ETH);
        uint256 stablePot = vault.destinationPendingFor(coin, USDC_ADDRESS);
        assertGt(nativePot, 0);
        assertGt(stablePot, 0);

        bytes32 nativeLeaf = holders.leafFor(1, ids[0], 0, alice, nativePot);
        bytes32 stableLeaf = holders.leafFor(1, ids[1], 0, alice, stablePot);
        uint256[] memory totals = new uint256[](2);
        totals[0] = nativePot;
        totals[1] = stablePot;
        vm.prank(publisher);
        holders.publishEpochFor(1, Hashes.commutativeKeccak256(nativeLeaf, stableLeaf), ids, totals);
        _skip(12 hours);

        bytes32[] memory nativeProof = new bytes32[](1);
        nativeProof[0] = stableLeaf;
        bytes32[] memory stableProof = new bytes32[](1);
        stableProof[0] = nativeLeaf;
        HolderRewardDistributor.PoolClaim[] memory claims =
            new HolderRewardDistributor.PoolClaim[](2);
        claims[0] = HolderRewardDistributor.PoolClaim(1, ids[0], 0, alice, nativePot, nativeProof);
        // Corrupt only the second amount. Its proof must not consume the first market's budget.
        claims[1] =
            HolderRewardDistributor.PoolClaim(1, ids[1], 0, alice, stablePot + 1, stableProof);
        uint256 nativeBefore = alice.balance;
        uint256 stableBefore = usdc.balanceOf(alice);
        vm.expectRevert(HolderRewardDistributor.InvalidProof.selector);
        holders.claimManyFor(claims);

        assertFalse(holders.isClaimedFor(1, ids[0], 0));
        assertFalse(holders.isClaimedFor(1, ids[1], 0));
        assertEq(holders.epochClaimedFor(1, ids[0]), 0);
        assertEq(holders.epochClaimedFor(1, ids[1]), 0);
        assertEq(alice.balance, nativeBefore);
        assertEq(usdc.balanceOf(alice), stableBefore);

        claims[1].amount = stablePot;
        holders.claimManyFor(claims);
        assertEq(alice.balance - nativeBefore, nativePot);
        assertEq(usdc.balanceOf(alice) - stableBefore, stablePot);
    }

    function _launchTwo(Mode mode) private returns (address coin, PoolId[] memory ids) {
        MemeFunFactory.LaunchParams memory p = _params(ETH, mode, 500);
        MemeFunFactory.PairParams[] memory pairs = _pairs(p);
        uint256 value = config.launchTerms().creationFee;
        vm.prank(creator);
        (coin, ids,) = factory.launchMulti{value: value}(p, pairs);
    }

    function _pairs(MemeFunFactory.LaunchParams memory p)
        private
        view
        returns (MemeFunFactory.PairParams[] memory pairs)
    {
        pairs = new MemeFunFactory.PairParams[](2);
        pairs[0] = MemeFunFactory.PairParams(
            p.quote, p.firstBuyAmount, p.firstBuyMinCoins, p.expectedStartTick, p.maxTickDrift
        );
        pairs[1] = MemeFunFactory.PairParams(
            USDC_ADDRESS, 0, 0, _expectedStartTick(USDC_ADDRESS, p.salt, creator), p.maxTickDrift
        );
    }

    function _tradeParams(
        address coin,
        uint256 amount
    )
        private
        view
        returns (MemeFunRouter.TradeParams memory)
    {
        return MemeFunRouter.TradeParams(coin, amount, 0, address(0), address(0), _now() + 60);
    }

    function _buyFor(address coin, address quote, uint256 amount) private {
        MemeFunRouter.TradeParams memory p = _tradeParams(coin, amount);
        vm.startPrank(alice);
        if (quote == ETH) {
            router.buyFor{value: amount}(p, quote);
        } else {
            usdc.approve(address(router), amount);
            router.buyFor(p, quote);
        }
        vm.stopPrank();
    }
}
