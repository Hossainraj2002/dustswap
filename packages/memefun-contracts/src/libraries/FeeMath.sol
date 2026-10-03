// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title FeeMath
/// @notice Every fee formula memefun uses, in one place. Each function mirrors
///         apps/memefun/src/core/{fees,antiSnipe}.ts exactly, and test/vectors replays the TS
///         results against it, so the price a user is quoted is the price the hook charges.
///
/// @dev Rounding is always in the protocol's favour on collection (fees round UP) and exact on
///      distribution (shares round down, the last share takes the remainder), so collected fees
///      are never short by a wei and distributed fees always sum to exactly what was collected.
library FeeMath {
    uint256 internal constant BPS = 10_000;

    error FeeRateTooHigh(uint256 feeBps);

    struct Split {
        uint256 platform;
        uint256 referral;
        uint256 creator;
        uint256 destination;
    }

    /// @notice Fee on a GROSS quote amount: `ceil(amount * feeBps / 10_000)`.
    ///         Used when the gross amount is known: an exact-input buy (what the user pays) and an
    ///         exact-input sell (what the pool pays out before the fee).
    function onGross(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        if (feeBps > BPS) revert FeeRateTooHigh(feeBps);
        return FullMath.mulDivRoundingUp(amount, feeBps, BPS);
    }

    /// @notice Fee to add to a NET quote amount so the fee is `feeBps` of net + fee:
    ///         `ceil(net * feeBps / (10_000 - feeBps))`.
    ///         Used when the user fixes the net side: an exact-output sell (quote received) and an
    ///         exact-output buy (quote the pool takes).
    function onNet(uint256 net, uint256 feeBps) internal pure returns (uint256) {
        if (feeBps >= BPS) revert FeeRateTooHigh(feeBps);
        return FullMath.mulDivRoundingUp(net, feeBps, BPS - feeBps);
    }

    /// @notice Fee rate `elapsedSec` after launch: starts at `startBps` and decays linearly to
    ///         `baseBps` over `durationSec`, rounded down. Never below the base rate.
    function launchFeeBps(uint256 baseBps, uint256 startBps, uint256 durationSec, uint256 elapsedSec)
        internal
        pure
        returns (uint256)
    {
        if (durationSec == 0 || startBps <= baseBps || elapsedSec >= durationSec) return baseBps;
        return baseBps + (startBps - baseBps) * (durationSec - elapsedSec) / durationSec;
    }

    /// @notice Splits a collected fee exactly.
    /// @param creatorMode True when the coin's destination is the creator (everything outside the
    ///                    platform share goes to the creator and `creatorKeepBps` is ignored).
    /// @param platformShareBps Platform share of the fee.
    /// @param referralShareBps Referral share of the platform share, paid only with a referrer.
    /// @param creatorKeepBps In community modes, the creator's share of what is left.
    function split(
        uint256 fee,
        bool creatorMode,
        uint256 platformShareBps,
        uint256 referralShareBps,
        uint256 creatorKeepBps,
        bool hasReferrer
    ) internal pure returns (Split memory s) {
        uint256 platformGross = fee * platformShareBps / BPS;
        if (hasReferrer) s.referral = platformGross * referralShareBps / BPS;
        s.platform = platformGross - s.referral;
        uint256 rest = fee - platformGross;
        if (creatorMode) {
            s.creator = rest;
        } else {
            s.creator = rest * creatorKeepBps / BPS;
            s.destination = rest - s.creator;
        }
    }
}
