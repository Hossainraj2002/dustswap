// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {IActivationRegistry} from "base-std/interfaces/IActivationRegistry.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {ActivationRegistryFeatureList} from "base-std-test/lib/mocks/ActivationRegistryFeatureList.sol";
import {MockActivationRegistry} from "base-std-test/lib/mocks/MockActivationRegistry.sol";
import {MockB20Factory} from "base-std-test/lib/mocks/MockB20Factory.sol";
import {MockPolicyRegistry} from "base-std-test/lib/mocks/MockPolicyRegistry.sol";

/// @notice Shared base for every memefun test.
///
/// Two worlds, chosen automatically the same way base-std's own suite does it:
///   - REFERENCE (stock `forge test`): the B20 precompile addresses are empty, so the base-std
///     Solidity mocks are etched there and every B20 feature is activated.
///   - LIVE (`base-forge test`, or a fork of a base-anvil node): Base's real Rust precompiles
///     answer, nothing is etched, and the same assertions check our contracts against them.
///
/// Uniswap v4 always comes from a fresh local PoolManager, deployed from its compiled artifact
/// (see test/utils/Artifacts.sol). It runs the same pool logic as the PoolManager on Base.
abstract contract MemeFunTestBase is Test {
    uint256 internal constant COIN_SUPPLY = 1_000_000_000e18;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IB20Factory internal constant B20_FACTORY = StdPrecompiles.B20_FACTORY;

    /// True when Base's real precompiles are present (see `_detectLivePrecompiles`).
    bool internal livePrecompiles;

    IPoolManager internal manager;
    /// v4-core test routers: arbitrary callers with arbitrary hookData, used for direct-pool and
    /// exact-output tests that do not go through MemeFunRouter.
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal modifyLiquidityRouter;

    function setUp() public virtual {
        _setUpPrecompiles();
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        vm.label(address(manager), "PoolManager");
        swapRouter = new PoolSwapTest(manager);
        modifyLiquidityRouter = new PoolModifyLiquidityTest(manager);
    }

    function _setUpPrecompiles() internal {
        vm.label(StdPrecompiles.B20_FACTORY_ADDRESS, "B20Factory");
        vm.label(StdPrecompiles.POLICY_REGISTRY_ADDRESS, "PolicyRegistry");
        vm.label(StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS, "ActivationRegistry");

        livePrecompiles = _detectLivePrecompiles();
        if (livePrecompiles) {
            console2.log("[memefun] LIVE precompile mode: Base's B20 precompiles are under test");
            return;
        }

        vm.etch(StdPrecompiles.B20_FACTORY_ADDRESS, type(MockB20Factory).runtimeCode);
        vm.etch(StdPrecompiles.POLICY_REGISTRY_ADDRESS, type(MockPolicyRegistry).runtimeCode);
        vm.etch(StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS, type(MockActivationRegistry).runtimeCode);

        address activationAdmin = StdPrecompiles.ACTIVATION_REGISTRY.admin();
        vm.startPrank(activationAdmin);
        StdPrecompiles.ACTIVATION_REGISTRY.activate(ActivationRegistryFeatureList.B20_ASSET);
        StdPrecompiles.ACTIVATION_REGISTRY.activate(ActivationRegistryFeatureList.B20_STABLECOIN);
        StdPrecompiles.ACTIVATION_REGISTRY.activate(ActivationRegistryFeatureList.POLICY_REGISTRY);
        vm.stopPrank();
    }

    /// @dev Behavioral probe, as in base-std: a native precompile reports zero code size even
    ///      when it answers, so we ask the activation registry for its admin instead.
    function _detectLivePrecompiles() private view returns (bool) {
        if (vm.envOr("LIVE_PRECOMPILES", false)) return true;
        (bool ok, bytes memory ret) =
            StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS.staticcall(abi.encodeCall(IActivationRegistry.admin, ()));
        return ok && ret.length >= 32;
    }

    /// @notice Creates an admin-less B20 exactly the way MemeFunFactory does: fixed supply minted
    ///         to `holder`, supply cap equal to that supply, metadata set once, no role granted.
    function _createAdminlessCoin(address creator, bytes32 salt, string memory name, string memory symbol, address holder)
        internal
        returns (IB20 coin)
    {
        bytes[] memory initCalls = new bytes[](3);
        initCalls[0] = B20FactoryLib.encodeUpdateSupplyCap(COIN_SUPPLY);
        initCalls[1] = abi.encodeCall(IB20.mint, (holder, COIN_SUPPLY));
        initCalls[2] = B20FactoryLib.encodeUpdateContractURI("ipfs://memefun-test");
        vm.prank(creator);
        coin = IB20(
            B20_FACTORY.createB20(
                IB20Factory.B20Variant.ASSET,
                salt,
                B20FactoryLib.encodeAssetCreateParams(name, symbol, address(0), 18),
                initCalls
            )
        );
    }

    /// @notice Every role a B20 knows about, for "nobody holds any role" assertions.
    function _allB20Roles() internal pure returns (bytes32[9] memory roles) {
        roles = [
            B20Constants.DEFAULT_ADMIN_ROLE,
            B20Constants.MINT_ROLE,
            B20Constants.BURN_ROLE,
            B20Constants.BURN_BLOCKED_ROLE,
            B20Constants.SEIZE_ROLE,
            B20Constants.PAUSE_ROLE,
            B20Constants.UNPAUSE_ROLE,
            B20Constants.METADATA_ROLE,
            B20Constants.OPERATOR_ROLE
        ];
    }
}
