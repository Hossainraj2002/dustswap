// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IWETH — Wrapped Ether interface used on Base (address 0x4200…0006)
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}