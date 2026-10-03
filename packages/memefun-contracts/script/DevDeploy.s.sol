// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IActivationRegistry} from "base-std/interfaces/IActivationRegistry.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";

import {PriceSource, QuoteKind} from "../src/types/MemeFunTypes.sol";
import {TestToken} from "../test/utils/TestTokens.sol";
import {Deploy} from "./Deploy.s.sol";
import {DevPriceFeed} from "./dev/DevPriceFeed.sol";

/// @notice A complete memefun on a fresh LOCAL chain, for backend development and the e2e suite.
///
/// On top of Deploy's own logic (same contracts, same configuration code) it deploys what Base
/// provides on real chains: a v4 PoolManager (v4-core's artifact), a mock USDC, an ETH/USD feed
/// that never goes stale, and an 8-decimal B20 standing in for a Coinbase tokenized stock. It
/// enables the stock pair (off on real chains until legal review), funds the dev accounts and
/// writes deployments/31337.json. Trading activity is seeded afterwards by the backend's seed
/// script, which can move chain time between trades.
///
///   ~/.base-foundry/bin/anvil --base --base-activation-admin 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///   FOUNDRY_BASE=true ~/.base-foundry/bin/forge script script/DevDeploy.s.sol \
///     --rpc-url http://127.0.0.1:8545 --broadcast --slow --offline
///
/// `--offline` matters: without it forge looks up trace signatures on Sourcify after the run and
/// can wait on that indefinitely. Only anvil's public test mnemonic is used, and any chain other
/// than 31337 is refused.
contract DevDeploy is Deploy {
    string internal constant DEV_MNEMONIC = "test test test test test test test test test test test junk";
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    // Dev account roles: indexes into anvil's default accounts.
    uint256 internal constant DEPLOYER = 0; // owner and B20 activation admin
    uint256 internal constant FIRST_USER = 1; // 1-6: creators, traders and a referrer
    uint256 internal constant LAST_USER = 6;
    uint256 internal constant TREASURY = 7;
    uint256 internal constant KEEPER = 8; // price keeper (stock NAVs)
    uint256 internal constant PUBLISHER = 9; // holder-rewards publisher
    uint256 internal constant ACCOUNTS = 10;

    int256 internal constant ETH_USD_E8 = 3_000e8;
    uint64 internal constant STOCK_USD_E8 = 241_10000000;
    uint32 internal constant STOCK_PRICE_MAX_AGE = 1 days;
    uint256 internal constant USDC_PER_USER = 1_000_000e6;
    uint256 internal constant STOCK_PER_USER = 10_000e8;

    address[ACCOUNTS] internal dev;

    struct LocalChain {
        ChainAddresses c;
        address stock;
    }

    function run() external override returns (Deployed memory d) {
        require(block.chainid == LOCAL_CHAIN_ID, "DevDeploy: local chain 31337 only");
        _loadDevAccounts();
        _ensureB20Active();

        LocalChain memory local = _deployLocalChain();
        d = _deploy(dev[DEPLOYER], dev[TREASURY], local.c);
        _configure(d, local.c, dev[DEPLOYER], dev[DEPLOYER], dev[KEEPER], dev[PUBLISHER]);
        _enableStockPair(d, local.stock);

        string memory key = "memefun";
        vm.serializeAddress(key, "stock", local.stock);
        vm.serializeUint(key, "stockPriceUsdE8", STOCK_USD_E8);
        vm.serializeAddress(key, "priceFeedAdmin", dev[DEPLOYER]);
        string memory json = _record(d, local.c, dev[DEPLOYER], dev[TREASURY]);
        // A simulation without --broadcast deploys nothing, so it must not leave addresses behind.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _write(json);
            console2.log("memefun local chain ready, deployments/31337.json written");
        } else {
            console2.log(json);
        }
    }

    function _loadDevAccounts() internal {
        for (uint256 i; i < ACCOUNTS; ++i) {
            dev[i] = vm.rememberKey(vm.deriveKey(DEV_MNEMONIC, uint32(i)));
        }
    }

    /// @dev `anvil --base` starts with every B20 feature active; this only matters if a future
    ///      base-anvil default changes. The activation admin must be the deployer (see usage).
    function _ensureB20Active() internal {
        bytes32[3] memory features = [
            keccak256("base.b20_asset"),
            keccak256("base.b20_stablecoin"),
            keccak256("base.policy_registry")
        ];
        for (uint256 i; i < features.length; ++i) {
            if (StdPrecompiles.ACTIVATION_REGISTRY.isActivated(features[i])) continue;
            require(
                StdPrecompiles.ACTIVATION_REGISTRY.admin() == dev[DEPLOYER],
                "DevDeploy: start anvil with --base-activation-admin set to dev account 0"
            );
            // Low-level on purpose: a native precompile reports no code, and Solidity's high-level
            // call to a function without return values would refuse to call it.
            vm.broadcast(dev[DEPLOYER]);
            (bool ok,) = StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS.call(
                abi.encodeCall(IActivationRegistry.activate, (features[i]))
            );
            require(ok, "DevDeploy: B20 feature activation failed");
        }
    }

    function _deployLocalChain() internal returns (LocalChain memory local) {
        vm.startBroadcast(dev[DEPLOYER]);
        // v4-core's compiled PoolManager (see test/utils/Artifacts.sol), owned by the deployer.
        local.c.poolManager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(dev[DEPLOYER])));
        TestToken usdc = new TestToken("USD Coin", "USDC", 6);
        local.c.usdc = address(usdc);
        local.c.ethUsdFeed = address(new DevPriceFeed(ETH_USD_E8));
        for (uint256 i = FIRST_USER; i <= LAST_USER; ++i) {
            usdc.mint(dev[i], USDC_PER_USER);
        }
        local.stock = _createStock();
        vm.stopBroadcast();
    }

    /// @dev A B20 like Coinbase's tokenized stocks: 8 decimals. Unlike memefun coins it has an
    ///      admin (the deployer, who may also mint), so tests can top up balances.
    function _createStock() internal returns (address stock) {
        uint256 users = LAST_USER - FIRST_USER + 1;
        bytes[] memory initCalls = new bytes[](users + 1);
        initCalls[0] = B20FactoryLib.encodeGrantRole(B20Constants.MINT_ROLE, dev[DEPLOYER]);
        for (uint256 i; i < users; ++i) {
            initCalls[i + 1] = abi.encodeCall(IB20.mint, (dev[FIRST_USER + i], STOCK_PER_USER));
        }
        stock = StdPrecompiles.B20_FACTORY.createB20(
            IB20Factory.B20Variant.ASSET,
            keccak256("memefun dev stock AAPLc"),
            B20FactoryLib.encodeAssetCreateParams("Apple tokenized stock (dev)", "AAPLc", dev[DEPLOYER], 8),
            initCalls
        );
    }

    function _enableStockPair(Deployed memory d, address stock) internal {
        vm.startBroadcast(dev[DEPLOYER]);
        d.config.setQuoteKindEnabled(uint256(QuoteKind.STOCK), true);
        d.config.listQuote(stock, QuoteKind.STOCK, PriceSource.MANUAL, address(0), STOCK_USD_E8, STOCK_PRICE_MAX_AGE);
        d.config.setQuoteEnabled(stock, true);
        vm.stopBroadcast();
    }
}
