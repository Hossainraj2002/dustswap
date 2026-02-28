// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title FeeCollector — Accumulates protocol fees from DustSweepRouter
/// @notice Only the owner can withdraw to the treasury address
contract FeeCollector is Ownable {
    using SafeERC20 for IERC20;

    address public treasury;

    event FeesWithdrawn(address indexed token, uint256 amount, address indexed to);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    constructor(address _treasury) Ownable(msg.sender) {
        require(_treasury != address(0), "FeeCollector: zero treasury");
        treasury = _treasury;
    }

    /// @notice Withdraw ERC-20 fees to treasury
    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(treasury, amount);
        emit FeesWithdrawn(token, amount, treasury);
    }

    /// @notice Withdraw accumulated native ETH fees to treasury
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "FeeCollector: no ETH");
        (bool ok,) = payable(treasury).call{value: balance}("");
        require(ok, "FeeCollector: ETH transfer failed");
        emit FeesWithdrawn(address(0), balance, treasury);
    }

    /// @notice Update treasury address
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "FeeCollector: zero address");
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    receive() external payable {}
}
