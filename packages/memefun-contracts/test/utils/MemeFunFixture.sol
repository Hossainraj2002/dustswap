// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {BuybackBurnVault} from "../../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {Mode, PriceSource, QuoteKind} from "../../src/types/MemeFunTypes.sol";

import {MemeFunTestBase} from "./MemeFunTestBase.sol";
import {MockAggregator, TestToken} from "./TestTokens.sol";

/// @notice The full memefun system on a local PoolManager, wired the way production will be.
///
///         Quotes cover every shape a launch can take:
///           - ETH (18 decimals, address 0): the coin is always currency1.
///           - USDC (6 decimals) at Base USDC's real address, below every B20 address: currency1.
///           - STOCK (8 decimals) at a high address, above every B20 address: the coin is currency0.
abstract contract MemeFunFixture is MemeFunTestBase {
    using StateLibrary for IPoolManager;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant STOCK_ADDRESS = 0xF0000000000000000000000000000000000057c4;
    address internal constant ETH = address(0);

    int256 internal constant ETH_USD_E8 = 2_751_12050000;
    uint64 internal constant STOCK_USD_E8 = 330_37500000;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal referrer = makeAddr("referrer");
    address internal publisher = makeAddr("rewardsPublisher");

    MemeFunConfig internal config;
    MemeFunFactory internal factory;
    FeeVault internal vault;
    MemeFunHook internal hook;
    MemeFunRouter internal router;
    BuybackBurnVault internal burnVault;
    FloorVault internal floorVault;
    HolderRewardDistributor internal holders;

    MockAggregator internal ethUsd;
    TestToken internal usdc;
    TestToken internal stock;

    function setUp() public virtual override {
        super.setUp();
        vm.warp(1_790_000_000);

        config = new MemeFunConfig(owner, treasury);
        address hookAddress = address(HOOK_FLAGS | (uint160(0x4d454d45) << 128));
        vault = new FeeVault(manager, IMemeFunHook(hookAddress), config);
        factory = new MemeFunFactory(manager, IMemeFunHook(hookAddress), config);
        router = new MemeFunRouter(manager, IMemeFunHook(hookAddress));
        deployCodeTo("MemeFunHook.sol:MemeFunHook", abi.encode(manager, factory, vault, router), hookAddress);
        hook = MemeFunHook(hookAddress);

        ethUsd = new MockAggregator(8, ETH_USD_E8);
        deployCodeTo("TestTokens.sol:TestToken", abi.encode("USD Coin", "USDC", uint8(6)), USDC_ADDRESS);
        usdc = TestToken(USDC_ADDRESS);
        deployCodeTo("TestTokens.sol:TestToken", abi.encode("Apple Inc.", "AAPLc", uint8(8)), STOCK_ADDRESS);
        stock = TestToken(STOCK_ADDRESS);

        vm.startPrank(owner);
        config.listQuote(ETH, QuoteKind.NATIVE, PriceSource.CHAINLINK, address(ethUsd), 0, 1 hours);
        config.setQuoteEnabled(ETH, true);
        config.listQuote(USDC_ADDRESS, QuoteKind.STABLE, PriceSource.FIXED, address(0), 1e8, 0);
        config.setQuoteEnabled(USDC_ADDRESS, true);
        config.listQuote(STOCK_ADDRESS, QuoteKind.STOCK, PriceSource.MANUAL, address(0), STOCK_USD_E8, 4 days);
        config.setQuoteEnabled(STOCK_ADDRESS, true);
        config.setQuoteKindEnabled(uint256(QuoteKind.STOCK), true);
        vm.stopPrank();

        _setUpModules();

        vm.label(address(config), "MemeFunConfig");
        vm.label(address(factory), "MemeFunFactory");
        vm.label(address(vault), "FeeVault");
        vm.label(address(hook), "MemeFunHook");
        vm.label(address(router), "MemeFunRouter");
        vm.label(USDC_ADDRESS, "USDC");
        vm.label(STOCK_ADDRESS, "AAPLc");

        deal(creator, 1_000 ether);
        deal(alice, 1_000 ether);
        deal(bob, 1_000 ether);
        usdc.mint(creator, 10_000_000e6);
        usdc.mint(alice, 10_000_000e6);
        stock.mint(creator, 100_000e8);
        stock.mint(alice, 100_000e8);
    }

    function _setUpModules() internal virtual {
        burnVault = new BuybackBurnVault(manager, hook, IFeeVault(address(vault)));
        floorVault = new FloorVault(manager, hook, IFeeVault(address(vault)));
        holders = new HolderRewardDistributor(manager, hook, IFeeVault(address(vault)), config);
        vm.label(address(burnVault), "BuybackBurnVault");
        vm.label(address(floorVault), "FloorVault");
        vm.label(address(holders), "HolderRewardDistributor");

        vm.startPrank(owner);
        config.setModeModule(uint256(Mode.BURN), address(burnVault));
        config.setModeModule(uint256(Mode.HOLDERS), address(holders));
        config.setModeModule(uint256(Mode.FLOOR), address(floorVault));
        for (uint256 mode = 1; mode <= 3; ++mode) config.setModeEnabled(mode, true);
        config.setRewardsPublisher(publisher);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------------------------
    // Time helpers
    // -------------------------------------------------------------------------------------------

    /// @dev Under via-IR the optimizer treats block.number and block.timestamp as constant for the
    ///      whole call, so "vm.roll(block.number + 1)" twice in one test can roll to the same block.
    ///      These read the live values through cheatcodes instead.
    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _skip(uint256 secondsForward) internal {
        vm.warp(vm.getBlockTimestamp() + secondsForward);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    // -------------------------------------------------------------------------------------------
    // Launch helpers
    // -------------------------------------------------------------------------------------------

    uint256 internal _saltNonce;

    function _params(address quote, Mode mode, uint16 feeBps) internal returns (MemeFunFactory.LaunchParams memory p) {
        ++_saltNonce;
        p.name = "Sock Puppet";
        p.symbol = "SOCK";
        p.contractURI = "ipfs://bafy-sock-puppet";
        p.quote = quote;
        p.mode = mode;
        p.feeBps = feeBps;
        p.salt = keccak256(abi.encode(quote, mode, feeBps, _saltNonce));
        p.maxTickDrift = 400;
        p.deadline = _now() + 1 hours;
        p.expectedStartTick = _expectedStartTick(quote, p.salt, creator);
    }

    /// @dev What the app computes before launch: the predicted address fixes the ordering.
    function _expectedStartTick(address quote, bytes32 salt, address who) internal view returns (int24) {
        address coin = factory.predictCoin(who, salt);
        bool coinIsCurrency0 = uint160(coin) < uint160(quote);
        return LaunchMath.startTick(
            config.quotePriceUsdE8(quote), config.quote(quote).decimals, coinIsCurrency0, config.openingFdvUsdE8()
        );
    }

    function _launch(MemeFunFactory.LaunchParams memory p) internal virtual returns (address coin) {
        return _launchAs(creator, p);
    }

    function _launchAs(address who, MemeFunFactory.LaunchParams memory p) internal returns (address coin) {
        p.expectedStartTick = _expectedStartTick(p.quote, p.salt, who);
        uint256 value = config.launchTerms().creationFee + (p.quote == ETH ? p.firstBuyAmount : 0);
        vm.startPrank(who);
        if (p.quote != ETH && p.firstBuyAmount != 0) TestToken(p.quote).approve(address(factory), p.firstBuyAmount);
        (coin,,) = factory.launch{value: value}(p);
        vm.stopPrank();
    }

    function _launchSimple(address quote, Mode mode, uint16 feeBps) internal returns (address coin) {
        return _launch(_params(quote, mode, feeBps));
    }

    // -------------------------------------------------------------------------------------------
    // Pool helpers
    // -------------------------------------------------------------------------------------------

    function _key(address coin) internal view returns (PoolKey memory) {
        return hook.poolKeyOf(coin);
    }

    function _sqrtPrice(address coin) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(hook.poolIdOf(coin));
    }

    function _slot0(address coin) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,) = manager.getSlot0(hook.poolIdOf(coin));
    }

    function _quoteOf(address coin) internal view returns (Currency) {
        return hook.quoteCurrencyOf(coin);
    }

    /// @dev ERC-6909 claims the vault holds for `currency`.
    function _vaultClaims(Currency currency) internal view returns (uint256) {
        return manager.balanceOf(address(vault), currency.toId());
    }

    function _balance(Currency currency, address account) internal view returns (uint256) {
        return currency.isAddressZero() ? account.balance : TestToken(Currency.unwrap(currency)).balanceOf(account);
    }
}
