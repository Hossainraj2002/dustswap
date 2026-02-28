// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FeeCollector}    from "../src/FeeCollector.sol";
import {BurnVault}       from "../src/BurnVault.sol";
import {DustSweepRouter} from "../src/DustSweepRouter.sol";

/// @notice Deploy script for Base Sepolia testnet (and Base mainnet later)
/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --broadcast --verify -vvv
contract Deploy is Script {
    // Uniswap Universal Router addresses
    address constant UNIV3_BASE_SEPOLIA = 0xd4a1D777e2882487d47c96bc23A47CeaB4f4f18A;
    address constant UNIV3_BASE_MAINNET = 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD;

    function run() external {
        uint256 pk       = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 chainId  = block.chainid;

        console.log("Chain ID :", chainId);
        console.log("Deployer :", deployer);

        address uniRouter = (chainId == 8453)
            ? UNIV3_BASE_MAINNET
            : UNIV3_BASE_SEPOLIA;

        vm.startBroadcast(pk);

        // 1. FeeCollector — treasury = deployer until multi-sig is ready
        FeeCollector feeCollector = new FeeCollector(deployer);
        console.log("FeeCollector  :", address(feeCollector));

        // 2. BurnVault
        BurnVault burnVault = new BurnVault();
        console.log("BurnVault     :", address(burnVault));

        // 3. DustSweepRouter
        DustSweepRouter router = new DustSweepRouter(uniRouter, address(feeCollector));
        console.log("DustSweepRouter:", address(router));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Copy these addresses into apps/web/.env.local ===");
        console.log("NEXT_PUBLIC_ROUTER_ADDRESS=", address(router));
        console.log("NEXT_PUBLIC_BURN_VAULT_ADDRESS=", address(burnVault));
        console.log("NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS=", address(feeCollector));
    }
}
