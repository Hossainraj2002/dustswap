// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemeFunLaunchRewards} from "../src/MemeFunLaunchRewards.sol";

/// @notice Simulation only. No signing key, broadcast, funding, activation, or manifest writes.
/// @dev forge script script/DeployLaunchRewardsDryRun.s.sol --fork-url <Base RPC> --offline
///      Required public env: MEMEFUN_LAUNCH_REWARD_OWNER/TOKEN/TOKEN_DECIMALS/AMOUNT_RAW/SIGNER/FACTORY.
///      The returned simulated address must never be used as a deployed campaign address.
contract DeployLaunchRewardsDryRun is Script {
    function run() external returns (MemeFunLaunchRewards campaign) {
        _checkRunSafety(block.chainid, vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        uint256 decimals = vm.envUint("MEMEFUN_LAUNCH_REWARD_TOKEN_DECIMALS");
        require(decimals <= type(uint8).max, "invalid token decimals");
        campaign = new MemeFunLaunchRewards(
            vm.envAddress("MEMEFUN_LAUNCH_REWARD_OWNER"),
            IERC20(vm.envAddress("MEMEFUN_LAUNCH_REWARD_TOKEN")),
            uint8(decimals),
            vm.envUint("MEMEFUN_LAUNCH_REWARD_AMOUNT_RAW"),
            vm.envAddress("MEMEFUN_LAUNCH_REWARD_SIGNER"),
            vm.envAddress("MEMEFUN_LAUNCH_REWARD_FACTORY")
        );
        console2.log("SIMULATED ONLY; no contract deployed or tokens transferred");
        console2.log("Required raw funding", campaign.totalAllocation());
        console2.log("Reward raw amount", campaign.rewardAmountRaw());
        require(!campaign.activated(), "dry run activated unexpectedly");
    }

    function _checkRunSafety(uint256 chainId, bool broadcasting) internal pure {
        require(!broadcasting, "LaunchRewards dry run cannot broadcast");
        require(chainId == 8453 || chainId == 84_532 || chainId == 31_337, "unsupported chain");
    }
}
