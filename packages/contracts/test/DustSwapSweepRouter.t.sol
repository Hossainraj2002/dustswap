// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DustSwapSweepRouter, ISignatureTransfer} from "../src/DustSwapSweepRouter.sol";

// ───────────────────────────── Mocks ─────────────────────────────

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

/// @notice Token that burns a fee on every transfer, so the recipient receives less than sent.
contract FeeOnTransferERC20 is ERC20 {
    uint256 public constant FEE_BPS = 100; // 1%

    constructor() ERC20("Fee On Transfer", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * FEE_BPS) / 10_000;
        super._update(from, address(0), fee); // burn fee
        super._update(from, to, value - fee);
    }
}

/// @notice Token whose transfer() returns malformed (1-byte) data. abi.decode(bool) on that would
///         revert; the router must treat it as a failed refund, never brick the whole sweep.
contract MalformedReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    // Returns 1 byte of junk (not a clean 32-byte bool) and does not move funds.
    function transfer(address, uint256) external {
        assembly {
            mstore(0x00, 1)
            return(0x00, 1)
        }
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "weth withdraw");
    }

    receive() external payable {}
}

contract MockPermit2 is ISignatureTransfer {
    using SafeERC20 for IERC20;

    bytes32 public expectedWitness;
    mapping(address => mapping(address => mapping(address => uint160))) public allowance;

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
        for (uint256 i; i < permit.permitted.length; ++i) {
            if (transferDetails[i].requestedAmount > permit.permitted[i].amount) revert BadRequestedAmount();
            IERC20(permit.permitted[i].token).safeTransferFrom(
                owner, transferDetails[i].to, transferDetails[i].requestedAmount
            );
        }
    }

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[msg.sender][spender][token] = amount;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint160 current = allowance[from][msg.sender][token];
        if (current < amount) revert InsufficientAllowance();
        allowance[from][msg.sender][token] = current - amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}

/// @notice Standard mock DEX: pulls input via ERC-20 allowance, mints output to caller (router).
contract MockSwapTarget {
    using SafeERC20 for IERC20;

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function boom() external pure {
        revert("boom");
    }
}

/// @notice Records the exact allowance the router granted it during the swap (approval-bound proof).
contract AllowanceRecorderTarget {
    using SafeERC20 for IERC20;

    uint256 public recordedAllowance;

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        recordedAllowance = IERC20(tokenIn).allowance(msg.sender, address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

/// @notice Pulls input through Permit2 (Uniswap Universal Router / V4 style spender == Permit2).
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

/// @notice Malicious DEX that tries to reenter sweep() mid-swap, then completes a normal swap.
contract ReentrantTarget {
    using SafeERC20 for IERC20;

    DustSwapSweepRouter public immutable router;
    bool public reentryReverted;

    constructor(DustSwapSweepRouter _router) {
        router = _router;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        DustSwapSweepRouter.SweepRoute[] memory empty = new DustSwapSweepRouter.SweepRoute[](0);
        DustSwapSweepRouter.SweepParams memory p;
        ISignatureTransfer.PermitBatchTransferFrom memory perm;
        try router.sweep(DustSwapSweepRouter.SweepMode.Allowance, empty, p, perm, "") {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

/// @notice Contract caller (stand-in for an EIP-7702 / contract account) using Allowance mode.
contract ContractCaller {
    function run(
        DustSwapSweepRouter router,
        DustSwapSweepRouter.SweepRoute[] calldata routes,
        DustSwapSweepRouter.SweepParams calldata params
    ) external {
        for (uint256 i; i < routes.length; ++i) {
            IERC20(routes[i].tokenIn).approve(address(router), routes[i].amountIn);
        }
        ISignatureTransfer.PermitBatchTransferFrom memory perm;
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, perm, "");
    }
}

// ───────────────────────────── Tests ─────────────────────────────

contract DustSwapSweepRouterTest is Test {
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    MockERC20 internal outputToken;
    MockWETH internal weth;
    MockPermit2 internal permit2;
    MockSwapTarget internal target;
    MockPermit2SwapTarget internal permit2Target;
    DustSwapSweepRouter internal router;

    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");
    address internal feeCollector = makeAddr("feeCollector");
    address internal nonOwner = makeAddr("nonOwner");

    uint256 internal constant DEFAULT_FEE = 60; // 0.6% (uint256 so test math never wraps a uint16)
    uint256 internal constant DEADLINE = 2_000_000_000;

    function setUp() public {
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        outputToken = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockWETH();
        permit2 = new MockPermit2();
        target = new MockSwapTarget();
        permit2Target = new MockPermit2SwapTarget();

        router = new DustSwapSweepRouter(address(permit2), address(weth), owner, feeCollector, uint16(DEFAULT_FEE));

        vm.startPrank(owner);
        router.setAllowedTarget(address(target), true);
        router.setAllowedSpender(address(target), true);
        router.setAllowedTarget(address(permit2Target), true);
        router.setAllowedSpender(address(permit2), true);
        vm.stopPrank();

        tokenA.mint(user, 1_000 ether);
        tokenB.mint(user, 1_000 ether);
        vm.deal(address(weth), 100 ether); // back WETH so withdraw() can pay ETH

        vm.startPrank(user);
        tokenA.approve(address(permit2), type(uint256).max);
        tokenB.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────

    function _route(address tokenIn, uint256 amountIn, uint256 amountOut, address tokenOut)
        internal
        view
        returns (DustSwapSweepRouter.SweepRoute memory)
    {
        return DustSwapSweepRouter.SweepRoute({
            tokenIn: tokenIn,
            amountIn: amountIn,
            target: address(target),
            spender: address(target),
            value: 0,
            data: abi.encodeCall(MockSwapTarget.swap, (tokenIn, tokenOut, amountIn, amountOut))
        });
    }

    /// @dev A passthrough leg: tokenIn == the settlement token (e.g. WETH for a native sweep).
    ///      No DEX swap; target/spender/data are ignored by the contract for these legs.
    function _passthrough(address tokenIn, uint256 amountIn)
        internal
        pure
        returns (DustSwapSweepRouter.SweepRoute memory)
    {
        return DustSwapSweepRouter.SweepRoute({
            tokenIn: tokenIn,
            amountIn: amountIn,
            target: address(0),
            spender: address(0),
            value: 0,
            data: ""
        });
    }

    function _params(address outputToken_, uint256 minOut, uint16 feeOverride)
        internal
        view
        returns (DustSwapSweepRouter.SweepParams memory)
    {
        return DustSwapSweepRouter.SweepParams({
            outputToken: outputToken_,
            recipient: recipient,
            minAmountOut: minOut,
            deadline: DEADLINE,
            feeBpsOverride: feeOverride
        });
    }

    function _permit(DustSwapSweepRouter.SweepRoute[] memory routes, uint256 deadline)
        internal
        pure
        returns (ISignatureTransfer.PermitBatchTransferFrom memory permit)
    {
        ISignatureTransfer.TokenPermissions[] memory permissions =
            new ISignatureTransfer.TokenPermissions[](routes.length);
        for (uint256 i; i < routes.length; ++i) {
            permissions[i] =
                ISignatureTransfer.TokenPermissions({token: routes[i].tokenIn, amount: routes[i].amountIn});
        }
        permit = ISignatureTransfer.PermitBatchTransferFrom({permitted: permissions, nonce: 1, deadline: deadline});
    }

    function _setWitness(
        DustSwapSweepRouter.SweepRoute[] memory routes,
        DustSwapSweepRouter.SweepParams memory params,
        uint16 effectiveFee
    ) internal {
        bytes32 routeHash = router.hashRoutes(routes);
        bytes32 witness = router.hashSweepWitness(
            routeHash, params.outputToken, params.recipient, params.minAmountOut, params.deadline, effectiveFee
        );
        permit2.setExpectedWitness(witness);
    }

    function _emptyPermit() internal pure returns (ISignatureTransfer.PermitBatchTransferFrom memory permit) {
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
    }

    function _sentinel() internal view returns (uint16) {
        return router.FEE_OVERRIDE_SENTINEL();
    }

    // ── Permit2 signature path ───────────────────────────────────

    function test_permit2Path_success() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](2);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        routes[1] = _route(address(tokenB), 6 ether, 700_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1_000_000, _sentinel());
        _setWitness(routes, params, uint16(DEFAULT_FEE));

        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) =
            router.sweep(DustSwapSweepRouter.SweepMode.Permit2Signature, routes, params, _permit(routes, DEADLINE), "sig");

        assertEq(gross, 1_200_000);
        assertEq(fee, 7_200); // 1.2M * 0.6%
        assertEq(net, 1_192_800);
        assertEq(outputToken.balanceOf(feeCollector), 7_200);
        assertEq(outputToken.balanceOf(recipient), 1_192_800);
        assertEq(tokenA.allowance(address(router), address(target)), 0);
        assertEq(tokenB.allowance(address(router), address(target)), 0);
    }

    function test_permit2Path_witnessBindsFee() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, _sentinel());
        // User "signed" a witness for a DIFFERENT fee than the contract will compute.
        _setWitness(routes, params, 10);

        vm.prank(user);
        vm.expectRevert(MockPermit2.BadWitness.selector);
        router.sweep(DustSwapSweepRouter.SweepMode.Permit2Signature, routes, params, _permit(routes, DEADLINE), "sig");
    }

    function test_permit2Path_permit2SpenderRouteResetsAllowance() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = DustSwapSweepRouter.SweepRoute({
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
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 900_000, _sentinel());
        _setWitness(routes, params, uint16(DEFAULT_FEE));

        vm.prank(user);
        router.sweep(DustSwapSweepRouter.SweepMode.Permit2Signature, routes, params, _permit(routes, DEADLINE), "sig");

        assertEq(outputToken.balanceOf(recipient), 994_000);
        assertEq(permit2.allowance(address(router), address(permit2Target), address(tokenA)), 0);
        assertEq(tokenA.allowance(address(router), address(permit2)), 0);
    }

    // ── Allowance path ───────────────────────────────────────────

    function test_allowancePath_success_exactApproval() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](2);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        routes[1] = _route(address(tokenB), 6 ether, 700_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1_000_000, _sentinel());

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether); // EXACT amount, not unlimited
        tokenB.approve(address(router), 6 ether);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertEq(outputToken.balanceOf(recipient), 1_192_800);
        assertEq(tokenA.allowance(address(router), address(target)), 0);
        assertEq(tokenB.allowance(address(router), address(target)), 0);
        // The user's exact approval to the router is fully consumed.
        assertEq(tokenA.allowance(user, address(router)), 0);
        assertEq(tokenB.allowance(user, address(router)), 0);
    }

    function test_contractCaller_allowanceMode() public {
        ContractCaller caller = new ContractCaller();
        tokenA.mint(address(caller), 10 ether);

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 10 ether, 1_000_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 900_000, _sentinel());

        caller.run(router, routes, params);

        assertEq(outputToken.balanceOf(recipient), 994_000);
        assertEq(tokenA.allowance(address(router), address(target)), 0);
    }

    // ── Approval bounds ──────────────────────────────────────────

    function test_approvalNeverExceedsAmountIn_andResetsToZero() public {
        AllowanceRecorderTarget recorder = new AllowanceRecorderTarget();
        vm.startPrank(owner);
        router.setAllowedTarget(address(recorder), true);
        router.setAllowedSpender(address(recorder), true);
        vm.stopPrank();

        uint256 amountIn = 7 ether;
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = DustSwapSweepRouter.SweepRoute({
            tokenIn: address(tokenA),
            amountIn: amountIn,
            target: address(recorder),
            spender: address(recorder),
            value: 0,
            data: abi.encodeCall(
                AllowanceRecorderTarget.swap, (address(tokenA), address(outputToken), amountIn, 1_000_000)
            )
        });
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, _sentinel());

        vm.startPrank(user);
        tokenA.approve(address(router), amountIn);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        // Allowance granted to the DEX during the swap was EXACTLY amountIn — never more.
        assertEq(recorder.recordedAllowance(), amountIn);
        // And it is reset to 0 afterwards.
        assertEq(tokenA.allowance(address(router), address(recorder)), 0);
    }

    function test_feeOnTransferToken_skippedAndRefunded_neverApproved() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        fot.mint(user, 100 ether);

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](2);
        // Route 0: fee-on-transfer token -> router receives < amountIn -> must be skipped+refunded.
        routes[0] = _route(address(fot), 10 ether, 500_000, address(outputToken));
        // Route 1: normal token -> succeeds.
        routes[1] = _route(address(tokenA), 5 ether, 600_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 600_000, _sentinel());

        vm.startPrank(user);
        fot.approve(address(router), 10 ether);
        tokenA.approve(address(router), 5 ether);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        // The good route settled.
        assertEq(outputToken.balanceOf(recipient), 600_000 - (600_000 * DEFAULT_FEE) / 10_000);
        // The FoT token was never approved to the DEX (skipped before approval, or rolled back).
        assertEq(fot.allowance(address(router), address(target)), 0);
        // Nothing stranded: the router holds none of the FoT token.
        assertEq(fot.balanceOf(address(router)), 0);
        // The FoT received balance was refunded to the user (minus the token's own transfer fee).
        assertGt(fot.balanceOf(user), 89 ether);
    }

    // ── Best-effort partial failure ──────────────────────────────

    function test_bestEffort_partialFailure_refundsAndSettles() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](3);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken)); // ok
        // Route 1 reverts inside the swap (boom()).
        routes[1] = DustSwapSweepRouter.SweepRoute({
            tokenIn: address(tokenB),
            amountIn: 6 ether,
            target: address(target),
            spender: address(target),
            value: 0,
            data: abi.encodeCall(MockSwapTarget.boom, ())
        });
        routes[2] = _route(address(tokenA), 1 ether, 100_000, address(outputToken)); // ok (dup token)
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 500_000, _sentinel());

        uint256 userBBefore = tokenB.balanceOf(user);

        vm.startPrank(user);
        tokenA.approve(address(router), 5 ether);
        tokenB.approve(address(router), 6 ether);
        (uint256 gross,,) = router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        // Only the two good routes produced output.
        assertEq(gross, 600_000);
        // Failed route's tokenB fully refunded to the user; nothing stranded.
        assertEq(tokenB.balanceOf(user), userBBefore);
        assertEq(tokenB.balanceOf(address(router)), 0);
        assertEq(tokenA.balanceOf(address(router)), 0);
    }

    // ── Native ETH output ────────────────────────────────────────

    function test_ethOutput_unwrapsWeth() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 1 ether, address(weth)); // DEX outputs WETH
        DustSwapSweepRouter.SweepParams memory params =
            _params(router.NATIVE_TOKEN_SENTINEL(), 0.9 ether, _sentinel());

        uint256 recipientEthBefore = recipient.balance;

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        (uint256 gross, uint256 fee, uint256 net) =
            router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertEq(gross, 1 ether);
        assertEq(fee, (1 ether * DEFAULT_FEE) / 10_000);
        assertEq(net, 1 ether - fee);
        assertEq(recipient.balance, recipientEthBefore + net); // got real ETH
        assertEq(IERC20(address(weth)).balanceOf(feeCollector), fee); // fee paid in WETH
    }

    // WETH swept STRAIGHT into native ETH through the router (no wallet-side unwrap): the input IS
    // the settlement token (actualOutput == WETH), so it's a passthrough leg the router unwraps.
    function test_ethOutput_wethPassthrough() public {
        weth.mint(user, 5 ether);

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _passthrough(address(weth), 4 ether);
        DustSwapSweepRouter.SweepParams memory params =
            _params(router.NATIVE_TOKEN_SENTINEL(), 3 ether, _sentinel());

        uint256 recipientEthBefore = recipient.balance;

        vm.startPrank(user);
        weth.approve(address(router), 4 ether);
        (uint256 gross, uint256 fee, uint256 net) =
            router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertEq(gross, 4 ether); // the whole WETH input settled as output
        assertEq(fee, (4 ether * DEFAULT_FEE) / 10_000);
        assertEq(net, 4 ether - fee);
        assertEq(recipient.balance, recipientEthBefore + net); // recipient got real ETH
        assertEq(IERC20(address(weth)).balanceOf(feeCollector), fee); // fee paid in WETH
        assertEq(weth.balanceOf(address(router)), 0); // nothing stranded in the router
        assertEq(weth.balanceOf(user), 1 ether); // untouched remainder stays with the user
    }

    // Mixed basket into native ETH: a real DEX swap (tokenA -> WETH) PLUS a WETH passthrough leg,
    // both settling into ETH in one atomic router call.
    function test_ethOutput_mixedSwapAndWethPassthrough() public {
        weth.mint(user, 3 ether);

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](2);
        routes[0] = _route(address(tokenA), 4 ether, 1 ether, address(weth)); // tokenA -> WETH via DEX
        routes[1] = _passthrough(address(weth), 2 ether); // WETH -> ETH passthrough
        DustSwapSweepRouter.SweepParams memory params =
            _params(router.NATIVE_TOKEN_SENTINEL(), 2 ether, _sentinel());

        uint256 recipientEthBefore = recipient.balance;

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        weth.approve(address(router), 2 ether);
        (uint256 gross,, uint256 net) =
            router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertEq(gross, 3 ether); // 1 (swapped) + 2 (passthrough)
        assertEq(recipient.balance, recipientEthBefore + net);
        assertEq(weth.balanceOf(address(router)), 0); // nothing stranded
        assertEq(tokenA.balanceOf(address(router)), 0);
    }

    // ── Fee override + cap ───────────────────────────────────────

    function test_feeOverride_zeroMeansNoFee() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, 0); // 0 fee

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        (uint256 gross, uint256 fee, uint256 net) =
            router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertEq(fee, 0);
        assertEq(net, gross);
        assertEq(outputToken.balanceOf(feeCollector), 0);
    }

    function test_feeOverride_customWithinCap() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, 100); // 1%

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        (uint256 gross, uint256 fee,) =
            router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertEq(fee, (gross * 100) / 10_000);
    }

    function test_feeOverride_aboveCapReverts() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params =
            _params(address(outputToken), 1, router.MAX_FEE_BPS() + 1);

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        vm.expectRevert(DustSwapSweepRouter.FeeTooHigh.selector);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();
    }

    function test_setFeeBps_aboveCapReverts() public {
        uint16 tooHigh = router.MAX_FEE_BPS() + 1; // resolve view call before prank/expectRevert
        vm.prank(owner);
        vm.expectRevert(DustSwapSweepRouter.FeeTooHigh.selector);
        router.setFeeBps(tooHigh);
    }

    // ── minAmountOut + deadline ──────────────────────────────────

    function test_minAmountOut_enforcedOnRealizedOutput() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 600_000, _sentinel());

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        vm.expectRevert(DustSwapSweepRouter.InsufficientOutput.selector);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();
    }

    function test_deadlineExpiredReverts() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = DustSwapSweepRouter.SweepParams({
            outputToken: address(outputToken),
            recipient: recipient,
            minAmountOut: 1,
            deadline: block.timestamp - 1,
            feeBpsOverride: _sentinel()
        });

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        vm.expectRevert(DustSwapSweepRouter.DeadlineExpired.selector);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();
    }

    // ── Pause / allowlist / rescue ───────────────────────────────

    function test_pauseBlocksSweep() public {
        vm.prank(owner);
        router.pause();

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, _sentinel());

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        vm.prank(owner);
        router.unpause();

        vm.startPrank(user);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();
        assertGt(outputToken.balanceOf(recipient), 0);
    }

    function test_allowlist_addRemove() public {
        address newTarget = makeAddr("newTarget");
        vm.prank(nonOwner);
        vm.expectRevert();
        router.setAllowedTarget(newTarget, true);

        vm.prank(owner);
        router.setAllowedTarget(newTarget, true);
        assertTrue(router.allowedTargets(newTarget));

        vm.prank(owner);
        router.setAllowedTarget(newTarget, false);
        assertFalse(router.allowedTargets(newTarget));
    }

    function test_sweepRejectsNonAllowlistedTarget() public {
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = _route(address(tokenA), 4 ether, 500_000, address(outputToken));
        routes[0].target = makeAddr("blocked");
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, _sentinel());

        vm.startPrank(user);
        tokenA.approve(address(router), 4 ether);
        vm.expectRevert(abi.encodeWithSelector(DustSwapSweepRouter.TargetNotAllowed.selector, routes[0].target));
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();
    }

    function test_rescueERC20AndNative_onlyOwner() public {
        outputToken.mint(address(router), 123);
        vm.deal(address(router), 1 ether);

        vm.prank(nonOwner);
        vm.expectRevert();
        router.rescueERC20(address(outputToken), recipient, 123);

        vm.prank(owner);
        router.rescueERC20(address(outputToken), recipient, 123);
        assertEq(outputToken.balanceOf(recipient), 123);

        uint256 beforeBal = recipient.balance;
        vm.prank(owner);
        router.rescueNative(payable(recipient), 0.5 ether);
        assertEq(recipient.balance, beforeBal + 0.5 ether);
    }

    // ── Reentrancy ───────────────────────────────────────────────

    function test_reentrancy_blockedButOuterSweepSucceeds() public {
        ReentrantTarget evil = new ReentrantTarget(router);
        vm.startPrank(owner);
        router.setAllowedTarget(address(evil), true);
        router.setAllowedSpender(address(evil), true);
        vm.stopPrank();

        uint256 amountIn = 4 ether;
        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](1);
        routes[0] = DustSwapSweepRouter.SweepRoute({
            tokenIn: address(tokenA),
            amountIn: amountIn,
            target: address(evil),
            spender: address(evil),
            value: 0,
            data: abi.encodeCall(ReentrantTarget.swap, (address(tokenA), address(outputToken), amountIn, 1_000_000))
        });
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 1, _sentinel());

        vm.startPrank(user);
        tokenA.approve(address(router), amountIn);
        router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        assertTrue(evil.reentryReverted()); // the nested sweep() was rejected by the guard
        assertEq(outputToken.balanceOf(recipient), 994_000); // outer sweep still settled
    }

    // ── Refund robustness ────────────────────────────────────────

    function test_malformedRefundReturn_doesNotBrickSweep() public {
        MalformedReturnERC20 weird = new MalformedReturnERC20();
        weird.mint(user, 10 ether);

        DustSwapSweepRouter.SweepRoute[] memory routes = new DustSwapSweepRouter.SweepRoute[](2);
        // Route 0: weird token; the swap reverts, so the router must refund it via transfer(),
        // which returns malformed 1-byte data. This must NOT revert the whole sweep.
        routes[0] = DustSwapSweepRouter.SweepRoute({
            tokenIn: address(weird),
            amountIn: 4 ether,
            target: address(target),
            spender: address(target),
            value: 0,
            data: abi.encodeCall(MockSwapTarget.boom, ())
        });
        // Route 1: a normal token that settles.
        routes[1] = _route(address(tokenA), 5 ether, 600_000, address(outputToken));
        DustSwapSweepRouter.SweepParams memory params = _params(address(outputToken), 500_000, _sentinel());

        vm.startPrank(user);
        weird.approve(address(router), 4 ether);
        tokenA.approve(address(router), 5 ether);
        (uint256 gross,,) = router.sweep(DustSwapSweepRouter.SweepMode.Allowance, routes, params, _emptyPermit(), "");
        vm.stopPrank();

        // The malformed return did NOT revert the sweep; the good route settled normally.
        assertEq(gross, 600_000);
        assertEq(outputToken.balanceOf(recipient), 600_000 - (600_000 * DEFAULT_FEE) / 10_000);
    }

    function test_receiveRejectsEthFromNonWeth() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok); // receive() only accepts ETH from the WETH contract (L-3 hardening)

        // WETH unwrap during a native-output sweep still works (covered by test_ethOutput_unwrapsWeth).
        assertEq(address(router).balance, 0);
    }
}
