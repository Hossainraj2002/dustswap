// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {DustSweepPermit2RouterV2} from "../src/DustSweepPermit2RouterV2.sol";

/// @title DustSweep V2 Configure Script - Base Mainnet
/// @dev Usage:
///      forge script script/ConfigureDustSweepPermit2RouterV2.s.sol:ConfigureDustSweepPermit2RouterV2 \
///        --rpc-url base_mainnet \
///        --broadcast \
///        -vvvv
contract ConfigureDustSweepPermit2RouterV2 is Script {
    function run() external {
        uint256 ownerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(ownerPrivateKey);
        DustSweepPermit2RouterV2 router =
            DustSweepPermit2RouterV2(payable(vm.envAddress("DUST_SWEEP_ROUTER_V2_ADDRESS")));

        address permit2 = vm.envAddress("PERMIT2_ADDRESS");
        address uniswapV3 = vm.envAddress("UNISWAP_V3_SWAP_ROUTER_ADDRESS");
        address pancakeV3 = vm.envAddress("PANCAKE_V3_SWAP_ROUTER_ADDRESS");
        address aerodrome = vm.envAddress("AERODROME_ROUTER_ADDRESS");
        address baseswap = vm.envAddress("BASESWAP_ROUTER_ADDRESS");
        address uniswapUniversal = vm.envAddress("UNISWAP_UNIVERSAL_ROUTER_ADDRESS");

        console2.log("===========================================");
        console2.log("  DustSweep Permit2 Router V2 Configure");
        console2.log("===========================================");
        console2.log("Owner:             ", owner);
        console2.log("DustSweepRouterV2: ", address(router));
        console2.log("-------------------------------------------");

        vm.startBroadcast(ownerPrivateKey);

        _allowTargetAndSpender(router, uniswapV3);
        _allowTargetAndSpender(router, pancakeV3);
        _allowTargetAndSpender(router, aerodrome);
        _allowTargetAndSpender(router, baseswap);
        router.setAllowedTarget(uniswapUniversal, true);
        router.setAllowedSpender(permit2, true);

        vm.stopBroadcast();

        console2.log("Allowed targets:   UniswapV3, PancakeV3, Aerodrome, BaseSwap, UniversalRouter");
        console2.log("Allowed spenders:  UniswapV3, PancakeV3, Aerodrome, BaseSwap, Permit2");
    }

    function _allowTargetAndSpender(DustSweepPermit2RouterV2 router, address target) internal {
        router.setAllowedTarget(target, true);
        router.setAllowedSpender(target, true);
    }
}
