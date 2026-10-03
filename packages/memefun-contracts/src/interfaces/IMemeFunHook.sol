// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {Mode} from "../types/MemeFunTypes.sol";

/// @notice What the factory, vault, router and modules read from MemeFunHook, the coin registry.
interface IMemeFunHook {
    /// @notice Everything about a coin's pool fixed at launch. Packed into two slots.
    /// @dev Only `feeBps` ever changes after launch, and only downward (`lowerFee`).
    struct PoolConfig {
        address coin;
        bool quoteIsCurrency0;
        Mode mode;
        uint16 feeBps;
        uint16 platformShareBps;
        uint16 referralShareBps;
        uint16 creatorKeepBps;
        uint16 protectionStartBps;
        address module;
        uint40 launchedAt;
        uint16 protectionDurationSec;
        bool seeded;
    }

    function registerPool(PoolKey calldata key, PoolConfig calldata config, address creator) external;

    function poolKeyOf(address coin) external view returns (PoolKey memory);

    function poolIdOf(address coin) external view returns (PoolId);

    function configOf(address coin) external view returns (PoolConfig memory);

    function quoteCurrencyOf(address coin) external view returns (Currency);

    function creatorOf(address coin) external view returns (address);

    function moduleOf(address coin) external view returns (address);

    function blockStartSqrtPriceX96(PoolId id) external view returns (uint160);
}
