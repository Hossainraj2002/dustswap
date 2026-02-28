// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {FeeCollector}     from "../src/FeeCollector.sol";
import {BurnVault}        from "../src/BurnVault.sol";
import {DustSweepRouter}  from "../src/DustSweepRouter.sol";
import {ERC20}            from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─── Mock token ──────────────────────────────────────────────────────────────
contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

// ─── Mock Uniswap Router ─────────────────────────────────────────────────────
/// Simulates a successful 1:1 swap for testing
contract MockUniswap {
    function swap(address tokenIn, address tokenOut, uint256 amount, address recipient) external {
        ERC20(tokenIn).transferFrom(msg.sender, address(this), amount);
        MockERC20(tokenOut).mint(recipient, amount);
    }
}

// ─── FeeCollector Tests ──────────────────────────────────────────────────────
contract FeeCollectorTest is Test {
    FeeCollector fee;
    address treasury = makeAddr("treasury");
    address owner    = makeAddr("owner");

    function setUp() public {
        vm.prank(owner);
        fee = new FeeCollector(treasury);
    }

    function test_TreasurySet() public view { assertEq(fee.treasury(), treasury); }
    function test_OwnerSet()    public view { assertEq(fee.owner(), owner); }

    function test_ReceivesETH() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(fee).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(fee).balance, 1 ether);
    }

    function test_OwnerWithdrawsETH() public {
        vm.deal(address(fee), 1 ether);
        vm.prank(owner);
        fee.withdrawETH();
        assertEq(treasury.balance, 1 ether);
    }

    function test_NonOwnerCannotWithdraw() public {
        vm.deal(address(fee), 1 ether);
        vm.prank(makeAddr("hacker"));
        vm.expectRevert();
        fee.withdrawETH();
    }
}

// ─── BurnVault Tests ─────────────────────────────────────────────────────────
contract BurnVaultTest is Test {
    BurnVault vault;
    MockERC20 tokenA;
    MockERC20 tokenB;
    address user = makeAddr("user");

    function setUp() public {
        vault  = new BurnVault();
        tokenA = new MockERC20("TokenA", "TA");
        tokenB = new MockERC20("TokenB", "TB");
        tokenA.mint(user, 10_000);
        tokenB.mint(user, 10_000);
        vm.startPrank(user);
        tokenA.approve(address(vault), type(uint256).max);
        tokenB.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function test_BurnTwoTokens() public {
        address[] memory tokens  = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(tokenA); amounts[0] = 1_000;
        tokens[1] = address(tokenB); amounts[1] = 2_000;

        vm.prank(user);
        bytes32 burnId = vault.burnTokens(tokens, amounts);

        assertEq(tokenA.balanceOf(address(vault)), 1_000);
        assertEq(tokenB.balanceOf(address(vault)), 2_000);

        (address u,,, bool reclaimed,) = vault.getBurnRecord(burnId);
        assertEq(u, user);
        assertFalse(reclaimed);
    }

    function test_ReclaimWithTax() public {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(tokenA); amounts[0] = 1_000;

        vm.prank(user);
        bytes32 burnId = vault.burnTokens(tokens, amounts);

        uint256 balBefore = tokenA.balanceOf(user);
        vm.prank(user);
        vault.reclaimTokens(burnId);

        // 10% tax: user should receive 900
        assertEq(tokenA.balanceOf(user) - balBefore, 900);
    }

    function test_CannotReclaimTwice() public {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = address(tokenA); amounts[0] = 500;

        vm.prank(user);
        bytes32 burnId = vault.burnTokens(tokens, amounts);
        vm.prank(user);
        vault.reclaimTokens(burnId);
        vm.prank(user);
        vm.expectRevert("BurnVault: already reclaimed");
        vault.reclaimTokens(burnId);
    }
}

// ─── DustSweepRouter Tests ───────────────────────────────────────────────────
contract DustSweepRouterTest is Test {
    DustSweepRouter router;
    FeeCollector    feeCollector;
    MockERC20       dustA;
    MockERC20       dustB;
    MockERC20       outputToken;
    address         treasury = makeAddr("treasury");
    address         user     = makeAddr("user");

    function setUp() public {
        feeCollector = new FeeCollector(treasury);
        // Router with zero-address uniswap so we can test non-swap paths
        router       = new DustSweepRouter(address(1), address(feeCollector));
        dustA        = new MockERC20("DustA", "DA");
        dustB        = new MockERC20("DustB", "DB");
        outputToken  = new MockERC20("USDC",  "USDC");
        dustA.mint(user, 1_000);
        dustB.mint(user, 2_000);
    }

    function test_DefaultFees() public view {
        assertEq(router.sweepFeeBps(), 100);
        assertEq(router.swapFeeBps(),  30);
    }

    function test_PauseBlocks() public {
        router.setPause(true);
        address[] memory t = new address[](1); t[0] = address(dustA);
        uint256[] memory a = new uint256[](1); a[0] = 100;
        bytes[] memory c   = new bytes[](1);
        DustSweepRouter.SweepParams memory p = DustSweepRouter.SweepParams(t, a, address(outputToken), 0, c);
        vm.prank(user);
        vm.expectRevert("DustSweepRouter: paused");
        router.sweepDust(p);
    }

    function test_MaxBatchEnforced() public {
        address[] memory t = new address[](26);
        uint256[] memory a = new uint256[](26);
        bytes[] memory c   = new bytes[](26);
        DustSweepRouter.SweepParams memory p = DustSweepRouter.SweepParams(t, a, address(outputToken), 0, c);
        vm.prank(user);
        vm.expectRevert("DustSweepRouter: too many tokens");
        router.sweepDust(p);
    }

    function test_FeeCap() public {
        vm.expectRevert("DustSweepRouter: fee too high");
        router.setSweepFee(600); // 6% > 5% cap
    }

    function test_NonOwnerCannotSetFee() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert();
        router.setSweepFee(50);
    }
}
