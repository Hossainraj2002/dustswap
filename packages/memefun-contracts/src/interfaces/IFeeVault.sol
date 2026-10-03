// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @notice The hook-facing side of FeeVault.
interface IFeeVault {
    /// @notice Records how a fee the hook just minted to the vault as ERC-6909 claims is owed.
    function credit(
        address coin,
        Currency currency,
        uint256 platform,
        address referrer,
        uint256 referral,
        uint256 creator,
        uint256 destination
    ) external;

    /// @notice Moves a community-mode coin's accrued destination claims to its module.
    function pullDestination(address coin) external returns (uint256 amount);
}
