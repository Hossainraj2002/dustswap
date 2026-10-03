// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {FeeVault} from "../src/FeeVault.sol";
import {MemeFunConfig} from "../src/MemeFunConfig.sol";
import {MemeFunFactory} from "../src/MemeFunFactory.sol";
import {MemeFunHook} from "../src/MemeFunHook.sol";
import {MemeFunRouter} from "../src/MemeFunRouter.sol";
import {IFeeVault} from "../src/interfaces/IFeeVault.sol";
import {IMemeFunHook} from "../src/interfaces/IMemeFunHook.sol";
import {BuybackBurnVault} from "../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../src/modules/HolderRewardDistributor.sol";
import {Mode, PriceSource, QuoteKind} from "../src/types/MemeFunTypes.sol";

/// @notice Deploys the whole memefun system with every cross-reference as an immutable.
///
/// How the addresses are known before anything exists:
///   - Every contract except the hook is deployed with plain CREATE from the deployer, so its
///     address depends only on the deployer's nonce and is computed up front.
///   - The hook goes through the deterministic CREATE2 deployer with a salt mined here so its
///     address carries its permission flags. Its init code embeds the (already predicted)
///     factory, vault and router addresses, so nothing needs an initializer.
/// The script asserts every predicted address and stops if the deployer's nonce moved.
///
/// Dry run against a simulated Base Sepolia fork, with a smoke launch, no broadcast:
///   DRY_RUN=true FOUNDRY_BASE=true ~/.base-foundry/bin/forge script script/Deploy.s.sol \
///     --fork-url https://sepolia.base.org
///
/// Real deployment (Phase 4+), with an encrypted keystore account:
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --verify
contract Deploy is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct ChainAddresses {
        IPoolManager poolManager;
        address ethUsdFeed;
        address usdc;
    }

    struct Deployed {
        MemeFunConfig config;
        FeeVault vault;
        MemeFunFactory factory;
        MemeFunRouter router;
        BuybackBurnVault burnVault;
        FloorVault floorVault;
        HolderRewardDistributor holders;
        MemeFunHook hook;
        bytes32 hookSalt;
    }

    function chainConfig(uint256 chainId) public pure returns (ChainAddresses memory) {
        if (chainId == 8453) {
            return ChainAddresses({
                poolManager: IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b),
                ethUsdFeed: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70,
                usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
            });
        }
        if (chainId == 84532) {
            return ChainAddresses({
                poolManager: IPoolManager(0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408),
                ethUsdFeed: 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1,
                usdc: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
            });
        }
        revert("unsupported chain");
    }

    function run() external virtual returns (Deployed memory d) {
        bool dryRun = vm.envOr("DRY_RUN", false);
        address deployer = vm.envOr("DEPLOYER", msg.sender);
        address owner = vm.envOr("OWNER", deployer);
        address treasury = vm.envOr("TREASURY", owner);
        ChainAddresses memory c = chainConfig(block.chainid);
        if (dryRun) vm.deal(deployer, 10 ether);

        d = _deploy(deployer, treasury, c);
        _configure(
            d,
            c,
            deployer,
            owner,
            vm.envOr("PRICE_KEEPER", address(0)),
            vm.envOr("REWARDS_PUBLISHER", address(0))
        );
        if (dryRun) _smokeLaunch(d, deployer);
        string memory json = _record(d, c, owner, treasury);
        if (dryRun) {
            console2.log(json);
        } else {
            _write(json);
        }
    }

    function _deploy(address deployer, address treasury, ChainAddresses memory c) internal returns (Deployed memory d) {
        uint64 nonce = vm.getNonce(deployer);
        address configAt = vm.computeCreateAddress(deployer, nonce);
        address vaultAt = vm.computeCreateAddress(deployer, nonce + 1);
        address factoryAt = vm.computeCreateAddress(deployer, nonce + 2);
        address routerAt = vm.computeCreateAddress(deployer, nonce + 3);

        bytes memory hookInit = abi.encodePacked(type(MemeFunHook).creationCode, abi.encode(c.poolManager, factoryAt, vaultAt, routerAt));
        (address hookAt, bytes32 salt) = _mineHookSalt(keccak256(hookInit));
        d.hookSalt = salt;
        console2.log("hook address (mined):", hookAt);

        vm.startBroadcast(deployer);
        // The config is owned by the deployer while it is set up, then handed to OWNER (two-step).
        d.config = new MemeFunConfig(deployer, treasury);
        d.vault = new FeeVault(c.poolManager, IMemeFunHook(hookAt), d.config);
        d.factory = new MemeFunFactory(c.poolManager, IMemeFunHook(hookAt), d.config);
        d.router = new MemeFunRouter(c.poolManager, IMemeFunHook(hookAt));
        d.burnVault = new BuybackBurnVault(c.poolManager, IMemeFunHook(hookAt), IFeeVault(vaultAt));
        d.floorVault = new FloorVault(c.poolManager, IMemeFunHook(hookAt), IFeeVault(vaultAt));
        d.holders = new HolderRewardDistributor(c.poolManager, IMemeFunHook(hookAt), IFeeVault(vaultAt), d.config);
        d.hook = new MemeFunHook{salt: salt}(c.poolManager, factoryAt, IFeeVault(vaultAt), routerAt);
        vm.stopBroadcast();

        require(address(d.config) == configAt, "config address moved");
        require(address(d.vault) == vaultAt, "vault address moved: deployer nonce changed mid-run");
        require(address(d.factory) == factoryAt, "factory address moved");
        require(address(d.router) == routerAt, "router address moved");
        require(address(d.hook) == hookAt, "hook address mismatch");
    }

    /// @param keeper Price keeper for MANUAL quotes, or address(0) for none yet.
    /// @param publisher Holder-rewards publisher, or address(0) for none yet.
    function _configure(
        Deployed memory d,
        ChainAddresses memory c,
        address deployer,
        address owner,
        address keeper,
        address publisher
    ) internal {
        vm.startBroadcast(deployer);
        MemeFunConfig cfg = d.config;
        cfg.listQuote(address(0), QuoteKind.NATIVE, PriceSource.CHAINLINK, c.ethUsdFeed, 0, 1 days);
        cfg.setQuoteEnabled(address(0), true);
        cfg.listQuote(c.usdc, QuoteKind.STABLE, PriceSource.FIXED, address(0), 1e8, 0);
        cfg.setQuoteEnabled(c.usdc, true);
        // Stock pairs stay off (kind disabled at construction) until legal review clears them.
        cfg.setModeModule(uint256(Mode.BURN), address(d.burnVault));
        cfg.setModeModule(uint256(Mode.HOLDERS), address(d.holders));
        cfg.setModeModule(uint256(Mode.FLOOR), address(d.floorVault));
        cfg.setModeEnabled(uint256(Mode.BURN), true);
        cfg.setModeEnabled(uint256(Mode.HOLDERS), true);
        cfg.setModeEnabled(uint256(Mode.FLOOR), true);
        if (keeper != address(0)) cfg.setPriceKeeper(keeper);
        if (publisher != address(0)) cfg.setRewardsPublisher(publisher);
        if (owner != deployer) cfg.transferOwnership(owner); // OWNER must call acceptOwnership()
        vm.stopBroadcast();
    }

    /// @dev Dry runs only: launch a coin with a first buy and trade it, against the real
    ///      PoolManager and B20 precompiles of the forked chain.
    function _smokeLaunch(Deployed memory d, address deployer) internal {
        vm.startBroadcast(deployer);
        MemeFunFactory.LaunchParams memory p;
        p.name = "Dry Run";
        p.symbol = "DRY";
        p.contractURI = "ipfs://dry-run";
        p.quote = address(0);
        p.mode = Mode.BURN;
        p.feeBps = 100;
        p.salt = keccak256("memefun dry run");
        p.firstBuyAmount = 0.01 ether;
        p.maxTickDrift = type(uint24).max;
        p.deadline = block.timestamp + 1 hours;
        (address coin,, uint256 bought) = d.factory.launch{value: 0.01 ether}(p);
        vm.stopBroadcast();
        console2.log("smoke coin:", coin);
        console2.log("smoke first buy, coins:", bought);
        require(bought > 0, "smoke first buy failed");
    }

    /// @dev Serializes under the "memefun" object key, so a script that serialized more fields
    ///      under that key first gets them in the same JSON.
    function _record(Deployed memory d, ChainAddresses memory c, address owner, address treasury)
        internal
        returns (string memory json)
    {
        string memory key = "memefun";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "poolManager", address(c.poolManager));
        vm.serializeAddress(key, "ethUsdFeed", c.ethUsdFeed);
        vm.serializeAddress(key, "usdc", c.usdc);
        vm.serializeAddress(key, "config", address(d.config));
        vm.serializeAddress(key, "feeVault", address(d.vault));
        vm.serializeAddress(key, "factory", address(d.factory));
        vm.serializeAddress(key, "router", address(d.router));
        vm.serializeAddress(key, "hook", address(d.hook));
        vm.serializeBytes32(key, "hookSalt", d.hookSalt);
        vm.serializeAddress(key, "buybackBurnVault", address(d.burnVault));
        vm.serializeAddress(key, "floorVault", address(d.floorVault));
        vm.serializeAddress(key, "holderRewardDistributor", address(d.holders));
        vm.serializeAddress(key, "owner", owner);
        vm.serializeAddress(key, "treasury", treasury);
        vm.serializeAddress(key, "priceKeeper", d.config.priceKeeper());
        vm.serializeAddress(key, "rewardsPublisher", d.config.rewardsPublisher());
        json = vm.serializeUint(key, "deployedAtBlock", block.number);
    }

    function _write(string memory json) internal {
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    /// @dev Finds a CREATE2 salt (via the deterministic deployer) whose address carries exactly
    ///      the hook's 14 permission bits and has no code yet.
    function _mineHookSalt(bytes32 initCodeHash) internal view returns (address hookAt, bytes32 salt) {
        uint160 mask = Hooks.ALL_HOOK_MASK;
        for (uint256 i; i < 2_000_000; ++i) {
            salt = bytes32(i);
            hookAt = vm.computeCreate2Address(salt, initCodeHash, CREATE2_FACTORY);
            if (uint160(hookAt) & mask == HOOK_FLAGS && hookAt.code.length == 0) return (hookAt, salt);
        }
        revert("no hook salt found");
    }
}
