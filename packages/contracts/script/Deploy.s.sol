// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {BurnVault} from "../src/BurnVault.sol";
import {DustSweepRouter} from "../src/DustSweepRouter.sol";

/// @title DustSwap Deployment Script — Base Mainnet
/// @dev   Usage:
///        forge script script/Deploy.s.sol:DeployDustSwap \
///          --rpc-url base_mainnet \
///          --broadcast \
///          --verify \
///          -vvvv
contract DeployDustSwap is Script {
    // ── Base Mainnet addresses ──
    address constant UNISWAP_SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        // Read deployer private key and treasury from environment
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("===========================================");
        console2.log("  DustSwap — Base Mainnet Deployment");
        console2.log("===========================================");
        console2.log("Deployer:          ", deployer);
        console2.log("Treasury:          ", treasury);
        console2.log("Uniswap Router:    ", UNISWAP_SWAP_ROUTER_02);
        console2.log("WETH:              ", WETH);
        console2.log("-------------------------------------------");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy FeeCollector
        FeeCollector feeCollector = new FeeCollector(treasury, deployer);
        console2.log("FeeCollector:      ", address(feeCollector));

        // 2. Deploy BurnVault
        BurnVault burnVault = new BurnVault(address(feeCollector), deployer);
        console2.log("BurnVault:         ", address(burnVault));

        // 3. Deploy DustSweepRouter
        DustSweepRouter router = new DustSweepRouter(
            UNISWAP_SWAP_ROUTER_02,
            WETH,
            address(feeCollector),
            deployer
        );
        console2.log("DustSweepRouter:   ", address(router));

        vm.stopBroadcast();

        console2.log("-------------------------------------------");
        console2.log("  Deployment complete!");
        console2.log("===========================================");
    }
}