// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Compiles the v4 PoolManager once, under the `v4core` compiler profile from foundry.toml.
// Tests deploy it from this artifact with `deployCode`, so no test file embeds its creation code
// (doing that recompiles PoolManager under via-IR for every edited test, about a minute each).
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
