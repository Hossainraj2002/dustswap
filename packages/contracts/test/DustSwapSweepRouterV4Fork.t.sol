// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DustSwapSweepRouter, ISignatureTransfer} from "../src/DustSwapSweepRouter.sol";

interface IWETH9Min {
    function deposit() external payable;
}

/// @title Uniswap V4 (Universal Router) integration — Base mainnet FORK test.
/// @dev   Run: forge test --match-contract DustSwapSweepRouterV4ForkTest --fork-url https://mainnet.base.org -vv
///        Against the LIVE deployed Universal Router, this pins whether the V4
///        ExactInputSingleParams struct includes `minHopPriceX36` (recent v4-periphery) or not.
///        The accepted variant produces USDC; the wrong variant is skipped (best-effort) -> 0.
contract DustSwapSweepRouterV4ForkTest is Test {
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    bytes constant COMMANDS = hex"10"; // V4_SWAP
    bytes constant ACTIONS = hex"060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

    // PoolKey + the two candidate ExactInputSingleParams layouts.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    struct ExactInWithMinHop {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }
    struct ExactInNoMinHop {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    DustSwapSweepRouter internal router;
    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");
    address internal feeCollector = makeAddr("feeCollector");
    bool internal forked;

    function setUp() public {
        // Opt-in only (network + must run under cancun):
        //   DUST_SWEEP_FORK_TESTS=1 forge test --match-contract DustSwapSweepRouterV4ForkTest --evm-version cancun -vv
        if (vm.envOr("DUST_SWEEP_FORK_TESTS", uint256(0)) == 0) return;
        try vm.createSelectFork("https://mainnet.base.org") {
            forked = true;
        } catch {
            return; // no network: tests below no-op so the default suite isn't blocked
        }
        router = new DustSwapSweepRouter(PERMIT2, WETH, owner, feeCollector, 200);
        vm.startPrank(owner);
        router.setAllowedTarget(UNIVERSAL_ROUTER, true);
        router.setAllowedSpender(PERMIT2, true);
        vm.stopPrank();
    }

    function _poolKey() internal pure returns (PoolKey memory) {
        // WETH (0x4200..) < USDC (0x8335..) => currency0 = WETH. fee 500 / tickSpacing 10 (live pool).
        return PoolKey({currency0: WETH, currency1: USDC, fee: 500, tickSpacing: 10, hooks: address(0)});
    }

    function _buildV4Calldata(uint128 amountIn, bool withMinHop) internal view returns (bytes memory) {
        bytes memory swapParam = withMinHop
            ? abi.encode(
                ExactInWithMinHop({
                    poolKey: _poolKey(),
                    zeroForOne: true,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    minHopPriceX36: 0,
                    hookData: ""
                })
            )
            : abi.encode(
                ExactInNoMinHop({
                    poolKey: _poolKey(),
                    zeroForOne: true,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    hookData: ""
                })
            );

        bytes memory settleParam = abi.encode(WETH, uint256(amountIn)); // SETTLE_ALL(currency, maxAmount)
        bytes memory takeParam = abi.encode(USDC, uint256(0)); // TAKE_ALL(currency, minAmount)

        bytes[] memory params = new bytes[](3);
        params[0] = swapParam;
        params[1] = settleParam;
        params[2] = takeParam;

        bytes memory v4Input = abi.encode(ACTIONS, params);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = v4Input;

        return abi.encodeWithSignature(
            "execute(bytes,bytes[],uint256)", COMMANDS, inputs, block.timestamp + 1200
        );
    }

    function _runSweep(uint128 amountIn, bytes memory data) internal returns (uint256 grossOut) {
        deal(user, 1 ether);
        vm.prank(user);
        IWETH9Min(WETH).deposit{value: amountIn}();

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = DustSwapSweepRouter.SweepRoute({
            tokenIn: WETH,
            amountIn: amountIn,
            target: UNIVERSAL_ROUTER,
            spender: PERMIT2,
            value: 0,
            data: data
        });
        DustSwapSweepRouter.SweepParams memory params = DustSwapSweepRouter.SweepParams({
            outputToken: USDC,
            recipient: recipient,
            minAmountOut: 0, // best-effort: a wrong-variant route is skipped (no revert), yielding 0
            deadline: block.timestamp + 1200,
            feeBpsOverride: 0
        });
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);

        uint256 before = IERC20(USDC).balanceOf(recipient);
        vm.startPrank(user);
        IERC20(WETH).approve(address(router), amountIn);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, permit, "");
        vm.stopPrank();
        grossOut = IERC20(USDC).balanceOf(recipient) - before;
    }

    /// Fork-verified 2026-06-09 on Base (cancun): the deployed Universal Router accepts the V4
    /// ExactInputSingleParams struct WITHOUT `minHopPriceX36`, producing ~16 USDC for 0.01 WETH.
    /// The minHopPriceX36 variant is rejected (skipped -> 0). Guards the backend's V4 calldata.
    function test_v4_structVariant() public {
        if (!forked) return;
        uint256 withHop = _runSweep(0.01 ether, _buildV4Calldata(0.01 ether, true));
        uint256 noHop = _runSweep(0.01 ether, _buildV4Calldata(0.01 ether, false));
        emit log_named_uint("V4 USDC WITH minHopPriceX36", withHop);
        emit log_named_uint("V4 USDC WITHOUT minHopPriceX36", noHop);

        if (withHop == 0 && noHop == 0) {
            emit log("V4 produced no output - run with --evm-version cancun (UR uses transient storage).");
            return;
        }
        assertEq(withHop, 0, "minHopPriceX36 variant should be rejected by the deployed UR");
        assertGt(noHop, 15_000_000, "no-minHop V4 swap should yield ~16 USDC for 0.01 WETH");
    }
}
