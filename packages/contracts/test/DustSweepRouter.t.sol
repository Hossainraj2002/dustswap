// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {BurnVault} from "../src/BurnVault.sol";
import {DustSweepRouter} from "../src/DustSweepRouter.sol";

/// @title DustSweepRouter Tests - Base Mainnet Fork
/// @dev   Run: forge test --match-contract DustSweepRouterTest --fork-url https://mainnet.base.org -vvv
contract DustSweepRouterTest is Test {
    // Base Mainnet addresses
    address constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Well-known tokens on Base with Uniswap V3 liquidity
    address constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;

    FeeCollector public feeCollector;
    BurnVault public burnVault;
    DustSweepRouter public router;

    address public owner;
    address public treasury;
    address public user;
    address public nonOwner;

    uint256 constant DEADLINE = type(uint256).max; // never expires in tests

    function setUp() public {
        owner = makeAddr("owner");
        treasury = makeAddr("treasury");
        user = makeAddr("user");
        nonOwner = makeAddr("nonOwner");

        vm.startPrank(owner);

        feeCollector = new FeeCollector(treasury, owner);
        burnVault = new BurnVault(address(feeCollector), owner);
        router = new DustSweepRouter(UNISWAP_ROUTER, WETH, address(feeCollector), owner);

        vm.stopPrank();

        // Fund user with ETH for gas and swaps
        vm.deal(address(this), 1 ether);
        vm.deal(user, 100 ether);
    }

    // ======================= HELPERS =======================

    /// @dev Get WETH by depositing ETH, then swap WETH to target token via Uniswap.
    function _getToken(address token, address to, uint256 ethAmount) internal {
        vm.startPrank(to);

        // Wrap ETH to WETH
        (bool success,) = WETH.call{value: ethAmount}("");
        require(success, "WETH deposit failed");

        // If requested token is WETH, we are done
        if (token == WETH) {
            vm.stopPrank();
            return;
        }

        // Swap WETH to token via Uniswap
        IERC20(WETH).approve(UNISWAP_ROUTER, ethAmount);

        bytes memory data = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH,
            token,
            uint24(3000),
            to,
            ethAmount,
            uint256(0),
            uint160(0)
        );

        (success,) = UNISWAP_ROUTER.call(data);
        require(success, "Swap to get test token failed");

        vm.stopPrank();
    }

    function _approveRouter(address token, address from, uint256 amount) internal {
        vm.prank(from);
        IERC20(token).approve(address(router), amount);
    }

    // ======================= sweepDust - 1 TOKEN ===========

    function test_sweepDust_singleToken() public {
        _getToken(USDC, user, 0.01 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        assertGt(usdcBalance, 0, "User should have USDC");

        _approveRouter(USDC, user, usdcBalance);

        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](1);
        orders[0] = DustSweepRouter.SwapOrder({
            tokenIn: USDC,
            amountIn: usdcBalance,
            poolFee: 500,
            minAmountOut: 0
        });

        uint256 wethBefore = IERC20(WETH).balanceOf(user);
        uint256 feeCollectorWethBefore = IERC20(WETH).balanceOf(address(feeCollector));

        vm.prank(user);
        router.sweepDust(orders, WETH, user, DEADLINE);

        uint256 wethReceived = IERC20(WETH).balanceOf(user) - wethBefore;
        uint256 feeReceived = IERC20(WETH).balanceOf(address(feeCollector)) - feeCollectorWethBefore;

        assertGt(wethReceived, 0, "User should receive WETH");
        assertGt(feeReceived, 0, "FeeCollector should receive fee");

        // Verify 2% fee
        uint256 totalOutput = wethReceived + feeReceived;
        uint256 expectedFee = (totalOutput * 200) / 10_000;
        assertApproxEqAbs(feeReceived, expectedFee, 1, "Fee should be ~2%");
    }

    // ======================= sweepDust - MAX BATCH =========

    function test_sweepDust_maxBatch() public {
        _getToken(USDC, user, 1 ether);
        uint256 totalUsdc = IERC20(USDC).balanceOf(user);
        assertGt(totalUsdc, 0, "User should have USDC");

        uint256 perOrder = totalUsdc / 10;

        _approveRouter(USDC, user, totalUsdc);

        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](10);
        for (uint256 i; i < 10; i++) {
            orders[i] = DustSweepRouter.SwapOrder({
                tokenIn: USDC,
                amountIn: perOrder,
                poolFee: 500,
                minAmountOut: 0
            });
        }

        vm.prank(user);
        router.sweepDust(orders, WETH, user, DEADLINE);

        uint256 wethBalance = IERC20(WETH).balanceOf(user);
        assertGt(wethBalance, 0, "User should receive WETH from max batch");
    }

    // ======================= sweepDust - EXCEEDS MAX =======

    function test_sweepDust_revertsOnBatchTooLarge() public {
        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](11);
        for (uint256 i; i < 11; i++) {
            orders[i] = DustSweepRouter.SwapOrder({
                tokenIn: USDC,
                amountIn: 1_000_000,
                poolFee: 500,
                minAmountOut: 0
            });
        }

        vm.prank(user);
        vm.expectRevert(DustSweepRouter.BatchTooLarge.selector);
        router.sweepDust(orders, WETH, user, DEADLINE);
    }

    // ======================= sweepDust - EMPTY =============

    function test_sweepDust_revertsOnEmptyOrders() public {
        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](0);

        vm.prank(user);
        vm.expectRevert(DustSweepRouter.EmptyOrders.selector);
        router.sweepDust(orders, WETH, user, DEADLINE);
    }

    // ======================= sweepDust - DEADLINE ===========

    function test_sweepDust_revertsOnExpiredDeadline() public {
        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](1);
        orders[0] = DustSweepRouter.SwapOrder({
            tokenIn: USDC,
            amountIn: 1_000_000,
            poolFee: 500,
            minAmountOut: 0
        });

        vm.prank(user);
        vm.expectRevert(DustSweepRouter.DeadlineExpired.selector);
        router.sweepDust(orders, WETH, user, block.timestamp - 1);
    }

    // ======================= sweepDustToETH ================

    function test_sweepDustToETH() public {
        _getToken(USDC, user, 0.05 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        _approveRouter(USDC, user, usdcBalance);

        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](1);
        orders[0] = DustSweepRouter.SwapOrder({
            tokenIn: USDC,
            amountIn: usdcBalance,
            poolFee: 500,
            minAmountOut: 0
        });

        uint256 ethBefore = user.balance;

        vm.prank(user);
        router.sweepDustToETH(orders, user, DEADLINE);

        uint256 ethReceived = user.balance - ethBefore;
        assertGt(ethReceived, 0, "User should receive ETH");
    }

    // ======================= sweepDustMultiHop =============

    function test_sweepDustMultiHop_singleToken() public {
        // Get DAI, then multi-hop swap DAI -> WETH -> USDC through the router
        _getToken(DAI, user, 0.05 ether);
        uint256 daiBalance = IERC20(DAI).balanceOf(user);
        assertGt(daiBalance, 0, "User should have DAI");

        _approveRouter(DAI, user, daiBalance);

        // Encode multi-hop path: DAI -> (3000 fee) -> WETH -> (500 fee) -> USDC
        bytes memory path = abi.encodePacked(
            DAI, uint24(3000), WETH, uint24(500), USDC
        );

        DustSweepRouter.MultiHopSwapOrder[] memory orders = new DustSweepRouter.MultiHopSwapOrder[](1);
        orders[0] = DustSweepRouter.MultiHopSwapOrder({
            tokenIn: DAI,
            amountIn: daiBalance,
            path: path,
            minAmountOut: 0
        });

        uint256 usdcBefore = IERC20(USDC).balanceOf(user);
        uint256 feeCollectorUsdcBefore = IERC20(USDC).balanceOf(address(feeCollector));

        vm.prank(user);
        router.sweepDustMultiHop(orders, USDC, user, DEADLINE);

        uint256 usdcReceived = IERC20(USDC).balanceOf(user) - usdcBefore;
        uint256 feeReceived = IERC20(USDC).balanceOf(address(feeCollector)) - feeCollectorUsdcBefore;

        assertGt(usdcReceived, 0, "User should receive USDC from multi-hop");
        assertGt(feeReceived, 0, "FeeCollector should receive fee from multi-hop");

        // Verify 2% fee
        uint256 totalOutput = usdcReceived + feeReceived;
        uint256 expectedFee = (totalOutput * 200) / 10_000;
        assertApproxEqAbs(feeReceived, expectedFee, 1, "Fee should be ~2%");
    }

    function test_sweepDustMultiHopToETH() public {
        _getToken(USDC, user, 0.05 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        _approveRouter(USDC, user, usdcBalance);

        // Path: USDC -> (500 fee) -> WETH (end must be WETH for ETH output)
        bytes memory path = abi.encodePacked(USDC, uint24(500), WETH);

        DustSweepRouter.MultiHopSwapOrder[] memory orders = new DustSweepRouter.MultiHopSwapOrder[](1);
        orders[0] = DustSweepRouter.MultiHopSwapOrder({
            tokenIn: USDC,
            amountIn: usdcBalance,
            path: path,
            minAmountOut: 0
        });

        uint256 ethBefore = user.balance;

        vm.prank(user);
        router.sweepDustMultiHopToETH(orders, user, DEADLINE);

        uint256 ethReceived = user.balance - ethBefore;
        assertGt(ethReceived, 0, "User should receive ETH from multi-hop");
    }

    // ======================= singleSwap ====================

    function test_singleSwap() public {
        _getToken(USDC, user, 0.1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        _approveRouter(USDC, user, usdcBalance);

        uint256 wethBefore = IERC20(WETH).balanceOf(user);
        uint256 feeCollectorBefore = IERC20(WETH).balanceOf(address(feeCollector));

        vm.prank(user);
        router.singleSwap(USDC, usdcBalance, WETH, 500, 0, user, DEADLINE);

        uint256 wethReceived = IERC20(WETH).balanceOf(user) - wethBefore;
        uint256 feeReceived = IERC20(WETH).balanceOf(address(feeCollector)) - feeCollectorBefore;

        assertGt(wethReceived, 0, "User should receive WETH from single swap");
        assertGt(feeReceived, 0, "FeeCollector should receive single swap fee");

        // Verify 0.1% fee
        uint256 totalOutput = wethReceived + feeReceived;
        uint256 expectedFee = (totalOutput * 10) / 10_000;
        assertApproxEqAbs(feeReceived, expectedFee, 1, "Fee should be ~0.1%");
    }

    // ======================= swapETHForTokens ==============

    function test_swapETHForTokens() public {
        uint256 usdcBefore = IERC20(USDC).balanceOf(user);
        uint256 feeCollectorBefore = IERC20(USDC).balanceOf(address(feeCollector));

        vm.prank(user);
        router.swapETHForTokens{value: 0.01 ether}(USDC, 500, 0, user, DEADLINE);

        uint256 usdcReceived = IERC20(USDC).balanceOf(user) - usdcBefore;
        uint256 feeReceived = IERC20(USDC).balanceOf(address(feeCollector)) - feeCollectorBefore;

        assertGt(usdcReceived, 0, "User should receive USDC");
        assertGt(feeReceived, 0, "FeeCollector should receive fee");

        // Verify 0.1% fee
        uint256 totalOutput = usdcReceived + feeReceived;
        uint256 expectedFee = (totalOutput * 10) / 10_000;
        assertApproxEqAbs(feeReceived, expectedFee, 1, "Fee should be ~0.1%");
    }

    // ======================= swapTokensForETH ==============

    function test_swapTokensForETH() public {
        _getToken(USDC, user, 0.05 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        _approveRouter(USDC, user, usdcBalance);

        uint256 ethBefore = user.balance;
        uint256 feeCollectorWethBefore = IERC20(WETH).balanceOf(address(feeCollector));

        vm.prank(user);
        router.swapTokensForETH(USDC, usdcBalance, 500, 0, user, DEADLINE);

        uint256 ethReceived = user.balance - ethBefore;
        uint256 feeReceived = IERC20(WETH).balanceOf(address(feeCollector)) - feeCollectorWethBefore;

        assertGt(ethReceived, 0, "User should receive ETH");
        assertGt(feeReceived, 0, "FeeCollector should receive WETH fee");
    }

    // ======================= PAUSE =========================

    function test_pause_blocksSweepDust() public {
        vm.prank(owner);
        router.pause();

        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](1);
        orders[0] = DustSweepRouter.SwapOrder({
            tokenIn: USDC,
            amountIn: 1_000_000,
            poolFee: 500,
            minAmountOut: 0
        });

        vm.prank(user);
        vm.expectRevert(); // EnforcedPause
        router.sweepDust(orders, WETH, user, DEADLINE);
    }

    function test_unpause_allowsSweepDust() public {
        vm.prank(owner);
        router.pause();

        vm.prank(owner);
        router.unpause();

        // Should not revert now (will revert for other reasons like no approval, but not Paused)
        _getToken(USDC, user, 0.01 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        _approveRouter(USDC, user, usdcBalance);

        DustSweepRouter.SwapOrder[] memory orders = new DustSweepRouter.SwapOrder[](1);
        orders[0] = DustSweepRouter.SwapOrder({
            tokenIn: USDC,
            amountIn: usdcBalance,
            poolFee: 500,
            minAmountOut: 0
        });

        vm.prank(user);
        router.sweepDust(orders, WETH, user, DEADLINE);

        assertGt(IERC20(WETH).balanceOf(user), 0, "Sweep should work after unpause");
    }

    function test_pause_onlyOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        router.pause();
    }

    // ======================= FEE CALCULATIONS ==============

    function test_feeCalculation_dustSweep() public view {
        assertEq(router.dustSweepFeeBps(), 200);

        uint256 totalOutput = 10_000;
        uint256 fee = (totalOutput * router.dustSweepFeeBps()) / router.BPS_DENOMINATOR();
        assertEq(fee, 200, "2% of 10000 should be 200");
    }

    function test_feeCalculation_singleSwap() public view {
        assertEq(router.swapFeeBps(), 10);

        uint256 totalOutput = 10_000;
        uint256 fee = (totalOutput * router.swapFeeBps()) / router.BPS_DENOMINATOR();
        assertEq(fee, 10, "0.1% of 10000 should be 10");
    }

    // ======================= BUILDER CODE ==================

    function test_builderCode() public view {
        string memory code = router.BUILDER_CODE();
        assertEq(keccak256(bytes(code)), keccak256(bytes("bc_ox7237gv")));
    }

    // ======================= ADMIN =========================

    function test_setDustSweepFeeBps_onlyOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        router.setDustSweepFeeBps(300);

        vm.prank(owner);
        router.setDustSweepFeeBps(300);
        assertEq(router.dustSweepFeeBps(), 300);
    }

    function test_setDustSweepFeeBps_cannotExceedMax() public {
        vm.prank(owner);
        vm.expectRevert(DustSweepRouter.FeeTooHigh.selector);
        router.setDustSweepFeeBps(501);
    }

    function test_setSwapFeeBps_onlyOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        router.setSwapFeeBps(50);

        vm.prank(owner);
        router.setSwapFeeBps(50);
        assertEq(router.swapFeeBps(), 50);
    }

    function test_setSwapFeeBps_cannotExceedMax() public {
        vm.prank(owner);
        vm.expectRevert(DustSweepRouter.FeeTooHigh.selector);
        router.setSwapFeeBps(101);
    }

    function test_setFeeCollector_onlyOwner() public {
        address newCollector = makeAddr("newCollector");

        vm.prank(nonOwner);
        vm.expectRevert();
        router.setFeeCollector(newCollector);

        vm.prank(owner);
        router.setFeeCollector(newCollector);
        assertEq(router.feeCollector(), newCollector);
    }

    function test_setFeeCollector_cannotBeZero() public {
        vm.prank(owner);
        vm.expectRevert(DustSweepRouter.ZeroAddress.selector);
        router.setFeeCollector(address(0));
    }

    function test_rescueTokens_onlyOwner() public {
        vm.deal(address(router), 1 ether);

        _getToken(USDC, address(router), 0.01 ether);
        uint256 stuckBalance = IERC20(USDC).balanceOf(address(router));
        assertGt(stuckBalance, 0);

        vm.prank(nonOwner);
        vm.expectRevert();
        router.rescueTokens(USDC, stuckBalance);

        uint256 ownerBefore = IERC20(USDC).balanceOf(owner);

        vm.prank(owner);
        router.rescueTokens(USDC, stuckBalance);

        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "Router should have 0 USDC");
        assertEq(
            IERC20(USDC).balanceOf(owner),
            ownerBefore + stuckBalance,
            "Owner should receive rescued tokens"
        );
    }
}
