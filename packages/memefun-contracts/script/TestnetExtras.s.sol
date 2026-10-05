// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";

import {MemeFunConfig} from "../src/MemeFunConfig.sol";
import {PriceSource, QuoteKind} from "../src/types/MemeFunTypes.sol";
import {TestStockFaucet} from "./testnet/TestStockFaucet.sol";

/// @notice TESTNET ONLY, run by the MemeFunConfig owner right after Deploy.s.sol.
///
/// Only Base Sepolia and the local development chain are allowed. This creates a labelled test stock (a B20
/// with 8 decimals, like Coinbase's) and a faucet that holds its MINT_ROLE, lists it as a MANUAL
/// quote kept fresh by the price keeper, enables stock pairs (testnet only; they stay off on
/// mainnet until legal review), sets the keeper roles, and records the addresses in
/// deployments/<chainId>.json.
///
///   PRICE_KEEPER=0x... REWARDS_PUBLISHER=0x... FOUNDRY_BASE=true ~/.base-foundry/bin/forge script \
///     script/TestnetExtras.s.sol --rpc-url base_sepolia --account <keystore> --broadcast --offline
///
/// With DRY_RUN=true (and --fork-url instead of --broadcast) it simulates and writes nothing.
contract TestnetExtras is Script {
    uint8 internal constant STOCK_DECIMALS = 8;
    uint64 internal constant STOCK_PRICE_USD_E8 = 24_000_000_000;
    uint32 internal constant STOCK_PRICE_MAX_AGE = 2 days;
    uint256 internal constant FAUCET_AMOUNT = 10e8;
    uint256 internal constant OWNER_SUPPLY = 100_000e8;
    bytes32 internal constant STOCK_SALT = keccak256("memefun testnet stock tAAPL");

    struct Result {
        address stock;
        address faucet;
    }

    function run() external returns (Result memory r) {
        bool dryRun = vm.envOr("DRY_RUN", false);
        _checkTestnetRun(block.chainid, dryRun, vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory existing = vm.readFile(path);
        MemeFunConfig config = MemeFunConfig(vm.parseJsonAddress(existing, ".config"));
        address owner = config.owner();
        require(
            dryRun || msg.sender == owner || vm.envOr("DEPLOYER", address(0)) == owner,
            "run as the config owner"
        );

        // The faucet must hold MINT_ROLE from the moment the stock exists: predict the stock's
        // address, deploy the faucet for it, then create the stock granting the role.
        address predicted = StdPrecompiles.B20_FACTORY
        .getB20Address(IB20Factory.B20Variant.ASSET, owner, STOCK_SALT);
        bytes[] memory initCalls;

        vm.startBroadcast(owner);
        r.faucet = address(new TestStockFaucet(IB20(predicted), FAUCET_AMOUNT));
        initCalls = new bytes[](2);
        initCalls[0] = B20FactoryLib.encodeGrantRole(B20Constants.MINT_ROLE, r.faucet);
        initCalls[1] = abi.encodeCall(IB20.mint, (owner, OWNER_SUPPLY));
        r.stock = StdPrecompiles.B20_FACTORY
            .createB20(
                IB20Factory.B20Variant.ASSET,
                STOCK_SALT,
                B20FactoryLib.encodeAssetCreateParams(
                    "Test stock AAPL (testnet, no value)", "tAAPL", owner, STOCK_DECIMALS
                ),
                initCalls
            );
        require(r.stock == predicted, "stock address moved");

        config.setQuoteKindEnabled(uint256(QuoteKind.STOCK), true);
        config.listQuote(
            r.stock,
            QuoteKind.STOCK,
            PriceSource.MANUAL,
            address(0),
            STOCK_PRICE_USD_E8,
            STOCK_PRICE_MAX_AGE
        );
        config.setQuoteEnabled(r.stock, true);
        address keeper = vm.envOr("PRICE_KEEPER", address(0));
        if (keeper != address(0) && keeper != config.priceKeeper()) config.setPriceKeeper(keeper);
        address publisher = vm.envOr("REWARDS_PUBLISHER", address(0));
        if (publisher != address(0) && publisher != config.rewardsPublisher()) {
            config.setRewardsPublisher(publisher);
        }
        address tweetAttestor = vm.envOr("TWEET_ATTESTOR", address(0));
        if (tweetAttestor != address(0) && tweetAttestor != config.tweetAttestor()) {
            config.setTweetAttestor(tweetAttestor);
        }
        vm.stopBroadcast();

        console2.log("test stock:", r.stock);
        console2.log("faucet:", r.faucet);

        // Add the new addresses to the deployment record (only when transactions were broadcast).
        string memory key = "memefun";
        vm.serializeJson(key, existing);
        vm.serializeAddress(key, "stock", r.stock);
        vm.serializeAddress(key, "stockFaucet", r.faucet);
        vm.serializeUint(key, "stockPriceUsdE8", STOCK_PRICE_USD_E8);
        vm.serializeAddress(key, "priceKeeper", config.priceKeeper());
        vm.serializeAddress(key, "rewardsPublisher", config.rewardsPublisher());
        string memory json = vm.serializeAddress(key, "tweetAttestor", config.tweetAttestor());
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) vm.writeJson(json, path);
        else console2.log(json);
    }

    /// @dev Refuse other networks and contradictory rehearsal flags before any transaction.
    function _checkTestnetRun(uint256 chainId, bool dryRun, bool broadcasting) internal pure {
        require(chainId == 84_532 || chainId == 31_337, "TestnetExtras: testnet only");
        require(!dryRun || !broadcasting, "DRY_RUN cannot be broadcast");
    }
}
