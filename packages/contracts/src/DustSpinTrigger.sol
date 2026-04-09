// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DustSpinTrigger {
    mapping(address => uint256) public spinCount;

    event SpinTriggered(address indexed player, uint256 indexed playerNonce);

    function spin() external {
        uint256 nextNonce = spinCount[msg.sender] + 1;
        spinCount[msg.sender] = nextNonce;

        emit SpinTriggered(msg.sender, nextNonce);
    }
}
