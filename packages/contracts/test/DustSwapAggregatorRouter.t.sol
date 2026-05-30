// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DustSwapAggregatorRouter} from "../src/DustSwapAggregatorRouter.sol";

contract DustSwapMockERC20 is ERC20 {
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

contract DustSwapMockTarget {
    using SafeERC20 for IERC20;

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        DustSwapMockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

contract DustSwapAggregatorRouterTest is Test {
    DustSwapMockERC20 internal tokenIn;
    DustSwapMockERC20 internal tokenOut;
    DustSwapMockERC20 internal secondOut;
    DustSwapMockTarget internal target;
    DustSwapAggregatorRouter internal router;

    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");
    address internal receiver = makeAddr("receiver");
    address internal collector = makeAddr("collector");
    address internal referrer = makeAddr("referrer");
    address internal permit2 = makeAddr("permit2");
    bytes32 internal referralCode = keccak256(bytes("DUST"));

    function setUp() public {
        tokenIn = new DustSwapMockERC20("Input", "IN", 18);
        tokenOut = new DustSwapMockERC20("Output", "OUT", 6);
        secondOut = new DustSwapMockERC20("Second", "TWO", 6);
        target = new DustSwapMockTarget();
        router = new DustSwapAggregatorRouter(permit2, owner, collector, 25);

        vm.startPrank(owner);
        router.setAllowedTarget(address(target), true);
        router.setAllowedSpender(address(target), true);
        router.setReferralRecipient(referralCode, referrer);
        vm.stopPrank();

        tokenIn.mint(user, 100 ether);
        vm.prank(user);
        tokenIn.approve(address(router), type(uint256).max);
    }

    function test_swapTakesFeeAndSplitsReferral() public {
        uint256 amountIn = 1 ether;
        uint256 grossOut = 1_000_000;
        DustSwapAggregatorRouter.RouteCall[] memory routes = new DustSwapAggregatorRouter.RouteCall[](1);
        routes[0] = DustSwapAggregatorRouter.RouteCall({
            tokenIn: address(tokenIn),
            amountIn: amountIn,
            target: address(target),
            spender: address(target),
            value: 0,
            data: abi.encodeCall(DustSwapMockTarget.swap, (address(tokenIn), address(tokenOut), amountIn, grossOut))
        });

        DustSwapAggregatorRouter.SwapParams memory params = DustSwapAggregatorRouter.SwapParams({
            tokenIn: address(tokenIn),
            amountIn: amountIn,
            tokenOut: address(tokenOut),
            minAmountOut: grossOut,
            receiver: receiver,
            deadline: block.timestamp + 1 hours,
            referralCode: referralCode
        });

        vm.prank(user);
        router.swap(routes, params);

        assertEq(tokenOut.balanceOf(receiver), 997_500);
        assertEq(tokenOut.balanceOf(referrer), 2_000);
        assertEq(tokenOut.balanceOf(collector), 500);
    }

    function test_swapRejectsBlockedTarget() public {
        DustSwapAggregatorRouter.RouteCall[] memory routes = new DustSwapAggregatorRouter.RouteCall[](1);
        address blocked = makeAddr("blocked");
        routes[0] = DustSwapAggregatorRouter.RouteCall({
            tokenIn: address(tokenIn),
            amountIn: 1 ether,
            target: blocked,
            spender: address(target),
            value: 0,
            data: hex"12345678"
        });

        DustSwapAggregatorRouter.SwapParams memory params = DustSwapAggregatorRouter.SwapParams({
            tokenIn: address(tokenIn),
            amountIn: 1 ether,
            tokenOut: address(tokenOut),
            minAmountOut: 1,
            receiver: receiver,
            deadline: block.timestamp + 1 hours,
            referralCode: bytes32(0)
        });

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DustSwapAggregatorRouter.TargetNotAllowed.selector, blocked));
        router.swap(routes, params);
    }

    function test_swapBasketRejectsMoreThanSixOutputs() public {
        DustSwapAggregatorRouter.RouteCall[] memory routes = new DustSwapAggregatorRouter.RouteCall[](1);
        routes[0] = DustSwapAggregatorRouter.RouteCall({
            tokenIn: address(tokenIn),
            amountIn: 1 ether,
            target: address(target),
            spender: address(target),
            value: 0,
            data: abi.encodeCall(DustSwapMockTarget.swap, (address(tokenIn), address(tokenOut), 1 ether, 1_000_000))
        });

        DustSwapAggregatorRouter.Output[] memory outputs = new DustSwapAggregatorRouter.Output[](7);
        for (uint256 i; i < outputs.length; i++) {
            outputs[i] = DustSwapAggregatorRouter.Output({token: address(uint160(100 + i)), minAmountOut: 1});
        }
        DustSwapAggregatorRouter.BasketParams memory params = DustSwapAggregatorRouter.BasketParams({
            outputs: outputs,
            receiver: receiver,
            deadline: block.timestamp + 1 hours,
            referralCode: bytes32(0)
        });

        vm.prank(user);
        vm.expectRevert(DustSwapAggregatorRouter.TooManyOutputs.selector);
        router.swapBasket(routes, params);
    }

    function test_exposesDustSwapBrandConstantsAndReadableSwapSelector() public view {
        assertEq(router.AGGREGATOR_NAME(), "DustSwap");
        assertEq(router.LOGO_URI(), "logo.png");
        assertTrue(DustSwapAggregatorRouter.swap.selector != bytes4(0));
    }
}
