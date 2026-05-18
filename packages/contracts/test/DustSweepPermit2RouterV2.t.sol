// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    DustSweepPermit2RouterV2,
    ISignatureTransfer
} from "../src/DustSweepPermit2RouterV2.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPermit2 is ISignatureTransfer {
    using SafeERC20 for IERC20;

    bytes32 public expectedWitness;
    mapping(address owner => mapping(address spender => mapping(address token => uint160 amount))) public allowance;

    error BadWitness();
    error BadPermitLength();
    error BadRequestedAmount();
    error InsufficientAllowance();

    function setExpectedWitness(bytes32 witness) external {
        expectedWitness = witness;
    }

    function permitWitnessTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata,
        bytes calldata
    ) external override {
        if (witness != expectedWitness) revert BadWitness();
        if (permit.permitted.length != transferDetails.length) revert BadPermitLength();

        for (uint256 i; i < permit.permitted.length;) {
            if (transferDetails[i].requestedAmount > permit.permitted[i].amount) {
                revert BadRequestedAmount();
            }

            IERC20(permit.permitted[i].token).safeTransferFrom(
                owner,
                transferDetails[i].to,
                transferDetails[i].requestedAmount
            );

            unchecked {
                ++i;
            }
        }
    }

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[msg.sender][spender][token] = amount;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint160 currentAllowance = allowance[from][msg.sender][token];
        if (currentAllowance < amount) revert InsufficientAllowance();

        allowance[from][msg.sender][token] = currentAllowance - amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}

contract MockSwapTarget {
    using SafeERC20 for IERC20;

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external payable {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function swapNoOutput(address tokenIn, uint256 amountIn) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
    }
}

contract MockPermit2SwapTarget {
    function swapViaPermit2(
        address permit2,
        address tokenIn,
        address tokenOut,
        uint160 amountIn,
        uint256 amountOut
    ) external {
        MockPermit2(permit2).transferFrom(msg.sender, address(this), amountIn, tokenIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

contract DustSweepPermit2RouterV2Test is Test {
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    MockERC20 internal outputToken;
    MockPermit2 internal permit2;
    MockSwapTarget internal target;
    MockPermit2SwapTarget internal permit2Target;
    DustSweepPermit2RouterV2 internal router;

    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");
    address internal receiver = makeAddr("receiver");
    address internal feeCollector = makeAddr("feeCollector");
    address internal nonOwner = makeAddr("nonOwner");

    uint256 internal constant DEADLINE = 2_000_000_000;

    function setUp() public {
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        outputToken = new MockERC20("USD Coin", "USDC", 6);
        permit2 = new MockPermit2();
        target = new MockSwapTarget();
        permit2Target = new MockPermit2SwapTarget();

        router = new DustSweepPermit2RouterV2(address(permit2), owner, feeCollector, 60);

        vm.startPrank(owner);
        router.setAllowedTarget(address(target), true);
        router.setAllowedTarget(address(permit2Target), true);
        router.setAllowedSpender(address(target), true);
        router.setAllowedSpender(address(permit2), true);
        vm.stopPrank();

        tokenA.mint(user, 1_000 ether);
        tokenB.mint(user, 1_000 ether);

        vm.startPrank(user);
        tokenA.approve(address(permit2), type(uint256).max);
        tokenB.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    function test_feeBpsCannotExceedMax() public {
        vm.prank(owner);
        vm.expectRevert(DustSweepPermit2RouterV2.FeeTooHigh.selector);
        router.setFeeBps(router.MAX_FEE_BPS() + 1);
    }

    function test_onlyOwnerCanSetFee() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        router.setFeeBps(100);

        vm.prank(owner);
        router.setFeeBps(100);

        assertEq(router.feeBps(), 100);
    }

    function test_onlyOwnerCanAllowTargetAndSpender() public {
        address nextTarget = makeAddr("nextTarget");
        address nextSpender = makeAddr("nextSpender");

        vm.prank(nonOwner);
        vm.expectRevert();
        router.setAllowedTarget(nextTarget, true);

        vm.prank(nonOwner);
        vm.expectRevert();
        router.setAllowedSpender(nextSpender, true);

        vm.startPrank(owner);
        router.setAllowedTarget(nextTarget, true);
        router.setAllowedSpender(nextSpender, true);
        vm.stopPrank();

        assertTrue(router.allowedTargets(nextTarget));
        assertTrue(router.allowedSpenders(nextSpender));
    }

    function test_sweepRejectsTooManyRoutes() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = new DustSweepPermit2RouterV2.SweepRoute[](51);
        ISignatureTransfer.TokenPermissions[] memory permissions = new ISignatureTransfer.TokenPermissions[](0);
        ISignatureTransfer.PermitBatchTransferFrom memory permit =
            ISignatureTransfer.PermitBatchTransferFrom({permitted: permissions, nonce: 1, deadline: DEADLINE});

        vm.prank(user);
        vm.expectRevert(DustSweepPermit2RouterV2.BatchTooLarge.selector);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepRejectsExpiredDeadline() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, block.timestamp - 1);

        vm.prank(user);
        vm.expectRevert(DustSweepPermit2RouterV2.DeadlineExpired.selector);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, block.timestamp - 1, permit, "signature");
    }

    function test_sweepRejectsNonAllowlistedTarget() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        routes[0].target = makeAddr("blockedTarget");
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DustSweepPermit2RouterV2.TargetNotAllowed.selector, routes[0].target));
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepRejectsNonAllowlistedSpender() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        routes[0].spender = makeAddr("blockedSpender");
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DustSweepPermit2RouterV2.SpenderNotAllowed.selector, routes[0].spender));
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepRejectsWrongWitnessRouteHash() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);

        permit2.setExpectedWitness(bytes32(uint256(1)));

        vm.prank(user);
        vm.expectRevert(MockPermit2.BadWitness.selector);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepRejectsMismatchedPermitTokenList() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);
        permit.permitted[0].token = address(tokenB);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DustSweepPermit2RouterV2.PermitTokenMismatch.selector, 0));
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepRejectsMismatchedPermitAmount() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);
        permit.permitted[0].amount = 0.5 ether;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DustSweepPermit2RouterV2.PermitAmountMismatch.selector, 0));
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepRejectsMalformedRouteData() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        routes[0].data = hex"123456";
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DustSweepPermit2RouterV2.MalformedRouteData.selector, 0));
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function test_sweepTransfersFeeAndNetOutput() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(10 ether, 1_000_000);
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);
        _expectWitness(routes, address(outputToken), receiver, 900_000, DEADLINE);

        vm.prank(user);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 900_000, DEADLINE, permit, "signature");

        assertEq(outputToken.balanceOf(feeCollector), 6_000);
        assertEq(outputToken.balanceOf(receiver), 994_000);
        assertEq(tokenA.balanceOf(address(target)), 10 ether);
    }

    function test_sweepTransfersMultipleInputs() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = new DustSweepPermit2RouterV2.SweepRoute[](2);
        routes[0] = _route(address(tokenA), 4 ether, 500_000);
        routes[1] = _route(address(tokenB), 6 ether, 700_000);
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);
        _expectWitness(routes, address(outputToken), receiver, 1_000_000, DEADLINE);

        vm.prank(user);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1_000_000, DEADLINE, permit, "signature");

        assertEq(outputToken.balanceOf(feeCollector), 7_200);
        assertEq(outputToken.balanceOf(receiver), 1_192_800);
        assertEq(tokenA.balanceOf(address(target)), 4 ether);
        assertEq(tokenB.balanceOf(address(target)), 6 ether);
    }

    function test_sweepWithAllowanceTransfersMultipleInputs() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = new DustSweepPermit2RouterV2.SweepRoute[](2);
        routes[0] = _route(address(tokenA), 4 ether, 500_000);
        routes[1] = _route(address(tokenB), 6 ether, 700_000);

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        tokenB.approve(address(router), 6 ether);
        router.sweepWithAllowance(routes, address(outputToken), receiver, 1_000_000, DEADLINE);
        vm.stopPrank();

        assertEq(outputToken.balanceOf(feeCollector), 7_200);
        assertEq(outputToken.balanceOf(receiver), 1_192_800);
        assertEq(tokenA.balanceOf(address(target)), 4 ether);
        assertEq(tokenB.balanceOf(address(target)), 6 ether);
        assertEq(tokenA.allowance(address(router), address(target)), 0);
        assertEq(tokenB.allowance(address(router), address(target)), 0);
    }

    function test_sweepSupportsPermit2AllowanceSpenderRoutes() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = new DustSweepPermit2RouterV2.SweepRoute[](1);
        routes[0] = DustSweepPermit2RouterV2.SweepRoute({
            tokenIn: address(tokenA),
            amountIn: 10 ether,
            target: address(permit2Target),
            spender: address(permit2),
            value: 0,
            data: abi.encodeCall(
                MockPermit2SwapTarget.swapViaPermit2,
                (address(permit2), address(tokenA), address(outputToken), uint160(10 ether), 1_000_000)
            )
        });
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);
        _expectWitness(routes, address(outputToken), receiver, 900_000, DEADLINE);

        vm.prank(user);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 900_000, DEADLINE, permit, "signature");

        assertEq(outputToken.balanceOf(feeCollector), 6_000);
        assertEq(outputToken.balanceOf(receiver), 994_000);
        assertEq(tokenA.balanceOf(address(permit2Target)), 10 ether);
        assertEq(permit2.allowance(address(router), address(permit2Target), address(tokenA)), 0);
        assertEq(tokenA.allowance(address(router), address(permit2)), 0);
    }

    function test_rescueERC20WorksOnlyOwner() public {
        outputToken.mint(address(router), 123);

        vm.prank(nonOwner);
        vm.expectRevert();
        router.rescueERC20(address(outputToken), receiver, 123);

        vm.prank(owner);
        router.rescueERC20(address(outputToken), receiver, 123);

        assertEq(outputToken.balanceOf(receiver), 123);
    }

    function test_rescueNativeWorksOnlyOwner() public {
        vm.deal(address(router), 1 ether);
        uint256 beforeBalance = receiver.balance;

        vm.prank(nonOwner);
        vm.expectRevert();
        router.rescueNative(payable(receiver), 0.25 ether);

        vm.prank(owner);
        router.rescueNative(payable(receiver), 0.25 ether);

        assertEq(receiver.balance, beforeBalance + 0.25 ether);
    }

    function test_nativeEthIsNotTreatedAsErc20Input() public {
        DustSweepPermit2RouterV2.SweepRoute[] memory routes = _routes(1 ether, 1_000_000);
        routes[0].tokenIn = router.NATIVE_TOKEN_SENTINEL();
        ISignatureTransfer.PermitBatchTransferFrom memory permit = _permit(routes, DEADLINE);

        vm.prank(user);
        vm.expectRevert(DustSweepPermit2RouterV2.NativeInputUnsupported.selector);
        router.sweepWithPermit2(routes, address(outputToken), receiver, 1, DEADLINE, permit, "signature");
    }

    function _routes(
        uint256 amountIn,
        uint256 amountOut
    ) internal view returns (DustSweepPermit2RouterV2.SweepRoute[] memory routes) {
        routes = new DustSweepPermit2RouterV2.SweepRoute[](1);
        routes[0] = _route(address(tokenA), amountIn, amountOut);
    }

    function _route(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    ) internal view returns (DustSweepPermit2RouterV2.SweepRoute memory) {
        return DustSweepPermit2RouterV2.SweepRoute({
            tokenIn: tokenIn,
            amountIn: amountIn,
            target: address(target),
            spender: address(target),
            value: 0,
            data: abi.encodeCall(MockSwapTarget.swap, (tokenIn, address(outputToken), amountIn, amountOut))
        });
    }

    function _permit(
        DustSweepPermit2RouterV2.SweepRoute[] memory routes,
        uint256 deadline
    ) internal pure returns (ISignatureTransfer.PermitBatchTransferFrom memory permit) {
        ISignatureTransfer.TokenPermissions[] memory permissions =
            new ISignatureTransfer.TokenPermissions[](routes.length);

        for (uint256 i; i < routes.length;) {
            permissions[i] = ISignatureTransfer.TokenPermissions({
                token: routes[i].tokenIn,
                amount: routes[i].amountIn
            });

            unchecked {
                ++i;
            }
        }

        permit = ISignatureTransfer.PermitBatchTransferFrom({
            permitted: permissions,
            nonce: 1,
            deadline: deadline
        });
    }

    function _expectWitness(
        DustSweepPermit2RouterV2.SweepRoute[] memory routes,
        address tokenOut,
        address to,
        uint256 minAmountOut,
        uint256 deadline
    ) internal {
        bytes32 routeHash = router.hashRoutes(routes);
        bytes32 witness = router.hashSweepWitness(routeHash, tokenOut, to, minAmountOut, deadline);
        permit2.setExpectedWitness(witness);
    }
}
