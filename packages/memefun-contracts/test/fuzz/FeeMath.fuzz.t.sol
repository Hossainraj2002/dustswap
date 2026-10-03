// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {FeeMath} from "../../src/libraries/FeeMath.sol";

/// @dev External wrapper so reverts can be asserted with vm.expectRevert.
contract FeeMathHarness {
    function onNet(uint256 net, uint256 feeBps) external pure returns (uint256) {
        return FeeMath.onNet(net, feeBps);
    }

    function onGross(uint256 amount, uint256 feeBps) external pure returns (uint256) {
        return FeeMath.onGross(amount, feeBps);
    }
}

/// @notice Properties of every fee formula, for all inputs rather than chosen examples.
contract FeeMathFuzzTest is Test {
    FeeMathHarness internal harness = new FeeMathHarness();

    /// Fee on a gross amount: never more than the amount, never short, and minimal.
    function testFuzz_onGross_roundsUpMinimally(uint128 amount, uint16 rawBps) public pure {
        uint256 bps = bound(rawBps, 0, FeeMath.BPS);
        uint256 fee = FeeMath.onGross(amount, bps);
        assertLe(fee, amount, "fee never exceeds the amount");
        assertGe(fee * FeeMath.BPS, uint256(amount) * bps, "never under-collects");
        if (fee > 0) assertLt((fee - 1) * FeeMath.BPS, uint256(amount) * bps, "rounds up by less than one wei");
    }

    /// Fee on a net amount: is the rate of net + fee, never short, and minimal.
    function testFuzz_onNet_grossesUpMinimally(uint128 net, uint16 rawBps) public pure {
        uint256 bps = bound(rawBps, 0, FeeMath.BPS - 1);
        uint256 fee = FeeMath.onNet(net, bps);
        assertGe(fee * FeeMath.BPS, (uint256(net) + fee) * bps, "never under-collects");
        if (fee > 0) assertLt((fee - 1) * FeeMath.BPS, (uint256(net) + fee - 1) * bps, "minimal");
    }

    /// The two formulas agree: charging onNet(net) on top of net gives a trade whose gross fee,
    /// computed with onGross, is within one wei of the same fee.
    function testFuzz_netAndGrossAgree(uint128 net, uint16 rawBps) public pure {
        uint256 bps = bound(rawBps, 0, 9_900);
        uint256 fee = FeeMath.onNet(net, bps);
        uint256 grossFee = FeeMath.onGross(uint256(net) + fee, bps);
        assertLe(grossFee, fee, "onGross(net + fee) <= fee");
        assertGe(grossFee + 1, fee, "and at most one wei apart");
    }

    function testFuzz_rejectsRatesThatCannotBeCharged(uint256 rawBps) public {
        uint256 grossBps = bound(rawBps, FeeMath.BPS + 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeRateTooHigh.selector, grossBps));
        harness.onGross(1, grossBps);

        uint256 netBps = bound(rawBps, FeeMath.BPS, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeRateTooHigh.selector, netBps));
        harness.onNet(1, netBps);
    }

    /// Distribution is exact: the four shares always sum to the fee, in every mode.
    function testFuzz_split_conservesEveryWei(
        uint128 fee,
        bool creatorMode,
        uint16 platform,
        uint16 referral,
        uint16 keep,
        bool hasReferrer
    ) public pure {
        uint256 platformBps = bound(platform, 0, 5_000);
        uint256 referralBps = bound(referral, 0, 5_000);
        uint256 keepBps = bound(keep, 0, 5_000);
        FeeMath.Split memory s = FeeMath.split(fee, creatorMode, platformBps, referralBps, keepBps, hasReferrer);
        assertEq(s.platform + s.referral + s.creator + s.destination, fee, "conservation");
        if (!hasReferrer) assertEq(s.referral, 0, "no referrer, no referral");
        if (creatorMode) assertEq(s.destination, 0, "creator mode has no destination");
        assertLe(s.referral, s.platform + s.referral, "referral comes out of the platform share");
    }

    /// Launch protection: starts at the start rate, never below the base, never rises over time,
    /// and reaches the base exactly at the end of the window.
    function testFuzz_launchFeeBps_decaysMonotonically(uint16 base, uint16 start, uint16 duration, uint16 t1, uint16 t2)
        public
        pure
    {
        uint256 baseBps = bound(base, 0, 1_000);
        uint256 startBps = bound(start, 0, 9_900);
        uint256 dur = bound(duration, 0, 300);
        uint256 a = bound(t1, 0, 400);
        uint256 b = bound(t2, a, 400);

        uint256 rateA = FeeMath.launchFeeBps(baseBps, startBps, dur, a);
        uint256 rateB = FeeMath.launchFeeBps(baseBps, startBps, dur, b);
        assertGe(rateA, baseBps, "never below base");
        assertLe(rateA, startBps > baseBps ? startBps : baseBps, "never above start");
        assertGe(rateA, rateB, "never rises over time");
        assertEq(FeeMath.launchFeeBps(baseBps, startBps, dur, dur), baseBps, "base exactly at the end");
        if (dur > 0 && startBps > baseBps) assertEq(FeeMath.launchFeeBps(baseBps, startBps, dur, 0), startBps, "start at 0");
    }
}
