// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Local-chain stand-in for Chainlink's ETH/USD feed, deployed only by DevDeploy.
/// @dev It always reports the current block time as its update time, so a dev chain that
///      fast-forwards hours or days (holder epochs, cooldowns) never sees a stale ETH price.
///      Staleness itself is covered by the unit tests' MockAggregator.
contract DevPriceFeed is IAggregatorV3 {
    uint8 public immutable decimals;
    address public immutable owner;
    int256 public answer;
    uint80 public roundId;

    error NotOwner();

    constructor(int256 answer_) {
        decimals = 8;
        owner = msg.sender;
        answer = answer_;
        roundId = 1;
    }

    function set(int256 answer_) external {
        if (msg.sender != owner) revert NotOwner();
        answer = answer_;
        ++roundId;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, block.timestamp, block.timestamp, roundId);
    }
}
