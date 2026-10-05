// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";
import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

/// @notice Oversized unsigned inputs must never become positive exact-output swaps.
contract InputBoundsTest is MemeFunFixture {
    function test_routerRejectsOversizedBuyAndSellWithoutMovingFunds() public {
        address coin = _launchSimple(USDC_ADDRESS, Mode.CREATOR, 100);
        uint256[2] memory oversized = [type(uint256).max, uint256(type(int256).max) + 1];
        uint256 balanceBefore = usdc.balanceOf(alice);
        vm.startPrank(alice);
        usdc.approve(address(router), type(uint256).max);
        IB20(coin).approve(address(router), type(uint256).max);
        for (uint256 i; i < oversized.length; ++i) {
            MemeFunRouter.TradeParams memory p =
                MemeFunRouter.TradeParams(coin, oversized[i], 0, alice, address(0), _now() + 60);
            vm.expectRevert(
                abi.encodeWithSelector(MemeFunRouter.AmountTooLarge.selector, oversized[i])
            );
            router.buyFor(p, USDC_ADDRESS);
            vm.expectRevert(
                abi.encodeWithSelector(MemeFunRouter.AmountTooLarge.selector, oversized[i])
            );
            router.sellFor(p, USDC_ADDRESS);
        }
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), balanceBefore);
        assertEq(IB20(coin).balanceOf(alice), 0);
        assertEq(vault.creatorPendingFor(coin, USDC_ADDRESS), 0);
    }

    function test_singleLaunchRejectsOversizedFirstBuyBeforeCreatingCoin() public {
        uint256[2] memory oversized = [type(uint256).max, uint256(type(int256).max) + 1];
        uint256 balanceBefore = usdc.balanceOf(creator);
        for (uint256 i; i < oversized.length; ++i) {
            MemeFunFactory.LaunchParams memory p = _params(USDC_ADDRESS, Mode.CREATOR, 100);
            p.firstBuyAmount = oversized[i];
            address predicted = factory.predictCoin(creator, p.salt);
            vm.startPrank(creator);
            usdc.approve(address(factory), type(uint256).max);
            vm.expectRevert(
                abi.encodeWithSelector(MemeFunFactory.AmountTooLarge.selector, oversized[i])
            );
            factory.launch(p);
            vm.stopPrank();
            assertEq(hook.creatorOf(predicted), address(0));
        }
        assertEq(factory.launchCount(), 0);
        assertEq(usdc.balanceOf(creator), balanceBefore);
    }

    function test_multiLaunchRejectsOversizedSecondaryFirstBuyAtomically() public {
        uint256[2] memory oversized = [type(uint256).max, uint256(type(int256).max) + 1];
        for (uint256 i; i < oversized.length; ++i) {
            MemeFunFactory.LaunchParams memory p = _params(ETH, Mode.CREATOR, 100);
            MemeFunFactory.PairParams[] memory pairs = new MemeFunFactory.PairParams[](2);
            pairs[0] = MemeFunFactory.PairParams(p.quote, 0, 0, p.expectedStartTick, p.maxTickDrift);
            pairs[1] = MemeFunFactory.PairParams(
                USDC_ADDRESS,
                oversized[i],
                0,
                _expectedStartTick(USDC_ADDRESS, p.salt, creator),
                p.maxTickDrift
            );
            address predicted = factory.predictCoin(creator, p.salt);
            vm.prank(creator);
            vm.expectRevert(
                abi.encodeWithSelector(MemeFunFactory.AmountTooLarge.selector, oversized[i])
            );
            factory.launchMulti(p, pairs);
            assertEq(hook.creatorOf(predicted), address(0));
            assertEq(factory.launchCount(), 0);
        }
    }
}
