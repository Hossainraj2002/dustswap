// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemeFunLaunchRewards} from "../src/MemeFunLaunchRewards.sol";

/// @notice Future-use deployment helper. Running forge script without --broadcast only simulates.
/// @dev Uses a public deployer address and the CLI's keystore; never reads a private key.
///      Required public env: MEMEFUN_LAUNCH_REWARD_DEPLOYER/OWNER/TOKEN/TOKEN_DECIMALS/
///      AMOUNT_RAW/SIGNER/FACTORY. Broadcast also requires DEPLOY_CONFIRMED=true.
///      No manifest writes, token funding, activation, or modification of existing contracts.
contract DeployLaunchRewards is Script {
    /// ERC-8021 suffix for bc_tpolfjho, identical to DeployAttributed.
    bytes internal constant BUILDER_SUFFIX =
        hex"62635f74706f6c666a686f0b0080218021802180218021802180218021";

    struct Configuration {
        address deployer;
        address owner;
        IERC20 token;
        uint8 tokenDecimals;
        uint256 rewardAmountRaw;
        address signer;
        address factory;
    }

    function run() external returns (MemeFunLaunchRewards campaign) {
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        address deployer = vm.envAddress("MEMEFUN_LAUNCH_REWARD_DEPLOYER");
        bool confirmed = broadcasting && vm.envOr("MEMEFUN_LAUNCH_REWARD_DEPLOY_CONFIRMED", false);
        _checkRunSafety(block.chainid, broadcasting, confirmed, deployer);

        uint256 decimals = vm.envUint("MEMEFUN_LAUNCH_REWARD_TOKEN_DECIMALS");
        require(decimals <= type(uint8).max, "invalid token decimals");
        Configuration memory c = Configuration({
            deployer: deployer,
            owner: vm.envAddress("MEMEFUN_LAUNCH_REWARD_OWNER"),
            token: IERC20(vm.envAddress("MEMEFUN_LAUNCH_REWARD_TOKEN")),
            tokenDecimals: uint8(decimals),
            rewardAmountRaw: vm.envUint("MEMEFUN_LAUNCH_REWARD_AMOUNT_RAW"),
            signer: vm.envAddress("MEMEFUN_LAUNCH_REWARD_SIGNER"),
            factory: vm.envAddress("MEMEFUN_LAUNCH_REWARD_FACTORY")
        });
        campaign = _deploy(c);
        console2.log(broadcasting ? "Campaign creation prepared for broadcast" : "SIMULATED ONLY");
        console2.log("Campaign address", address(campaign));
        console2.log("Required raw funding", campaign.totalAllocation());
        console2.log("Funding and owner activation are separate manual transactions");
    }

    function _checkRunSafety(
        uint256 chainId,
        bool broadcasting,
        bool confirmed,
        address deployer
    )
        internal
        pure
    {
        require(chainId == 8453 || chainId == 84_532, "unsupported chain");
        require(deployer != address(0), "invalid deployer");
        require(!broadcasting || confirmed, "launch reward deployment not confirmed");
    }

    function _attributedInitCode(Configuration memory c) internal pure returns (bytes memory) {
        return bytes.concat(
            type(MemeFunLaunchRewards).creationCode,
            abi.encode(c.owner, c.token, c.tokenDecimals, c.rewardAmountRaw, c.signer, c.factory),
            BUILDER_SUFFIX
        );
    }

    function _deploy(Configuration memory c) internal returns (MemeFunLaunchRewards campaign) {
        uint64 nonce = vm.getNonce(c.deployer);
        require(nonce < type(uint64).max, "deployer nonce exhausted");
        address expected = vm.computeCreateAddress(c.deployer, nonce);
        bytes memory initCode = _attributedInitCode(c);
        address deployed;
        vm.startBroadcast(c.deployer);
        assembly ("memory-safe") {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        vm.stopBroadcast();
        require(deployed != address(0) && deployed.code.length != 0, "attributed CREATE failed");
        require(deployed == expected, "campaign address moved");
        require(vm.getNonce(c.deployer) == nonce + 1, "unexpected deployer nonce");
        campaign = MemeFunLaunchRewards(deployed);
        require(!campaign.activated() && campaign.startBlock() == 0, "unexpected activation");
        require(campaign.tradeRequiredFromBlock() == 0, "unexpected trade requirement");
    }
}
