// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Plain ERC-20 with ERC-2612 permit and configurable decimals, standing in for USDC and
///         a tokenized stock in unit tests (fork tests use the real ones).
contract TestToken is ERC20, ERC20Permit {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) ERC20Permit(name_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Chainlink-shaped feed whose answer and timestamp tests control.
contract MockAggregator is IAggregatorV3 {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Any contract address, for tests that only need "a module with code".
contract StubModule {}
