// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {
    DustSwapSweepRouterOptimism,
    ISignatureTransfer,
    IERC20
} from "../remix/DustSwapSweepRouter_Optimism_Remix.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

interface IOptimismWETH {
    function deposit() external payable;
}

interface IOptimismPermit2State {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonceBitmap(address account, uint256 wordPos) external view returns (uint256);
}

interface IOptimismQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256, uint160, uint32, uint256);
}

interface IOptimismV2Router {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(
        uint256 amountIn,
        address[] memory path
    )
        external
        view
        returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] memory path,
        address to,
        uint256 deadline
    )
        external
        returns (uint256[] memory);
}

interface IOptimismVelodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function defaultFactory() external view returns (address);
    function weth() external view returns (address);
    function getAmountsOut(
        uint256 amountIn,
        Route[] memory routes
    )
        external
        view
        returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] memory routes,
        address to,
        uint256 deadline
    )
        external
        returns (uint256[] memory);
}

/// @notice Exercises the exact Optimism Remix deployment artifact on a real OP Mainnet fork.
/// @dev Opt in with DUST_SWEEP_OPTIMISM_FORK_TESTS=1. An opted-in RPC/quote/swap failure fails
///      the suite; disabled tests are reported as skipped. No transactions are broadcast.
contract DustSwapSweepRouterOptimismForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address constant OP = 0x4200000000000000000000000000000000000042;
    address constant V3_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant V3_QUOTER = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    address constant V2_ROUTER = 0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2;
    address constant V2_FACTORY = 0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf;
    address constant VELO_ROUTER = 0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858;
    address constant VELO_FACTORY = 0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    address constant KYBER = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address constant LIFI = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    uint256 constant AMOUNT_IN = 0.01 ether;

    DustSwapSweepRouterOptimism internal router;
    address internal owner = makeAddr("optimismOwner");
    address internal user = makeAddr("optimismUser");
    address internal recipient = makeAddr("optimismRecipient");
    address internal collector = makeAddr("optimismCollector");
    bool internal forked;

    function setUp() public {
        if (vm.envOr("DUST_SWEEP_OPTIMISM_FORK_TESTS", uint256(0)) == 0) return;
        string memory rpc =
            vm.envOr("OPTIMISM_MAINNET_RPC_URL", string("https://mainnet.optimism.io"));
        uint256 forkBlock = vm.envOr("OPTIMISM_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        forked = true;
        assertEq(block.chainid, 10, "RPC must be OP Mainnet");
        assertGt(PERMIT2.code.length, 0, "Permit2 missing");
        assertGt(WETH.code.length, 0, "WETH missing");
        assertGt(USDC.code.length, 0, "USDC missing");
        assertGt(V3_ROUTER.code.length, 0, "SwapRouter02 missing");
        assertGt(V3_QUOTER.code.length, 0, "QuoterV2 missing");

        router = new DustSwapSweepRouterOptimism(PERMIT2, WETH, owner, collector, 200);
        vm.startPrank(owner);
        router.setAllowedTarget(V3_ROUTER, true);
        router.setAllowedSpender(V3_ROUTER, true);
        router.setAllowedTarget(V2_ROUTER, true);
        router.setAllowedSpender(V2_ROUTER, true);
        router.setAllowedTarget(VELO_ROUTER, true);
        router.setAllowedSpender(VELO_ROUTER, true);
        vm.stopPrank();
        deal(user, 1 ether);
        vm.prank(user);
        IOptimismWETH(WETH).deposit{value: AMOUNT_IN}();
    }

    function _skipUnlessEnabled() internal {
        vm.skip(!forked, "Set DUST_SWEEP_OPTIMISM_FORK_TESTS=1 for live OP Mainnet fork tests");
    }

    function _sweepToUsdc(address target, bytes memory data, uint256 quote) internal {
        assertGt(quote, 0, "live quote must produce output");
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes =
            new DustSwapSweepRouterOptimism.SweepRoute[](1);
        routes[0] = DustSwapSweepRouterOptimism.SweepRoute({
            tokenIn: WETH,
            amountIn: AMOUNT_IN,
            target: target,
            spender: target,
            value: 0,
            data: data
        });
        DustSwapSweepRouterOptimism.SweepParams memory params =
            DustSwapSweepRouterOptimism.SweepParams({
                outputToken: USDC,
                recipient: recipient,
                minAmountOut: quote * 99 / 100,
                deadline: block.timestamp + 1200,
                feeBpsOverride: 200
            });
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);

        vm.startPrank(user);
        IERC20(WETH).approve(address(router), AMOUNT_IN);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        vm.stopPrank();

        assertEq(gross, quote, "sweep must execute the quoted route");
        assertEq(fee, gross * 200 / 10_000, "2 percent protocol fee");
        assertEq(IERC20(USDC).balanceOf(recipient), net, "recipient receives net USDC");
        assertEq(IERC20(USDC).balanceOf(collector), fee, "collector receives fee");
        assertEq(IERC20(WETH).balanceOf(user), 0, "all selected WETH consumed");
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "no input stranded");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "no output stranded");
        assertEq(IERC20(WETH).allowance(address(router), target), 0, "DEX allowance reset");
        assertEq(IERC20(WETH).allowance(user, address(router)), 0, "exact wallet approval consumed");
    }

    function testForkUniswapV3WethToNativeUsdc() public {
        _skipUnlessEnabled();
        (uint256 quote,,,) = IOptimismQuoterV2(V3_QUOTER)
            .quoteExactInputSingle(
                IOptimismQuoterV2.QuoteExactInputSingleParams(WETH, USDC, AMOUNT_IN, 500, 0)
            );
        ISwapRouter02.ExactInputSingleParams memory swapParams = ISwapRouter02.ExactInputSingleParams({
            tokenIn: WETH,
            tokenOut: USDC,
            fee: 500,
            recipient: address(router),
            amountIn: AMOUNT_IN,
            amountOutMinimum: quote * 99 / 100,
            sqrtPriceLimitX96: 0
        });
        _sweepToUsdc(V3_ROUTER, abi.encodeCall(ISwapRouter02.exactInputSingle, (swapParams)), quote);
    }

    function testForkUniswapV2WethToNativeUsdc() public {
        _skipUnlessEnabled();
        IOptimismV2Router dex = IOptimismV2Router(V2_ROUTER);
        assertEq(dex.factory(), V2_FACTORY, "official V2 factory");
        assertEq(dex.WETH(), WETH, "official OP WETH");
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = USDC;
        uint256 quote = dex.getAmountsOut(AMOUNT_IN, path)[1];
        bytes memory data = abi.encodeCall(
            IOptimismV2Router.swapExactTokensForTokens,
            (AMOUNT_IN, quote * 99 / 100, path, address(router), block.timestamp + 1200)
        );
        _sweepToUsdc(V2_ROUTER, data, quote);
    }

    function testForkVelodromeV2WethToNativeUsdc() public {
        _skipUnlessEnabled();
        IOptimismVelodromeRouter dex = IOptimismVelodromeRouter(VELO_ROUTER);
        assertEq(dex.defaultFactory(), VELO_FACTORY, "official Velodrome V2 factory");
        assertEq(dex.weth(), WETH, "official OP WETH");
        IOptimismVelodromeRouter.Route[] memory path = new IOptimismVelodromeRouter.Route[](1);
        path[0] = IOptimismVelodromeRouter.Route(WETH, USDC, false, VELO_FACTORY);
        uint256 quote = dex.getAmountsOut(AMOUNT_IN, path)[1];
        bytes memory data = abi.encodeCall(
            IOptimismVelodromeRouter.swapExactTokensForTokens,
            (AMOUNT_IN, quote * 99 / 100, path, address(router), block.timestamp + 1200)
        );
        _sweepToUsdc(VELO_ROUTER, data, quote);
    }

    function testForkWethToNativeEthPassthrough() public {
        _skipUnlessEnabled();
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes =
            new DustSwapSweepRouterOptimism.SweepRoute[](1);
        routes[0] =
            DustSwapSweepRouterOptimism.SweepRoute(WETH, AMOUNT_IN, address(0), address(0), 0, "");
        DustSwapSweepRouterOptimism.SweepParams memory params =
            DustSwapSweepRouterOptimism.SweepParams({
                outputToken: router.NATIVE_TOKEN_SENTINEL(),
                recipient: recipient,
                minAmountOut: AMOUNT_IN,
                deadline: block.timestamp + 1200,
                feeBpsOverride: 200
            });
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        uint256 nativeBefore = recipient.balance;

        vm.startPrank(user);
        IERC20(WETH).approve(address(router), AMOUNT_IN);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        vm.stopPrank();

        assertEq(gross, AMOUNT_IN, "passthrough preserves gross WETH");
        assertEq(fee, AMOUNT_IN * 200 / 10_000, "2 percent protocol fee");
        assertEq(recipient.balance - nativeBefore, net, "recipient receives native ETH");
        assertEq(IERC20(WETH).balanceOf(collector), fee, "native sweep fee is WETH");
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "no WETH stranded");
        assertEq(address(router).balance, 0, "no ETH stranded");
        assertEq(IERC20(WETH).allowance(user, address(router)), 0, "exact wallet approval consumed");
    }

    /// @dev Inputs are purchased from the actual forked DEX pools, rather than mocking tokens
    ///      or swap targets. The only synthetic funding is the test user's native ETH.
    function _buyMixedInputs() internal {
        vm.startPrank(user);
        IOptimismWETH(WETH).deposit{value: 3 * AMOUNT_IN}();
        IERC20(WETH).approve(V3_ROUTER, AMOUNT_IN);
        ISwapRouter02(V3_ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams(WETH, DAI, 3000, user, AMOUNT_IN, 1, 0)
            );
        address[] memory v2Path = new address[](2);
        v2Path[0] = WETH;
        v2Path[1] = USDC;
        IERC20(WETH).approve(V2_ROUTER, AMOUNT_IN);
        IOptimismV2Router(V2_ROUTER)
            .swapExactTokensForTokens(AMOUNT_IN, 1, v2Path, user, block.timestamp + 1200);
        IOptimismVelodromeRouter.Route[] memory veloPath = new IOptimismVelodromeRouter.Route[](1);
        veloPath[0] = IOptimismVelodromeRouter.Route(WETH, OP, false, VELO_FACTORY);
        IERC20(WETH).approve(VELO_ROUTER, AMOUNT_IN);
        IOptimismVelodromeRouter(VELO_ROUTER)
            .swapExactTokensForTokens(AMOUNT_IN, 1, veloPath, user, block.timestamp + 1200);
        vm.stopPrank();
        assertGt(IERC20(DAI).balanceOf(user), 0, "bought real DAI");
        assertGt(IERC20(USDC).balanceOf(user), 0, "bought real native USDC");
        assertGt(IERC20(OP).balanceOf(user), 0, "bought real OP");
        assertEq(IERC20(WETH).balanceOf(user), AMOUNT_IN, "WETH passthrough remains");
    }

    function _mixedNativeRoutes()
        internal
        returns (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 grossQuote)
    {
        _buyMixedInputs();
        routes = new DustSwapSweepRouterOptimism.SweepRoute[](4);
        uint256 daiAmount = IERC20(DAI).balanceOf(user);
        (uint256 daiQuote,,,) = IOptimismQuoterV2(V3_QUOTER)
            .quoteExactInputSingle(
                IOptimismQuoterV2.QuoteExactInputSingleParams(DAI, WETH, daiAmount, 3000, 0)
            );
        routes[0] = DustSwapSweepRouterOptimism.SweepRoute({
            tokenIn: DAI,
            amountIn: daiAmount,
            target: V3_ROUTER,
            spender: V3_ROUTER,
            value: 0,
            data: abi.encodeCall(
                ISwapRouter02.exactInputSingle,
                (ISwapRouter02.ExactInputSingleParams(
                        DAI, WETH, 3000, address(router), daiAmount, daiQuote, 0
                    ))
            )
        });

        address[] memory v2Path = new address[](2);
        v2Path[0] = USDC;
        v2Path[1] = WETH;
        uint256 usdcAmount = IERC20(USDC).balanceOf(user);
        uint256 usdcQuote = IOptimismV2Router(V2_ROUTER).getAmountsOut(usdcAmount, v2Path)[1];
        routes[1] = DustSwapSweepRouterOptimism.SweepRoute({
            tokenIn: USDC,
            amountIn: usdcAmount,
            target: V2_ROUTER,
            spender: V2_ROUTER,
            value: 0,
            data: abi.encodeCall(
                IOptimismV2Router.swapExactTokensForTokens,
                (usdcAmount, usdcQuote, v2Path, address(router), block.timestamp + 1200)
            )
        });

        IOptimismVelodromeRouter.Route[] memory veloPath = new IOptimismVelodromeRouter.Route[](1);
        veloPath[0] = IOptimismVelodromeRouter.Route(OP, WETH, false, VELO_FACTORY);
        uint256 opAmount = IERC20(OP).balanceOf(user);
        uint256 opQuote = IOptimismVelodromeRouter(VELO_ROUTER).getAmountsOut(opAmount, veloPath)[1];
        routes[2] = DustSwapSweepRouterOptimism.SweepRoute({
            tokenIn: OP,
            amountIn: opAmount,
            target: VELO_ROUTER,
            spender: VELO_ROUTER,
            value: 0,
            data: abi.encodeCall(
                IOptimismVelodromeRouter.swapExactTokensForTokens,
                (opAmount, opQuote, veloPath, address(router), block.timestamp + 1200)
            )
        });
        routes[3] =
            DustSwapSweepRouterOptimism.SweepRoute(WETH, AMOUNT_IN, address(0), address(0), 0, "");
        grossQuote = daiQuote + usdcQuote + opQuote + AMOUNT_IN;
    }

    function _nativeParams(uint256 grossQuote)
        internal
        view
        returns (DustSwapSweepRouterOptimism.SweepParams memory)
    {
        return DustSwapSweepRouterOptimism.SweepParams({
            outputToken: router.NATIVE_TOKEN_SENTINEL(),
            recipient: recipient,
            minAmountOut: grossQuote,
            deadline: block.timestamp + 1200,
            feeBpsOverride: 200
        });
    }

    function _approveMixedInputs(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        address spender
    )
        internal
    {
        vm.startPrank(user);
        for (uint256 i; i < routes.length; ++i) {
            IERC20(routes[i].tokenIn).approve(spender, routes[i].amountIn);
        }
        vm.stopPrank();
    }

    function _assertMixedSettlement(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        uint256 grossQuote,
        uint256 gross,
        uint256 fee,
        uint256 net,
        address pullSpender
    )
        internal
        view
    {
        assertEq(gross, grossQuote, "all real DEX legs plus passthrough settle in one sweep");
        assertEq(fee, grossQuote * 200 / 10_000, "single fee on aggregate gross output");
        assertEq(net, grossQuote - fee, "net is gross less fee");
        assertEq(recipient.balance, net, "single native ETH payout");
        assertEq(IERC20(WETH).balanceOf(collector), fee, "fee remains WETH");
        assertEq(address(router).balance, 0, "no ETH stranded");
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(input.balanceOf(user), 0, "selected input consumed");
            assertEq(input.balanceOf(address(router)), 0, "no input stranded");
            assertEq(input.allowance(user, pullSpender), 0, "exact user approval consumed");
            if (routes[i].spender != address(0)) {
                assertEq(
                    input.allowance(address(router), routes[i].spender), 0, "DEX approval reset"
                );
            }
        }
    }

    function testForkMixedFourTokenAllowanceSweepOneCall() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) =
            _mixedNativeRoutes();
        _approveMixedInputs(routes, address(router));
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);

        // This is the only sweep call: DAI via V3, USDC via V2, OP via Velodrome, WETH passthrough.
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote);
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        _assertMixedSettlement(routes, quote, gross, fee, net, address(router));
    }

    function _signMixedPermit(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        DustSwapSweepRouterOptimism.SweepParams memory params
    )
        internal
        view
        returns (ISignatureTransfer.PermitBatchTransferFrom memory permit, bytes memory signature)
    {
        permit.permitted = new ISignatureTransfer.TokenPermissions[](routes.length);
        permit.nonce = 0x1A2B;
        permit.deadline = params.deadline;
        bytes32[] memory permissionHashes = new bytes32[](routes.length);
        bytes32 permissionsTypehash = keccak256("TokenPermissions(address token,uint256 amount)");
        for (uint256 i; i < routes.length; ++i) {
            permit.permitted[i] =
                ISignatureTransfer.TokenPermissions(routes[i].tokenIn, routes[i].amountIn);
            permissionHashes[i] =
                keccak256(abi.encode(permissionsTypehash, routes[i].tokenIn, routes[i].amountIn));
        }
        // Mirror Uniswap's official PermitHash.hashWithWitness, using the real deployed domain.
        // https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol
        bytes32 typehash = keccak256(
            abi.encodePacked(
                "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,",
                router.PERMIT2_WITNESS_TYPE_STRING()
            )
        );
        bytes32 witness = router.hashSweepWitness(
            router.hashRoutes(routes),
            params.outputToken,
            params.recipient,
            params.minAmountOut,
            params.deadline,
            params.feeBpsOverride
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
                keccak256(abi.encodePacked(permissionHashes)),
                address(router),
                permit.nonce,
                permit.deadline,
                witness
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                hex"1901", IOptimismPermit2State(PERMIT2).DOMAIN_SEPARATOR(), structHash
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("optimismUser")), digest);
        signature = abi.encodePacked(r, s, v);
    }

    function testForkRealPermit2MixedBatchRejectsTamperingAndReplay() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) =
            _mixedNativeRoutes();
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote);
        (ISignatureTransfer.PermitBatchTransferFrom memory permit, bytes memory signature) =
            _signMixedPermit(routes, params);
        _approveMixedInputs(routes, PERMIT2);

        params.feeBpsOverride = 0;
        vm.expectRevert(bytes4(keccak256("InvalidSigner()")));
        vm.prank(user);
        router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
        params.feeBpsOverride = 200;
        params.recipient = makeAddr("unsignedRecipient");
        vm.expectRevert(bytes4(keccak256("InvalidSigner()")));
        vm.prank(user);
        router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
        params.recipient = recipient;
        bytes memory signedData = routes[0].data;
        routes[0].data = abi.encodeWithSignature("unsignedRoute()");
        vm.expectRevert(bytes4(keccak256("InvalidSigner()")));
        vm.prank(user);
        router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
        routes[0].data = signedData;
        assertEq(
            IOptimismPermit2State(PERMIT2).nonceBitmap(user, permit.nonce >> 8),
            0,
            "rejected witnesses do not consume nonce"
        );

        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
        _assertMixedSettlement(routes, quote, gross, fee, net, PERMIT2);
        assertEq(
            IOptimismPermit2State(PERMIT2).nonceBitmap(user, permit.nonce >> 8),
            uint256(1) << uint8(permit.nonce),
            "batch nonce consumed once"
        );
        vm.expectRevert(bytes4(keccak256("InvalidNonce()")));
        vm.prank(user);
        router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
    }

    function testForkMixedSweepImpossibleMinimumRollsBackEveryLeg() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) =
            _mixedNativeRoutes();
        _approveMixedInputs(routes, address(router));
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);

        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote + 1);
        vm.expectRevert(DustSwapSweepRouterOptimism.InsufficientOutput.selector);
        vm.prank(user);
        router.sweep(DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, "");
        assertEq(recipient.balance, 0, "no payout from reverted batch");
        assertEq(IERC20(WETH).balanceOf(collector), 0, "no fee from reverted batch");
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(input.balanceOf(user), routes[i].amountIn, "every input restored atomically");
            assertEq(input.balanceOf(address(router)), 0, "no input stranded after rollback");
            assertEq(
                input.allowance(user, address(router)),
                routes[i].amountIn,
                "pre-sweep allowance restored"
            );
            if (routes[i].spender != address(0)) {
                assertEq(
                    input.allowance(address(router), routes[i].spender), 0, "no leaked DEX approval"
                );
            }
        }
    }

    function testForkRealPermit2SettlementFailureRestoresBatchNonceAndInputs() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) =
            _mixedNativeRoutes();
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote + 1);
        (ISignatureTransfer.PermitBatchTransferFrom memory permit, bytes memory signature) =
            _signMixedPermit(routes, params);
        _approveMixedInputs(routes, PERMIT2);
        vm.expectRevert(DustSwapSweepRouterOptimism.InsufficientOutput.selector);
        vm.prank(user);
        router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
        assertEq(
            IOptimismPermit2State(PERMIT2).nonceBitmap(user, permit.nonce >> 8),
            0,
            "settlement rollback restores nonce"
        );
        assertEq(recipient.balance, 0, "failed signed batch makes no payout");
        assertEq(IERC20(WETH).balanceOf(collector), 0, "failed signed batch charges no fee");
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(input.balanceOf(user), routes[i].amountIn, "signed batch restores every input");
            assertEq(
                input.allowance(user, PERMIT2),
                routes[i].amountIn,
                "signed batch restores exact token approvals"
            );
        }
        params.minAmountOut = quote;
        (permit, signature) = _signMixedPermit(routes, params);
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature,
            routes,
            params,
            permit,
            signature
        );
        _assertMixedSettlement(routes, quote, gross, fee, net, PERMIT2);
    }

    function testForkMixedSweepFailedDexLegRefundsAndOtherLegsSettle() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) =
            _mixedNativeRoutes();
        (uint256 daiQuote,,,) = IOptimismQuoterV2(V3_QUOTER)
            .quoteExactInputSingle(
                IOptimismQuoterV2.QuoteExactInputSingleParams(
                    DAI, WETH, routes[0].amountIn, 3000, 0
                )
            );
        routes[0].data = abi.encodeCall(
            ISwapRouter02.exactInputSingle,
            (ISwapRouter02.ExactInputSingleParams(
                    DAI, WETH, 3000, address(router), routes[0].amountIn, type(uint256).max, 0
                ))
        );
        _approveMixedInputs(routes, address(router));
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote - daiQuote);
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        assertEq(gross, quote - daiQuote, "successful three legs settle together");
        assertEq(fee, gross * 200 / 10_000, "fee only on realized output");
        assertEq(recipient.balance, net, "recipient receives net native output");
        assertEq(IERC20(WETH).balanceOf(collector), fee, "collector receives realized-output fee");
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(
                input.balanceOf(user),
                i == 0 ? routes[i].amountIn : 0,
                "only failed DAI leg refunded"
            );
            assertEq(input.balanceOf(address(router)), 0, "no token stranded");
            assertEq(input.allowance(user, address(router)), 0, "exact user approval consumed");
            if (routes[i].spender != address(0)) {
                assertEq(
                    input.allowance(address(router), routes[i].spender),
                    0,
                    "success and failure approvals cleared"
                );
            }
        }
    }

    function _assertAggregatorRefund(string memory provider) internal {
        uint256 refundedInput = IERC20(WETH).balanceOf(user);
        assertLt(refundedInput, AMOUNT_IN, "aggregator must spend input to realize output");
        uint256 refundEvents;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(router)
                    && logs[i].topics[0] == keccak256("InputRefunded(address,address,uint256)")
            ) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), WETH, "refund input token");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), user, "refund recipient");
                refundEvents += abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(
            refundEvents,
            refundedInput,
            "any aggregator remainder is accounted for by router refunds"
        );
        emit log_named_uint(string.concat(provider, " refunded WETH remainder"), refundedInput);
    }

    function _runLiveAggregatorPayload(string memory provider, address expectedTarget) internal {
        _skipUnlessEnabled();
        vm.skip(
            vm.envOr("DUST_SWEEP_OPTIMISM_AGGREGATOR_FORK_TESTS", uint256(0)) == 0,
            "Run script/VerifyOptimismAggregators.ps1 to build fresh exact-taker payloads"
        );
        string memory fixture = vm.readFile("out/optimism-aggregator-fork-fixture.json");
        assertEq(
            vm.parseJsonAddress(fixture, ".taker"),
            address(router),
            "payload must target this exact router"
        );
        assertEq(
            vm.parseJsonUint(fixture, ".forkBlock"),
            block.number,
            "payload and fork block must agree"
        );
        string memory path = string.concat(".", provider);
        address target = vm.parseJsonAddress(fixture, string.concat(path, ".target"));
        address spender = vm.parseJsonAddress(fixture, string.concat(path, ".spender"));
        bytes memory data = vm.parseJsonBytes(fixture, string.concat(path, ".data"));
        uint256 minimum = vm.parseJsonUint(fixture, string.concat(path, ".minimum"));
        assertEq(target, expectedTarget, "canonical aggregator target");
        assertEq(spender, expectedTarget, "canonical self spender");
        assertGt(minimum, 0, "positive settlement floor");
        vm.recordLogs();
        vm.startPrank(owner);
        router.setAllowedTarget(target, true);
        router.setAllowedSpender(spender, true);
        vm.stopPrank();
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes =
            new DustSwapSweepRouterOptimism.SweepRoute[](1);
        routes[0] =
            DustSwapSweepRouterOptimism.SweepRoute(WETH, AMOUNT_IN, target, spender, 0, data);
        DustSwapSweepRouterOptimism.SweepParams memory params =
            DustSwapSweepRouterOptimism.SweepParams({
                outputToken: USDC,
                recipient: recipient,
                minAmountOut: minimum,
                deadline: block.timestamp + 1200,
                feeBpsOverride: 200
            });
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        vm.startPrank(user);
        IERC20(WETH).approve(address(router), AMOUNT_IN);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        vm.stopPrank();
        assertGe(gross, minimum, "built aggregator payload executed through sweep router");
        assertEq(fee, gross * 200 / 10_000, "2 percent realized-output fee");
        assertEq(IERC20(USDC).balanceOf(recipient), net, "USDC settlement");
        assertEq(IERC20(USDC).balanceOf(collector), fee, "USDC protocol fee");
        _assertAggregatorRefund(provider);
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "no input stranded");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "no output stranded");
        assertEq(IERC20(WETH).allowance(address(router), spender), 0, "aggregator allowance reset");
        assertEq(IERC20(WETH).allowance(user, address(router)), 0, "exact wallet approval consumed");
        emit log_named_uint(string.concat(provider, " realized USDC gross"), gross);
    }

    function testForkAggregatorKyberBuiltPayload() public {
        _runLiveAggregatorPayload("kyber", KYBER);
    }

    function testForkAggregatorLifiBuiltPayload() public {
        _runLiveAggregatorPayload("lifi", LIFI);
    }

    function _buyAggregatorBasketToken(
        string memory fixture,
        string memory key,
        address token,
        uint256 selectedAmount
    ) internal returns (uint256 acquiredBalance) {
        uint256 buyAmount = vm.parseJsonUint(fixture, string.concat(key, ".buyAmount"));
        bytes memory buyData = vm.parseJsonBytes(fixture, string.concat(key, ".buyData"));
        uint256 beforeBuy = IERC20(token).balanceOf(user);
        vm.startPrank(user);
        IERC20(WETH).approve(KYBER, buyAmount);
        (bool bought, bytes memory reason) = KYBER.call(buyData);
        IERC20(WETH).approve(KYBER, 0);
        vm.stopPrank();
        if (!bought) {
            emit log_bytes(reason);
            fail("real fork liquidity must acquire the basket input");
        }
        acquiredBalance = IERC20(token).balanceOf(user);
        assertGe(acquiredBalance - beforeBuy, selectedAmount, "real purchased input covers selection");
        assertGt(selectedAmount, 0, "basket input selection must be positive");
        assertEq(IERC20(WETH).allowance(user, KYBER), 0, "purchase approval cleared");
    }

    function _acquireAggregatorBasketInput(string memory fixture, uint256 index)
        internal
        returns (
            DustSwapSweepRouterOptimism.SweepRoute memory route,
            uint256 acquiredBalance,
            uint256 minimum
        )
    {
        string memory key = string.concat(".tokens[", vm.toString(index), "]");
        address token = vm.parseJsonAddress(fixture, string.concat(key, ".token"));
        assertGt(token.code.length, 0, "basket token must be deployed");
        assertEq(vm.parseJsonAddress(fixture, string.concat(key, ".buyTarget")), KYBER);
        assertEq(vm.parseJsonAddress(fixture, string.concat(key, ".sellTarget")), KYBER);
        assertEq(vm.parseJsonAddress(fixture, string.concat(key, ".sellSpender")), KYBER);
        uint256 selectedAmount = vm.parseJsonUint(fixture, string.concat(key, ".amountIn"));
        acquiredBalance = _buyAggregatorBasketToken(fixture, key, token, selectedAmount);
        route = DustSwapSweepRouterOptimism.SweepRoute({
            tokenIn: token,
            amountIn: selectedAmount,
            target: KYBER,
            spender: KYBER,
            value: 0,
            data: vm.parseJsonBytes(fixture, string.concat(key, ".sellData"))
        });
        minimum = vm.parseJsonUint(fixture, string.concat(key, ".minimum"));
        assertGt(minimum, 0, "every basket route has a positive output floor");
        vm.prank(user);
        IERC20(token).approve(address(router), selectedAmount);
    }

    function _assertAggregatorBasketInputs(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        uint256[] memory balancesBefore
    ) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 executed;
        uint256 settlements;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter != address(router)) continue;
            if (logs[j].topics[0] == keccak256("RouteExecuted(address,address,address,uint256)")) {
                ++executed;
            }
            assertTrue(
                logs[j].topics[0] != keccak256("RouteSkipped(address,uint256,bytes)"),
                "all five real aggregator legs must execute"
            );
            if (logs[j].topics[0] == keccak256("DustSwept(address,address,address,uint256,uint256,uint256,uint256)")) {
                ++settlements;
            }
        }
        assertEq(executed, routes.length, "five legs in one sweep");
        assertEq(settlements, 1, "one aggregate settlement");
        for (uint256 i; i < routes.length; ++i) {
            IERC20 token = IERC20(routes[i].tokenIn);
            uint256 refunds;
            for (uint256 j; j < logs.length; ++j) {
                if (
                    logs[j].emitter == address(router)
                        && logs[j].topics[0] == keccak256("InputRefunded(address,address,uint256)")
                        && address(uint160(uint256(logs[j].topics[1]))) == routes[i].tokenIn
                ) {
                    assertEq(address(uint160(uint256(logs[j].topics[2]))), user);
                    refunds += abi.decode(logs[j].data, (uint256));
                }
            }
            assertLt(refunds, routes[i].amountIn, "each route consumes selected input");
            assertEq(
                token.balanceOf(user),
                balancesBefore[i] - routes[i].amountIn + refunds,
                "unselected purchase remainder and any refund are accounted for"
            );
            assertEq(token.balanceOf(address(router)), 0, "no basket input stranded");
            assertEq(token.allowance(user, address(router)), 0, "exact basket approval consumed");
            assertEq(token.allowance(address(router), KYBER), 0, "basket DEX approval reset");
        }
    }

    function testForkAggregatorBasketFiveTokensOneSweep() public {
        _skipUnlessEnabled();
        vm.skip(
            vm.envOr("DUST_SWEEP_OPTIMISM_AGGREGATOR_BASKET_FORK_TESTS", uint256(0)) == 0,
            "Run script/VerifyOptimismAggregatorBasket.ps1 for exact-taker basket fixtures"
        );
        string memory fixture = vm.readFile("out/optimism-aggregator-basket-fixture.json");
        assertEq(vm.parseJsonAddress(fixture, ".taker"), address(router));
        assertEq(vm.parseJsonAddress(fixture, ".buyer"), user);
        assertEq(vm.parseJsonUint(fixture, ".forkBlock"), block.number);
        assertEq(vm.parseJsonUint(fixture, ".tokenCount"), 5, "representative five-token basket");
        vm.startPrank(owner);
        router.setAllowedTarget(KYBER, true);
        router.setAllowedSpender(KYBER, true);
        vm.stopPrank();
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes =
            new DustSwapSweepRouterOptimism.SweepRoute[](5);
        uint256[] memory balancesBefore = new uint256[](5);
        uint256 minimum;
        for (uint256 i; i < routes.length; ++i) {
            uint256 legMinimum;
            (routes[i], balancesBefore[i], legMinimum) = _acquireAggregatorBasketInput(fixture, i);
            minimum += legMinimum;
        }
        DustSwapSweepRouterOptimism.SweepParams memory params =
            DustSwapSweepRouterOptimism.SweepParams({
                outputToken: USDC,
                recipient: recipient,
                minAmountOut: minimum,
                deadline: block.timestamp + 1200,
                feeBpsOverride: 200
            });
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        vm.recordLogs();
        vm.prank(user);
        // Purchases earlier in this test may warm token/pool slots. This is a local EVM-call
        // benchmark, excluding intrinsic gas, wallet approval batches, L1 data and operator fees;
        // it is not a cold production transaction fee estimate.
        uint256 gasBeforeSweep = gasleft();
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        uint256 sweepCallGas = gasBeforeSweep - gasleft();
        assertGe(gross, minimum, "five real routes meet aggregate output floor");
        assertEq(fee, gross * 200 / 10_000, "one 2 percent aggregate fee");
        assertEq(IERC20(USDC).balanceOf(recipient), net, "one net USDC payout");
        assertEq(IERC20(USDC).balanceOf(collector), fee, "one realized-output fee");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "no output stranded");
        _assertAggregatorBasketInputs(routes, balancesBefore);
        emit log_named_uint("five-token Kyber basket realized USDC gross", gross);
        emit log_named_uint("five-token Kyber basket USDC fee", fee);
        emit log_named_uint("five-token Kyber basket USDC net", net);
        emit log_named_uint("five-token router call EVM gas (excludes intrinsic/L1 data fees)", sweepCallGas);
    }
}
