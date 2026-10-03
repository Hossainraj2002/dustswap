// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";

/// @notice TESTNET ONLY. Hands out a clearly labelled test stock so anyone can try memefun's stock
///         pairs on Base Sepolia, where no real tokenized stocks exist. It holds MINT_ROLE on the
///         test stock (granted when the stock is created) and mints a fixed amount to each address
///         at most once a day. Never deployed on mainnet; not part of the audited contracts.
contract TestStockFaucet {
    uint256 public constant COOLDOWN = 1 days;

    IB20 public immutable stock;
    uint256 public immutable amount;

    mapping(address account => uint256) public lastDrip;

    event Dripped(address indexed to, uint256 amount);

    error TooSoon(uint256 nextAt);

    constructor(IB20 stock_, uint256 amount_) {
        stock = stock_;
        amount = amount_;
    }

    /// @notice Sends `amount` test shares to the caller, once per address per day.
    function drip() external {
        uint256 last = lastDrip[msg.sender];
        if (last != 0 && block.timestamp < last + COOLDOWN) revert TooSoon(last + COOLDOWN);
        lastDrip[msg.sender] = block.timestamp;
        stock.mint(msg.sender, amount);
        emit Dripped(msg.sender, amount);
    }

    /// @notice When the caller may drip again (0 means now).
    function nextDripAt(address account) external view returns (uint256) {
        uint256 last = lastDrip[account];
        if (last == 0 || block.timestamp >= last + COOLDOWN) return 0;
        return last + COOLDOWN;
    }
}
