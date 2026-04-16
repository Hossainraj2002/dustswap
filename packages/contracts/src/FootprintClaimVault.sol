// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title FootprintClaimVault
/// @notice Simple treasury vault for DustSwap claim verification payments.
/// @dev Accepts ETH transfers with calldata, which is important when builder-code
///      attribution appends DATA_SUFFIX to the transaction input.
contract FootprintClaimVault {
    address public owner;
    address public treasury;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event EthReceived(address indexed from, uint256 amount, bytes data);
    event EthWithdrawn(address indexed to, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    error EthTransferFailed();
    error NotOwner();
    error TransferFailed();
    error ZeroAddress();
    error InvalidAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialTreasury) {
        if (initialTreasury == address(0)) revert ZeroAddress();

        owner = msg.sender;
        treasury = initialTreasury;

        emit OwnershipTransferred(address(0), owner);
        emit TreasuryUpdated(address(0), initialTreasury);
    }

    receive() external payable {
        emit EthReceived(msg.sender, msg.value, "");
    }

    fallback() external payable {
        emit EthReceived(msg.sender, msg.value, msg.data);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();

        address previousTreasury = treasury;
        treasury = newTreasury;

        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function withdrawEth(uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        uint256 amountToSend = amount == 0 ? balance : amount;

        if (amountToSend == 0 || amountToSend > balance) revert InvalidAmount();

        (bool success,) = treasury.call{value: amountToSend}("");
        if (!success) revert EthTransferFailed();

        emit EthWithdrawn(treasury, amountToSend);
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();

        IERC20Minimal asset = IERC20Minimal(token);
        uint256 balance = asset.balanceOf(address(this));
        uint256 amountToSend = amount == 0 ? balance : amount;

        if (amountToSend == 0 || amountToSend > balance) revert InvalidAmount();
        if (!asset.transfer(treasury, amountToSend)) revert TransferFailed();

        emit TokenWithdrawn(token, treasury, amountToSend);
    }
}
