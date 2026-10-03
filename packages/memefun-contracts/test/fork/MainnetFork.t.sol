// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IActivationRegistry} from "base-std/interfaces/IActivationRegistry.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {BuybackBurnVault} from "../../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {Mode, PriceSource, QuoteKind} from "../../src/types/MemeFunTypes.sol";

/// @notice memefun deployed onto a fork of Base mainnet: the real PoolManager, Chainlink ETH/USD,
///         USDC, Coinbase's AAPLc tokenized stock, and Uniswap's own Universal Router.
///
///   MEMEFUN_FORK_TESTS=1 FOUNDRY_BASE=true ~/.base-foundry/bin/forge test --match-path "test/fork/*"
///
/// Needs base-forge: real B20 balances (AAPLc) live in Base's precompiles, which stock forge
/// cannot execute. Without it, or without MEMEFUN_FORK_TESTS, every test here is a no-op.
contract MainnetForkTest is Test {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address internal constant ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    /// Aerodrome Slipstream AAPL/USDC pool: a large AAPLc holder to borrow from on the fork.
    address internal constant AAPLC_HOLDER = 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
    /// Uniswap Universal Router on Base (fork-verified struct layout without minHopPriceX36).
    address internal constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");

    MemeFunConfig internal config;
    MemeFunFactory internal factory;
    FeeVault internal vault;
    MemeFunHook internal hook;
    MemeFunRouter internal router;
    BuybackBurnVault internal burnVault;
    FloorVault internal floorVault;

    bool internal enabled;
    uint256 internal saltNonce;

    function setUp() public {
        if (vm.envOr("MEMEFUN_FORK_TESTS", uint256(0)) == 0) return;
        vm.createSelectFork(vm.envOr("BASE_MAINNET_RPC_URL", string("https://mainnet.base.org")));
        (bool ok, bytes memory ret) =
            StdPrecompiles.ACTIVATION_REGISTRY_ADDRESS.staticcall(abi.encodeCall(IActivationRegistry.admin, ()));
        if (!ok || ret.length < 32) return; // stock forge: no B20 precompiles, skip
        enabled = true;
        _deploy();
        deal(creator, 100 ether);
        deal(alice, 100 ether);
    }

    function _deploy() internal {
        config = new MemeFunConfig(owner, treasury);
        address hookAddress = address(HOOK_FLAGS | (uint160(0x4d454d45) << 128));
        vault = new FeeVault(POOL_MANAGER, IMemeFunHook(hookAddress), config);
        factory = new MemeFunFactory(POOL_MANAGER, IMemeFunHook(hookAddress), config);
        router = new MemeFunRouter(POOL_MANAGER, IMemeFunHook(hookAddress));
        deployCodeTo("MemeFunHook.sol:MemeFunHook", abi.encode(POOL_MANAGER, factory, vault, router), hookAddress);
        hook = MemeFunHook(hookAddress);
        burnVault = new BuybackBurnVault(POOL_MANAGER, hook, IFeeVault(address(vault)));
        floorVault = new FloorVault(POOL_MANAGER, hook, IFeeVault(address(vault)));
        HolderRewardDistributor holders = new HolderRewardDistributor(POOL_MANAGER, hook, IFeeVault(address(vault)), config);

        vm.startPrank(owner);
        config.listQuote(address(0), QuoteKind.NATIVE, PriceSource.CHAINLINK, ETH_USD, 0, 1 days);
        config.setQuoteEnabled(address(0), true);
        config.listQuote(USDC, QuoteKind.STABLE, PriceSource.FIXED, address(0), 1e8, 0);
        config.setQuoteEnabled(USDC, true);
        config.listQuote(AAPLC, QuoteKind.STOCK, PriceSource.MANUAL, address(0), 330_37500000, 4 days);
        config.setQuoteEnabled(AAPLC, true);
        config.setQuoteKindEnabled(uint256(QuoteKind.STOCK), true);
        config.setModeModule(uint256(Mode.BURN), address(burnVault));
        config.setModeModule(uint256(Mode.FLOOR), address(floorVault));
        config.setModeModule(uint256(Mode.HOLDERS), address(holders));
        for (uint256 m = 1; m <= 3; ++m) config.setModeEnabled(m, true);
        vm.stopPrank();
    }

    function test_fork_ethCoin_launchTradeAndClaim() public {
        if (!enabled) return;
        address coin = _launch(address(0), Mode.CREATOR, 300, 0.5 ether);
        assertEq(IB20(coin).totalSupply(), LaunchMath.SUPPLY);
        assertGt(IB20(coin).balanceOf(creator), 0, "first buy on the real PoolManager");

        vm.warp(block.timestamp + 15);
        vm.prank(alice);
        uint256 coins = router.buy{value: 1 ether}(_trade(coin, 1 ether));
        vm.startPrank(alice);
        IB20(coin).approve(address(router), coins / 2);
        router.sell(_trade(coin, coins / 2));
        vm.stopPrank();

        uint256 owed = vault.creatorPending(coin);
        assertGt(owed, 0);
        uint256 before = creator.balance;
        vm.prank(creator);
        vault.claimCreator(coin, creator);
        assertEq(creator.balance - before, owed, "creator paid in real ETH");
    }

    /// Trades through Uniswap's own Universal Router pay exactly the same fee.
    function test_fork_universalRouterPaysTheFee() public {
        if (!enabled) return;
        address coin = _launch(address(0), Mode.CREATOR, 300, 0);
        vm.warp(block.timestamp + 15);
        PoolKey memory key = hook.poolKeyOf(coin);

        uint256 claimsBefore = POOL_MANAGER.balanceOf(address(vault), 0);
        uint256 coinsBefore = IB20(coin).balanceOf(alice);
        bytes memory call = _urExactInEthForCoin(key, 0.2 ether);
        vm.prank(alice);
        (bool ok,) = UNIVERSAL_ROUTER.call{value: 0.2 ether}(call);
        assertTrue(ok, "Universal Router swap succeeded");
        assertGt(IB20(coin).balanceOf(alice) - coinsBefore, 0, "coins received via Uniswap's router");
        assertEq(POOL_MANAGER.balanceOf(address(vault), 0) - claimsBefore, FeeMath.onGross(0.2 ether, 300), "same fee");
        assertEq(vault.referralPending(UNIVERSAL_ROUTER, Currency.wrap(address(0))), 0, "no referral outside the app");
    }

    function test_fork_usdcCoin() public {
        if (!enabled) return;
        deal(USDC, creator, 1_000e6);
        address coin = _launch(USDC, Mode.HOLDERS, 200, 100e6);
        assertGt(IB20(coin).balanceOf(creator), 0);
        assertEq(POOL_MANAGER.balanceOf(address(vault), uint256(uint160(USDC))), FeeMath.onGross(100e6, 200));
    }

    function test_fork_tokenizedStockCoin() public {
        if (!enabled) return;
        vm.prank(AAPLC_HOLDER);
        IERC20(AAPLC).transfer(creator, 100e8);
        address coin = _launch(AAPLC, Mode.CREATOR, 100, 5e8); // first buy: 5 AAPLc
        assertGt(IB20(coin).balanceOf(creator), 0, "bought with a real Coinbase stock token");
        assertEq(
            POOL_MANAGER.balanceOf(address(vault), uint256(uint160(AAPLC))), FeeMath.onGross(5e8, 100), "fee in AAPLc"
        );
    }

    function test_fork_buybackAndFloorOnTheRealPoolManager() public {
        if (!enabled) return;
        address burnCoin = _launch(address(0), Mode.BURN, 500, 0);
        address floorCoin = _launch(address(0), Mode.FLOOR, 500, 0);
        vm.warp(block.timestamp + 15);
        vm.startPrank(alice);
        router.buy{value: 3 ether}(_trade(burnCoin, 3 ether));
        router.buy{value: 3 ether}(_trade(floorCoin, 3 ether));
        vm.stopPrank();
        vm.roll(block.number + 1);

        uint256 deadBefore = IB20(burnCoin).balanceOf(address(0xdEaD));
        (, uint256 burned) = burnVault.executeBuyback(burnCoin);
        assertEq(IB20(burnCoin).balanceOf(address(0xdEaD)) - deadBefore, burned);
        (,, uint128 liquidity,) = floorVault.addFloor(floorCoin);
        assertGt(liquidity, 0);
    }

    // -------------------------------------------------------------------------------------------

    function _launch(address quote, Mode mode, uint16 feeBps, uint256 firstBuy) internal returns (address) {
        if (quote != address(0) && firstBuy != 0) {
            vm.prank(creator);
            IERC20(quote).approve(address(factory), firstBuy);
        }
        return _send(_launchParams(quote, mode, feeBps, firstBuy), quote == address(0) ? firstBuy : 0);
    }

    /// @dev Kept separate so the launch struct's ABI encoder has the stack to itself.
    function _send(MemeFunFactory.LaunchParams memory p, uint256 value) internal returns (address coin) {
        vm.prank(creator);
        (coin,,) = factory.launch{value: value}(p);
    }

    function _launchParams(address quote, Mode mode, uint16 feeBps, uint256 firstBuy)
        internal
        returns (MemeFunFactory.LaunchParams memory p)
    {
        p.name = "Fork Frog";
        p.symbol = "FROG";
        p.contractURI = "ipfs://fork";
        p.quote = quote;
        p.mode = mode;
        p.feeBps = feeBps;
        p.salt = bytes32(++saltNonce);
        p.firstBuyAmount = firstBuy;
        p.maxTickDrift = type(uint24).max;
        p.deadline = block.timestamp + 1 hours;
    }

    function _trade(address coin, uint256 amountIn) internal view returns (MemeFunRouter.TradeParams memory) {
        return MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: amountIn,
            minAmountOut: 0,
            recipient: address(0),
            referrer: address(0),
            deadline: block.timestamp + 60
        });
    }

    struct UrExactInputSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /// @dev V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL, as fork-verified for this
    ///      router in packages/contracts/test/DustSwapSweepRouterV4Fork.t.sol.
    function _urExactInEthForCoin(PoolKey memory key, uint128 amountIn) internal view returns (bytes memory) {
        bytes[] memory params = new bytes[](3);
        params[0] = _urSwapParam(key, amountIn);
        params[1] = abi.encode(key.currency0, uint256(amountIn));
        params[2] = abi.encode(key.currency1, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        bytes memory actions = hex"060c0f";
        inputs[0] = abi.encode(actions, params);
        bytes memory commands = hex"10";
        uint256 deadline = block.timestamp + 600;
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, deadline);
    }

    function _urSwapParam(PoolKey memory key, uint128 amountIn) internal pure returns (bytes memory) {
        UrExactInputSingle memory swap;
        swap.poolKey = key;
        swap.zeroForOne = true;
        swap.amountIn = amountIn;
        return abi.encode(swap);
    }
}
