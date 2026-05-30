// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DustSwapAggregatorRouter} from "../src/DustSwapAggregatorRouter.sol";

/// @title DustSwap Aggregator Router deployment
/// @dev Usage:
///      forge script script/DeployDustSwapAggregatorRouter.s.sol:DeployDustSwapAggregatorRouter \
///        --rpc-url <network> --broadcast --verify -vvvv
contract DeployDustSwapAggregatorRouter is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address permit2 = vm.envAddress("PERMIT2_ADDRESS");
        address feeCollector = vm.envAddress("DUSTSWAP_AGGREGATOR_FEE_COLLECTOR");
        uint16 feeBps = uint16(vm.envOr("DUSTSWAP_AGGREGATOR_FEE_BPS", uint256(25)));
        address[] memory allowedTargets = vm.envAddress("DUSTSWAP_AGGREGATOR_ALLOWED_TARGETS", ",");
        address[] memory allowedSpenders = vm.envAddress("DUSTSWAP_AGGREGATOR_ALLOWED_SPENDERS", ",");

        console2.log("===========================================");
        console2.log("  DustSwap Aggregator Router Deployment");
        console2.log("===========================================");
        console2.log("Contract name:     DustSwapAggregatorRouter");
        console2.log("Aggregator name:   DustSwap");
        console2.log("Logo URI:          logo.png");
        console2.log("Deployer/Owner:    ", deployer);
        console2.log("Permit2:           ", permit2);
        console2.log("Fee Collector:     ", feeCollector);
        console2.log("Fee Bps:           ", feeBps);
        console2.log("Allowed targets:   ", allowedTargets.length);
        console2.log("Allowed spenders:  ", allowedSpenders.length);

        vm.startBroadcast(deployerPrivateKey);

        DustSwapAggregatorRouter router =
            new DustSwapAggregatorRouter(permit2, deployer, feeCollector, feeBps);

        for (uint256 i; i < allowedTargets.length; i++) {
            router.setAllowedTarget(allowedTargets[i], true);
        }

        for (uint256 i; i < allowedSpenders.length; i++) {
            router.setAllowedSpender(allowedSpenders[i], true);
        }

        vm.stopBroadcast();

        console2.log("DustSwapAggregatorRouter: ", address(router));
        console2.log("Verify source and submit explorer label/logo metadata after broadcast.");
    }
}
