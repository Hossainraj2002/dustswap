// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployAttributed} from "../../script/DeployAttributed.s.sol";
import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {Mode, QuoteKind} from "../../src/types/MemeFunTypes.sol";
import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

/// @dev Behavioral equivalent of the canonical CREATE2 deployer's salt+initcode fallback.
contract TestCreate2Deployer {
    fallback() external payable {
        assembly {
            let length := sub(calldatasize(), 32)
            calldatacopy(0, 32, length)
            let deployed := create2(0, 0, length, calldataload(0))
            if iszero(deployed) { revert(0, 0) }
            mstore(0, deployed)
            return(12, 20)
        }
    }
}

contract AttributedDeploymentHarness is DeployAttributed {
    function initCode(
        bytes memory creationCode,
        bytes memory args
    )
        external
        pure
        returns (bytes memory)
    {
        return _attributedInitCode(creationCode, args);
    }

    function deployAndConfigure(
        address deployer,
        address treasury,
        ChainAddresses memory c
    )
        external
        returns (Deployed memory d)
    {
        d = _deploy(deployer, treasury, c);
        _configure(d, c, deployer, deployer, deployer, deployer, deployer);
    }
}

contract AttributedDeploymentTest is MemeFunFixture {
    bytes private constant SUFFIX = hex"62635f74706f6c666a686f0b0080218021802180218021802180218021";
    address private constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function test_attributedCreation_preservesStaticConstructorArguments() public {
        AttributedDeploymentHarness script = new AttributedDeploymentHarness();
        bytes memory code =
            script.initCode(type(MemeFunConfig).creationCode, abi.encode(owner, treasury));
        assertEq(
            code,
            bytes.concat(type(MemeFunConfig).creationCode, abi.encode(owner, treasury), SUFFIX)
        );
        address at;
        assembly ("memory-safe") { at := create(0, add(code, 0x20), mload(code)) }
        assertTrue(at != address(0));
        MemeFunConfig deployed = MemeFunConfig(at);
        assertEq(deployed.owner(), owner);
        assertEq(deployed.treasury(), treasury);
        assertEq(deployed.openingFdvUsdE8(), 5000e8);
        assertTrue(deployed.kindEnabled(QuoteKind.NATIVE));
        assertFalse(deployed.kindEnabled(QuoteKind.TOKEN));
    }

    function test_attributedDeployment_preservesNonceAddressesFlagsWiringAndConfig() public {
        AttributedDeploymentHarness script = new AttributedDeploymentHarness();
        vm.etch(CREATE2_DEPLOYER, type(TestCreate2Deployer).runtimeCode);
        address deployer = makeAddr("attributedDeployer");
        vm.deal(deployer, 10 ether);
        uint64 nonce = vm.getNonce(deployer);
        Deploy.ChainAddresses memory chain =
            Deploy.ChainAddresses(manager, address(ethUsd), USDC_ADDRESS);
        Deploy.Deployed memory d = script.deployAndConfigure(deployer, treasury, chain);

        assertEq(address(d.config), vm.computeCreateAddress(deployer, nonce));
        assertEq(address(d.vault), vm.computeCreateAddress(deployer, nonce + 1));
        assertEq(address(d.factory), vm.computeCreateAddress(deployer, nonce + 2));
        assertEq(address(d.router), vm.computeCreateAddress(deployer, nonce + 3));
        bytes memory init = script.initCode(
            type(MemeFunHook).creationCode, abi.encode(manager, d.factory, d.vault, d.router)
        );
        assertEq(
            address(d.hook), vm.computeCreate2Address(d.hookSalt, keccak256(init), CREATE2_DEPLOYER)
        );
        assertEq(uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK, HOOK_FLAGS);
        assertEq(d.config.owner(), deployer);
        assertEq(d.config.pendingOwner(), address(0));
        assertEq(d.config.treasury(), treasury);
        assertEq(d.config.priceKeeper(), deployer);
        assertEq(d.config.rewardsPublisher(), deployer);
        assertEq(d.config.tweetAttestor(), deployer);
        assertEq(address(d.factory.poolManager()), address(manager));
        assertEq(address(d.factory.hook()), address(d.hook));
        assertEq(address(d.factory.config()), address(d.config));
        assertEq(address(d.vault.hook()), address(d.hook));
        assertEq(address(d.vault.config()), address(d.config));
        assertEq(address(d.router.hook()), address(d.hook));
        assertEq(d.hook.factory(), address(d.factory));
        assertEq(d.hook.router(), address(d.router));
        assertEq(address(d.hook.feeVault()), address(d.vault));
        assertTrue(d.config.isLaunchableQuote(address(0)));
        assertTrue(d.config.isLaunchableQuote(USDC_ADDRESS));
        assertFalse(d.config.kindEnabled(QuoteKind.STOCK));
        assertFalse(d.config.kindEnabled(QuoteKind.TOKEN));
        assertEq(d.config.quotes().length, 2);
        assertTrue(d.config.modeInfo(Mode.BURN).enabled);
        assertEq(d.config.modeInfo(Mode.BURN).module, address(d.burnVault));
        assertEq(d.config.modeInfo(Mode.HOLDERS).module, address(d.holders));
        assertEq(d.config.modeInfo(Mode.FLOOR).module, address(d.floorVault));
    }
}
