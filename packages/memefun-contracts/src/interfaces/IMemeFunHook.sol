// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {Mode} from "../types/MemeFunTypes.sol";
import {IFeeVault} from "./IFeeVault.sol";

/// @notice What the factory, vault, router and modules read from MemeFunHook, the coin registry.
interface IMemeFunHook {
    function factory() external view returns (address);

    function feeVault() external view returns (IFeeVault);

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

    function registerPool(
        PoolKey calldata key,
        PoolConfig calldata config,
        address creator
    )
        external;

    function poolKeyOf(address coin) external view returns (PoolKey memory);

    function poolKeyFor(address coin, address quote) external view returns (PoolKey memory);

    function poolKeyOfPool(PoolId id) external view returns (PoolKey memory);

    function poolKeysOf(address coin) external view returns (PoolKey[] memory);

    function poolIdsOf(address coin) external view returns (PoolId[] memory);

    function poolIdOf(address coin) external view returns (PoolId);

    function poolIdFor(address coin, address quote) external view returns (PoolId);

    function configOf(address coin) external view returns (PoolConfig memory);

    function configFor(address coin, address quote) external view returns (PoolConfig memory);

    function configOfPool(PoolId id) external view returns (PoolConfig memory);

    function quoteCurrencyOf(address coin) external view returns (Currency);

    function quoteCurrencyOfPool(PoolId id) external view returns (Currency);

    function creatorOf(address coin) external view returns (address);

    function moduleOf(address coin) external view returns (address);

    function moduleOfPool(PoolId id) external view returns (address);

    function blockStartSqrtPriceX96(PoolId id) external view returns (uint160);
}
