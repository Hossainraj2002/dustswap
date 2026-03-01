// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {BurnVault} from "../src/BurnVault.sol";

/// @title BurnVault Tests — Base Mainnet Fork
/// @dev   Run:  forge test --match-contract BurnVaultTest --fork-url $BASE_MAINNET_RPC_URL -vvv
contract BurnVaultTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    FeeCollector public feeCollector;
    BurnVault public burnVault;

    address public owner;
    address public treasury;
    address public user;
    address public attacker;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_MAINNET_RPC_URL"), 25_000_000);

        owner = makeAddr("owner");
        treasury = makeAddr("treasury");
        user = makeAddr("user");
        attacker = makeAddr("attacker");

        vm.deal(user, 100 ether);
        vm.deal(attacker, 10 ether);

        vm.startPrank(owner);
        feeCollector = new FeeCollector(treasury, owner);
        burnVault = new BurnVault(address(feeCollector), owner);
        vm.stopPrank();
    }

    // ═══════════════════════ HELPERS ═══════════════════════

    function _getUSDC(address to, uint256 ethAmount) internal {
        vm.startPrank(to);
        (bool success,) = WETH.call{value: ethAmount}("");
        require(success, "WETH deposit failed");

        IERC20(WETH).approve(UNISWAP_ROUTER, ethAmount);

        bytes memory data = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH,
            USDC,
            uint24(500),
            to,
            ethAmount,
            uint256(0),
            uint160(0)
        );
        (success,) = UNISWAP_ROUTER.call(data);
        require(success, "Swap failed");
        vm.stopPrank();
    }

    // ═══════════════════════ burnTokens ════════════════════

    function test_burnTokens_single() public {
        _getUSDC(user, 0.1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        assertGt(usdcBalance, 0);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = usdcBalance;

        vm.startPrank(user);
        IERC20(USDC).approve(address(burnVault), usdcBalance);
        burnVault.burnTokens(tokens, amounts);
        vm.stopPrank();

        assertEq(IERC20(USDC).balanceOf(user), 0, "User USDC should be 0 after burn");
        assertEq(IERC20(USDC).balanceOf(address(burnVault)), usdcBalance, "Vault should hold USDC");

        // Verify record
        uint256[] memory ids = burnVault.getUserBurnIds(user);
        assertEq(ids.length, 1, "Should have 1 burn record");
        assertEq(ids[0], 0, "First record ID should be 0");

        BurnVault.BurnRecord memory record = burnVault.getBurnRecord(0);
        assertEq(record.burner, user);
        assertEq(record.token, USDC);
        assertEq(record.amount, usdcBalance);
        assertFalse(record.reclaimed);
    }

    function test_burnTokens_multiple() public {
        _getUSDC(user, 0.5 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);
        uint256 half = usdcBalance / 2;

        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = USDC;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = half;
        amounts[1] = usdcBalance - half;

        vm.startPrank(user);
        IERC20(USDC).approve(address(burnVault), usdcBalance);
        burnVault.burnTokens(tokens, amounts);
        vm.stopPrank();

        uint256[] memory ids = burnVault.getUserBurnIds(user);
        assertEq(ids.length, 2, "Should have 2 burn records");

        BurnVault.BurnRecord[] memory records = burnVault.getUserBurnRecords(user);
        assertEq(records.length, 2);
        assertEq(records[0].amount, half);
        assertEq(records[1].amount, usdcBalance - half);
    }

    function test_burnTokens_revertsOnMismatchedArrays() public {
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1000;

        vm.prank(user);
        vm.expectRevert(BurnVault.ArrayLengthMismatch.selector);
        burnVault.burnTokens(tokens, amounts);
    }

    function test_burnTokens_revertsOnEmptyArray() public {
        address[] memory tokens = new address[](0);
        uint256[] memory amounts = new uint256[](0);

        vm.prank(user);
        vm.expectRevert(BurnVault.EmptyArray.selector);
        burnVault.burnTokens(tokens, amounts);
    }

    function test_burnTokens_revertsOnZeroAmount() public {
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0;

        vm.prank(user);
        vm.expectRevert(BurnVault.ZeroAmount.selector);
        burnVault.burnTokens(tokens, amounts);
    }

    // ═══════════════════════ reclaimToken ══════════════════

    function test_reclaimToken_success() public {
        _getUSDC(user, 0.1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = usdcBalance;

        vm.startPrank(user);
        IERC20(USDC).approve(address(burnVault), usdcBalance);
        burnVault.burnTokens(tokens, amounts);

        // Reclaim record 0
        burnVault.reclaimToken(0);
        vm.stopPrank();

        // 10% tax → feeCollector, 90% → user
        uint256 expectedTax = (usdcBalance * 1_000) / 10_000; // 10%
        uint256 expectedReturn = usdcBalance - expectedTax;

        assertEq(
            IERC20(USDC).balanceOf(user),
            expectedReturn,
            "User should receive 90%"
        );
        assertEq(
            IERC20(USDC).balanceOf(address(feeCollector)),
            expectedTax,
            "FeeCollector should receive 10% tax"
        );

        // Record should be marked reclaimed
        BurnVault.BurnRecord memory record = burnVault.getBurnRecord(0);
        assertTrue(record.reclaimed);
    }

    function test_reclaimToken_verifyTaxMath() public {
        _getUSDC(user, 1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = usdcBalance;

        vm.startPrank(user);
        IERC20(USDC).approve(address(burnVault), usdcBalance);
        burnVault.burnTokens(tokens, amounts);
        burnVault.reclaimToken(0);
        vm.stopPrank();

        uint256 userReceived = IERC20(USDC).balanceOf(user);
        uint256 collectorReceived = IERC20(USDC).balanceOf(address(feeCollector));
        uint256 total = userReceived + collectorReceived;

        // Total should equal original burn amount (no rounding beyond 1 wei)
        assertApproxEqAbs(total, usdcBalance, 1, "Total should equal original amount");

        // Tax should be 10%
        uint256 expectedTax = (usdcBalance * 1_000) / 10_000;
        assertApproxEqAbs(collectorReceived, expectedTax, 1, "Tax should be 10%");
    }

    // ═══════════════════════ reclaimToken — access control ═

    function test_reclaimToken_revertsIfNotBurner() public {
        _getUSDC(user, 0.1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = usdcBalance;

        vm.startPrank(user);
        IERC20(USDC).approve(address(burnVault), usdcBalance);
        burnVault.burnTokens(tokens, amounts);
        vm.stopPrank();

        // Attacker tries to reclaim user's burn
        vm.prank(attacker);
        vm.expectRevert(BurnVault.NotBurner.selector);
        burnVault.reclaimToken(0);
    }

    function test_reclaimToken_revertsOnDoubleReclaim() public {
        _getUSDC(user, 0.1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(user);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = usdcBalance;

        vm.startPrank(user);
        IERC20(USDC).approve(address(burnVault), usdcBalance);
        burnVault.burnTokens(tokens, amounts);

        // First reclaim succeeds
        burnVault.reclaimToken(0);

        // Second reclaim reverts
        vm.expectRevert(BurnVault.AlreadyReclaimed.selector);
        burnVault.reclaimToken(0);
        vm.stopPrank();
    }

    function test_reclaimToken_revertsOnNonexistentRecord() public {
        vm.prank(user);
        vm.expectRevert(BurnVault.RecordDoesNotExist.selector);
        burnVault.reclaimToken(999);
    }

    // ═══════════════════════ ADMIN ═════════════════════════

    function test_setReclaimTaxBps_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        burnVault.setReclaimTaxBps(500);

        vm.prank(owner);
        burnVault.setReclaimTaxBps(500);
        assertEq(burnVault.reclaimTaxBps(), 500);
    }

    function test_setReclaimTaxBps_cannotExceedMax() public {
        vm.prank(owner);
        vm.expectRevert(BurnVault.TaxTooHigh.selector);
        burnVault.setReclaimTaxBps(5_001);
    }

    function test_setFeeCollector_onlyOwner() public {
        address newCollector = makeAddr("newCollector");

        vm.prank(attacker);
        vm.expectRevert();
        burnVault.setFeeCollector(newCollector);

        vm.prank(owner);
        burnVault.setFeeCollector(newCollector);
        assertEq(burnVault.feeCollector(), newCollector);
    }

    function test_setFeeCollector_cannotBeZero() public {
        vm.prank(owner);
        vm.expectRevert(BurnVault.ZeroAddress.selector);
        burnVault.setFeeCollector(address(0));
    }

    // ═══════════════════════ VIEW FUNCTIONS ════════════════

    function test_getUserBurnRecords_empty() public view {
        BurnVault.BurnRecord[] memory records = burnVault.getUserBurnRecords(user);
        assertEq(records.length, 0);
    }

    function test_getUserBurnIds_empty() public view {
        uint256[] memory ids = burnVault.getUserBurnIds(user);
        assertEq(ids.length, 0);
    }
}