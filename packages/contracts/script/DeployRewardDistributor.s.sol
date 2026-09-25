// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DustSwapRewardDistributor} from "../src/DustSwapRewardDistributor.sol";

/// @title Deploy DustSwapRewardDistributor
/// @dev Deploys the close-out distributor, then prints the funding steps. Funding is deliberately
///      NOT part of this script: the deployer key does not need to hold the distribution budget,
///      and moving 20k USDC should be a separate, deliberate transaction from a treasury wallet.
///
///      Required environment:
///        DEPLOYER_PRIVATE_KEY      Key that pays for the deployment.
///        CLAIM_TOKEN_ADDRESS       Base USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///        CLAIM_MERKLE_ROOT         `root` from buildClaimAllocation.ts
///        CLAIM_TOTAL_ALLOCATION    `totalAllocation` from buildClaimAllocation.ts, base units
///        CLAIM_DEADLINE            Unix timestamp of the last claimable second
///        CLAIM_OWNER               Owner address. Use a multisig: after the deadline this
///                                  address can sweep whatever is left.
///
///      Usage:
///        forge script script/DeployRewardDistributor.s.sol:DeployRewardDistributor \
///          --rpc-url base_mainnet --broadcast --verify -vvvv
contract DeployRewardDistributor is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address token = vm.envAddress("CLAIM_TOKEN_ADDRESS");
        bytes32 root = vm.envBytes32("CLAIM_MERKLE_ROOT");
        uint256 totalAllocation = vm.envUint("CLAIM_TOTAL_ALLOCATION");
        uint64 deadline = uint64(vm.envUint("CLAIM_DEADLINE"));
        address owner = vm.envAddress("CLAIM_OWNER");

        require(deadline > block.timestamp, "CLAIM_DEADLINE is not in the future");
        require(owner != address(0), "CLAIM_OWNER is unset");
        require(root != bytes32(0), "CLAIM_MERKLE_ROOT is unset");
        require(totalAllocation > 0, "CLAIM_TOTAL_ALLOCATION is zero");

        console2.log("===========================================");
        console2.log("  DustSwap Reward Distributor");
        console2.log("===========================================");
        console2.log("Deployer:         ", deployer);
        console2.log("Owner:            ", owner);
        console2.log("Token:            ", token);
        console2.log("Total allocation: ", totalAllocation);
        console2.log("Deadline (unix):  ", deadline);
        console2.log("Days from now:    ", (deadline - block.timestamp) / 1 days);
        console2.log("-------------------------------------------");

        vm.startBroadcast(deployerKey);
        DustSwapRewardDistributor distributor =
            new DustSwapRewardDistributor(token, root, totalAllocation, deadline, owner);
        vm.stopBroadcast();

        console2.log("Distributor:      ", address(distributor));
        console2.log("-------------------------------------------");
        console2.log("Next steps:");
        console2.log("  1. Verify the contract on Basescan.");
        console2.log("  2. Transfer the distribution token to the address above.");
        console2.log("  3. Confirm isFullyFunded() returns true BEFORE announcing.");
        console2.log("  4. Publish allocation.csv and the build script so the root is checkable.");
        console2.log("  5. Point NEXT_PUBLIC_CLAIM_DISTRIBUTOR_ADDRESS at it and deploy the page.");
        console2.log("===========================================");
    }
}
