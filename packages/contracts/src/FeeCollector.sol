// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeCollector
/// @notice Collects protocol fees from DustSweepRouter and BurnVault.
///         Owner can withdraw accumulated tokens/ETH to a treasury address.
/// @dev    Receives ERC-20 tokens via direct transfer and ETH via receive().
contract FeeCollector is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────── State ────────────────────────
    address public treasury;

    // ──────────────────────── Events ───────────────────────
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event ETHWithdrawn(address indexed to, uint256 amount);
    event TokensSwept(address[] tokens, address indexed to);

    // ──────────────────────── Errors ───────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error ETHTransferFailed();
    error EmptyArray();

    // ──────────────────────── Constructor ──────────────────
    /// @param _treasury  Initial treasury wallet that receives withdrawals.
    /// @param _owner     Contract owner (typically deployer / multisig).
    constructor(address _treasury, address _owner) Ownable(_owner) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    // ──────────────────────── Receive ETH ──────────────────
    receive() external payable {}

    // ──────────────────────── Owner actions ────────────────

    /// @notice Update the treasury address.
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    /// @notice Withdraw a single ERC-20 token balance to treasury.
    function withdrawToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(treasury, amount);
        emit TokenWithdrawn(token, treasury, amount);
    }

    /// @notice Withdraw all ETH held by this contract to treasury.
    function withdrawETH() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert ZeroAmount();
        (bool success,) = treasury.call{value: balance}("");
        if (!success) revert ETHTransferFailed();
        emit ETHWithdrawn(treasury, balance);
    }

    /// @notice Batch-withdraw full balances of multiple ERC-20 tokens to treasury.
    /// @param tokens Array of token addresses to sweep.
    function sweepToTreasury(address[] calldata tokens) external onlyOwner nonReentrant {
        uint256 length = tokens.length;
        if (length == 0) revert EmptyArray();

        for (uint256 i; i < length;) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                IERC20(token).safeTransfer(treasury, balance);
                emit TokenWithdrawn(token, treasury, balance);
            }
            unchecked {
                ++i;
            }
        }

        emit TokensSwept(tokens, treasury);
    }
}