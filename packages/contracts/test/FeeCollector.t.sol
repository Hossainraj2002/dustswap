// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeCollector} from "../src/FeeCollector.sol";

/// @title FeeCollector Tests — Base Mainnet Fork
contract FeeCollectorTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    FeeCollector public feeCollector;

    address public owner;
    address public treasury;
    address public nonOwner;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_MAINNET_RPC_URL"), 25_000_000);

        owner = makeAddr("owner");
        treasury = makeAddr("treasury");
        nonOwner = makeAddr("nonOwner");

        vm.deal(owner, 10 ether);

        vm.prank(owner);
        feeCollector = new FeeCollector(treasury, owner);
    }

    // ═══════════════════════ Constructor ═══════════════════

    function test_constructor_setsTreasury() public view {
        assertEq(feeCollector.treasury(), treasury);
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.prank(owner);
        vm.expectRevert(FeeCollector.ZeroAddress.selector);
        new FeeCollector(address(0), owner);
    }

    // ═══════════════════════ Receive ETH ═══════════════════

    function test_receiveETH() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(feeCollector).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(feeCollector).balance, 1 ether);
    }

    // ═══════════════════════ withdrawETH ═══════════════════

    function test_withdrawETH() public {
        vm.deal(address(feeCollector), 5 ether);
        uint256 treasuryBefore = treasury.balance;

        vm.prank(owner);
        feeCollector.withdrawETH();

        assertEq(address(feeCollector).balance, 0);
        assertEq(treasury.balance, treasuryBefore + 5 ether);
    }

    function test_withdrawETH_revertsIfEmpty() public {
        vm.prank(owner);
        vm.expectRevert(FeeCollector.ZeroAmount.selector);
        feeCollector.withdrawETH();
    }

    function test_withdrawETH_onlyOwner() public {
        vm.deal(address(feeCollector), 1 ether);

        vm.prank(nonOwner);
        vm.expectRevert();
        feeCollector.withdrawETH();
    }

    // ═══════════════════════ withdrawToken ═════════════════

    function test_withdrawToken() public {
        // Send USDC directly to fee collector (simulating fee receipt)
        _sendUSDCToFeeCollector(0.1 ether);
        uint256 balance = IERC20(USDC).balanceOf(address(feeCollector));
        assertGt(balance, 0);

        vm.prank(owner);
        feeCollector.withdrawToken(USDC, balance);

        assertEq(IERC20(USDC).balanceOf(address(feeCollector)), 0);
        assertEq(IERC20(USDC).balanceOf(treasury), balance);
    }

    function test_withdrawToken_onlyOwner() public {
        _sendUSDCToFeeCollector(0.01 ether);
        uint256 balance = IERC20(USDC).balanceOf(address(feeCollector));

        vm.prank(nonOwner);
        vm.expectRevert();
        feeCollector.withdrawToken(USDC, balance);
    }

    // ═══════════════════════ sweepToTreasury ═══════════════

    function test_sweepToTreasury() public {
        _sendUSDCToFeeCollector(0.1 ether);
        uint256 usdcBalance = IERC20(USDC).balanceOf(address(feeCollector));
        assertGt(usdcBalance, 0);

        address[] memory tokens = new address[](1);
        tokens[0] = USDC;

        vm.prank(owner);
        feeCollector.sweepToTreasury(tokens);

        assertEq(IERC20(USDC).balanceOf(address(feeCollector)), 0);
        assertEq(IERC20(USDC).balanceOf(treasury), usdcBalance);
    }

    function test_sweepToTreasury_revertsOnEmpty() public {
        address[] memory tokens = new address[](0);

        vm.prank(owner);
        vm.expectRevert(FeeCollector.EmptyArray.selector);
        feeCollector.sweepToTreasury(tokens);
    }

    function test_sweepToTreasury_onlyOwner() public {
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;

        vm.prank(nonOwner);
        vm.expectRevert();
        feeCollector.sweepToTreasury(tokens);
    }

    // ═══════════════════════ setTreasury ═══════════════════

    function test_setTreasury() public {
        address newTreasury = makeAddr("newTreasury");

        vm.prank(owner);
        feeCollector.setTreasury(newTreasury);
        assertEq(feeCollector.treasury(), newTreasury);
    }

    function test_setTreasury_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(FeeCollector.ZeroAddress.selector);
        feeCollector.setTreasury(address(0));
    }

    function test_setTreasury_onlyOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        feeCollector.setTreasury(makeAddr("newTreasury"));
    }

    // ═══════════════════════ HELPERS ═══════════════════════

    function _sendUSDCToFeeCollector(uint256 ethAmount) internal {
        address temp = makeAddr("temp");
        vm.deal(temp, ethAmount);

        vm.startPrank(temp);
        (bool success,) = WETH.call{value: ethAmount}("");
        require(success);

        IERC20(WETH).approve(0x2626664c2603336E57B271c5C0b26F421741e481, ethAmount);

        bytes memory data = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH,
            USDC,
            uint24(500),
            address(feeCollector),
            ethAmount,
            uint256(0),
            uint160(0)
        );
        (success,) = 0x2626664c2603336E57B271c5C0b26F421741e481.call(data);
        require(success, "Swap to USDC failed");
        vm.stopPrank();
    }
}