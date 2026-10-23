// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DustSwapSweepRouterOptimism, ISignatureTransfer, IERC20} from "../remix/DustSwapSweepRouter_Optimism_Remix.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {IOptimismWETH, IOptimismPermit2State, IOptimismQuoterV2, IOptimismV2Router, IOptimismVelodromeRouter} from "./DustSwapSweepRouterOptimismFork.t.sol";

/// @notice Exercises the ACTUAL deployed OP router. Never deploys a replacement or changes its
///         owner, configuration or allowlists, even on the fork. No mainnet transactions are sent.
contract DustSwapSweepRouterOptimismDeployedForkTest is Test {
    address constant DEPLOYED = 0x54C177426033d50686bA7D36B690d1a2d7E34625;
    address constant OWNER = 0xF113b1dBd848F44684f8543CcDf63C90f9535F57;
    address constant COLLECTOR = 0xE09495e955794708D4bC28045C46891cAf643733;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address constant OP = 0x4200000000000000000000000000000000000042;
    address constant V3_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant V3_QUOTER = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    address constant V2_ROUTER = 0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2;
    address constant VELO_ROUTER = 0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858;
    address constant VELO_FACTORY = 0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a;
    address constant KYBER = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address constant LIFI = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    uint256 constant AMOUNT_IN = 0.01 ether;

    DustSwapSweepRouterOptimism internal router;
    address internal user = makeAddr("optimismUser");
    address internal recipient = makeAddr("deployedOptimismRecipient");
    bool internal forked;
    uint256 internal collectorWethInitial;
    uint256 internal collectorUsdcInitial;
    uint256 internal recipientNativeInitial;
    uint256 internal recipientUsdcInitial;
    uint256 internal routerNativeInitial;
    mapping(address => uint256) internal routerInputInitial;

    function setUp() public {
        if (vm.envOr("DUST_SWEEP_OPTIMISM_DEPLOYED_FORK_TESTS", uint256(0)) == 0) return;
        string memory rpc = vm.envOr("OPTIMISM_MAINNET_RPC_URL", string("https://mainnet.optimism.io"));
        uint256 forkBlock = vm.envOr("OPTIMISM_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        forked = true;
        assertEq(block.chainid, 10);
        assertGt(DEPLOYED.code.length, 0, "actual deployed router must exist");
        router = DustSwapSweepRouterOptimism(payable(DEPLOYED));
        assertEq(router.owner(), OWNER);
        assertEq(router.feeCollector(), COLLECTOR);
        assertEq(router.feeBps(), 200);
        assertEq(address(router.permit2()), PERMIT2);
        assertEq(address(router.weth()), WETH);
        assertFalse(router.paused());
        address[5] memory targets = [V3_ROUTER, V2_ROUTER, VELO_ROUTER, KYBER, LIFI];
        for (uint256 i; i < targets.length; ++i) {
            assertTrue(router.allowedTargets(targets[i]), "deployed target allowlist");
            assertTrue(router.allowedSpenders(targets[i]), "deployed spender allowlist");
        }
        address[4] memory inputs = [DAI, USDC, OP, WETH];
        for (uint256 i; i < inputs.length; ++i) {
            routerInputInitial[inputs[i]] = IERC20(inputs[i]).balanceOf(DEPLOYED);
        }
        collectorWethInitial = IERC20(WETH).balanceOf(COLLECTOR);
        collectorUsdcInitial = IERC20(USDC).balanceOf(COLLECTOR);
        recipientNativeInitial = recipient.balance;
        recipientUsdcInitial = IERC20(USDC).balanceOf(recipient);
        routerNativeInitial = DEPLOYED.balance;
        deal(user, 1 ether);
        vm.prank(user);
        IOptimismWETH(WETH).deposit{value: AMOUNT_IN}();
    }

    function _skipUnlessEnabled() internal {
        vm.skip(!forked, "Set DUST_SWEEP_OPTIMISM_DEPLOYED_FORK_TESTS=1 for actual-router forks");
    }

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

    function _signMixedPermit(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        DustSwapSweepRouterOptimism.SweepParams memory params
    )
        internal
        view
        returns (ISignatureTransfer.PermitBatchTransferFrom memory permit, bytes memory signature)
    {
        permit.permitted = new ISignatureTransfer.TokenPermissions[](routes.length);
        permit.nonce = 0xD3740;
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



    function _assertEvents(uint256 expectedRoutes) internal view {
        _assertEventsFromLogs(expectedRoutes, vm.getRecordedLogs());
    }

    function _assertEventsFromLogs(uint256 expectedRoutes, Vm.Log[] memory logs) internal pure {
        uint256 executed;
        uint256 settled;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != DEPLOYED) continue;
            if (logs[i].topics[0] == keccak256("RouteExecuted(address,address,address,uint256)")) ++executed;
            if (logs[i].topics[0] == keccak256("DustSwept(address,address,address,uint256,uint256,uint256,uint256)")) ++settled;
            assertTrue(logs[i].topics[0] != keccak256("RouteSkipped(address,uint256,bytes)"), "all selected routes execute");
        }
        assertEq(executed, expectedRoutes);
        assertEq(settled, 1, "one actual-router aggregate settlement");
    }

    function _assertNativeSettlement(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        uint256 quote,
        uint256 gross,
        uint256 fee,
        uint256 net,
        address pullSpender
    ) internal view {
        assertEq(gross, quote);
        assertEq(fee, gross * 200 / 10_000);
        assertEq(net, gross - fee);
        assertEq(recipient.balance - recipientNativeInitial, net);
        assertEq(IERC20(WETH).balanceOf(COLLECTOR) - collectorWethInitial, fee);
        assertEq(DEPLOYED.balance, routerNativeInitial);
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(input.balanceOf(user), 0, "selected real input consumed");
            assertEq(input.balanceOf(DEPLOYED), routerInputInitial[routes[i].tokenIn], "old router funds preserved");
            assertEq(input.allowance(user, pullSpender), 0);
            if (routes[i].spender != address(0)) assertEq(input.allowance(DEPLOYED, routes[i].spender), 0);
        }
        _assertEvents(routes.length);
    }

    function testDeployedMixedFourTokenNativeAllowance() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) = _mixedNativeRoutes();
        _approveMixedInputs(routes, DEPLOYED);
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote);
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        vm.recordLogs();
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        _assertNativeSettlement(routes, quote, gross, fee, net, DEPLOYED);
        emit log_named_uint("deployed mixed native gross wei", gross);
        emit log_named_uint("deployed mixed collector WETH fee wei", fee);
        emit log_named_uint("deployed mixed recipient ETH net wei", net);
    }

    function testDeployedRealPermit2MixedNativeWitnessAndReplay() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) = _mixedNativeRoutes();
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote);
        (ISignatureTransfer.PermitBatchTransferFrom memory permit, bytes memory signature) = _signMixedPermit(routes, params);
        _approveMixedInputs(routes, PERMIT2);
        uint256 nonceBefore = IOptimismPermit2State(PERMIT2).nonceBitmap(user, permit.nonce >> 8);
        uint256 nonceBit = uint256(1) << uint8(permit.nonce);
        assertEq(nonceBefore & nonceBit, 0, "test nonce unused");
        params.feeBpsOverride = 0;
        vm.expectRevert(bytes4(keccak256("InvalidSigner()")));
        vm.prank(user);
        router.sweep(DustSwapSweepRouterOptimism.SweepMode.Permit2Signature, routes, params, permit, signature);
        params.feeBpsOverride = 200;
        assertEq(IOptimismPermit2State(PERMIT2).nonceBitmap(user, permit.nonce >> 8), nonceBefore);
        vm.recordLogs();
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Permit2Signature, routes, params, permit, signature
        );
        _assertNativeSettlement(routes, quote, gross, fee, net, PERMIT2);
        assertEq(IOptimismPermit2State(PERMIT2).nonceBitmap(user, permit.nonce >> 8), nonceBefore | nonceBit);
        vm.expectRevert(bytes4(keccak256("InvalidNonce()")));
        vm.prank(user);
        router.sweep(DustSwapSweepRouterOptimism.SweepMode.Permit2Signature, routes, params, permit, signature);
    }

    function testDeployedMixedImpossibleFloorRollsBack() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) = _mixedNativeRoutes();
        _approveMixedInputs(routes, DEPLOYED);
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote + 1);
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        vm.expectRevert(DustSwapSweepRouterOptimism.InsufficientOutput.selector);
        vm.prank(user);
        router.sweep(DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, "");
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(input.balanceOf(user), routes[i].amountIn);
            assertEq(input.balanceOf(DEPLOYED), routerInputInitial[routes[i].tokenIn]);
            assertEq(input.allowance(user, DEPLOYED), routes[i].amountIn, "failed sweep restores exact approval");
            if (routes[i].spender != address(0)) assertEq(input.allowance(DEPLOYED, routes[i].spender), 0);
        }
        assertEq(recipient.balance, recipientNativeInitial);
        assertEq(IERC20(WETH).balanceOf(COLLECTOR), collectorWethInitial);
    }

    function _assertPartialSettlement(
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes,
        uint256 expectedGross,
        uint256 gross,
        uint256 fee,
        uint256 net
    ) internal view {
        assertEq(gross, expectedGross, "only healthy legs produce gross output");
        assertEq(fee, gross * 200 / 10_000, "fee uses actual reduced gross");
        assertEq(net, gross - fee);
        assertEq(recipient.balance - recipientNativeInitial, net);
        assertEq(IERC20(WETH).balanceOf(COLLECTOR) - collectorWethInitial, fee);
        assertEq(DEPLOYED.balance, routerNativeInitial);
        for (uint256 i; i < routes.length; ++i) {
            IERC20 input = IERC20(routes[i].tokenIn);
            assertEq(input.balanceOf(user), i == 0 ? routes[i].amountIn : 0, "failed DAI input returned, healthy inputs consumed");
            assertEq(input.balanceOf(DEPLOYED), routerInputInitial[routes[i].tokenIn]);
            assertEq(input.allowance(user, DEPLOYED), 0);
            if (routes[i].spender != address(0)) assertEq(input.allowance(DEPLOYED, routes[i].spender), 0);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 executed;
        uint256 skipped;
        uint256 refunded;
        uint256 settled;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != DEPLOYED) continue;
            bytes32 topic = logs[i].topics[0];
            if (topic == keccak256("RouteExecuted(address,address,address,uint256)")) ++executed;
            if (topic == keccak256("DustSwept(address,address,address,uint256,uint256,uint256,uint256)")) ++settled;
            if (topic == keccak256("RouteSkipped(address,uint256,bytes)")) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), DAI);
                ++skipped;
            }
            if (topic == keccak256("InputRefunded(address,address,uint256)")) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), DAI);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), user);
                refunded += abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(executed, 3);
        assertEq(skipped, 1);
        assertEq(settled, 1);
        assertEq(refunded, routes[0].amountIn, "exact failed input refund event");
    }

    function testDeployedPartialDexFailureRefundsAndSettlesHealthyLegs() public {
        _skipUnlessEnabled();
        (DustSwapSweepRouterOptimism.SweepRoute[] memory routes, uint256 quote) = _mixedNativeRoutes();
        (uint256 daiQuote,,,) = IOptimismQuoterV2(V3_QUOTER).quoteExactInputSingle(
            IOptimismQuoterV2.QuoteExactInputSingleParams(DAI, WETH, routes[0].amountIn, 3000, 0)
        );
        routes[0].data = abi.encodeCall(ISwapRouter02.exactInputSingle,
            (ISwapRouter02.ExactInputSingleParams(DAI, WETH, 3000, DEPLOYED, routes[0].amountIn, type(uint256).max, 0)));
        _approveMixedInputs(routes, DEPLOYED);
        DustSwapSweepRouterOptimism.SweepParams memory params = _nativeParams(quote - daiQuote);
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        vm.recordLogs();
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        _assertPartialSettlement(routes, quote - daiQuote, gross, fee, net);
        emit log_named_uint("deployed partial native gross wei", gross);
        emit log_named_uint("deployed partial collector WETH fee wei", fee);
        emit log_named_uint("deployed partial recipient ETH net wei", net);
        emit log_named_uint("deployed refunded DAI amount wei", routes[0].amountIn);
    }

    function _runDeployedAggregator(string memory provider, address expectedTarget) internal {
        _skipUnlessEnabled();
        vm.skip(vm.envOr("DUST_SWEEP_OPTIMISM_DEPLOYED_AGGREGATOR_FORK_TESTS", uint256(0)) == 0,
            "Run VerifyOptimismAggregators.ps1 -RouterAddress with the deployed router");
        string memory fixture = vm.readFile("out/optimism-deployed-aggregator-fixture.json");
        assertEq(vm.parseJsonAddress(fixture, ".taker"), DEPLOYED);
        assertEq(vm.parseJsonUint(fixture, ".forkBlock"), block.number);
        string memory key = string.concat(".", provider);
        address target = vm.parseJsonAddress(fixture, string.concat(key, ".target"));
        assertEq(target, expectedTarget);
        assertEq(vm.parseJsonAddress(fixture, string.concat(key, ".spender")), expectedTarget);
        uint256 minimum = vm.parseJsonUint(fixture, string.concat(key, ".minimum"));
        assertGt(minimum, 0);
        DustSwapSweepRouterOptimism.SweepRoute[] memory routes = new DustSwapSweepRouterOptimism.SweepRoute[](1);
        routes[0] = DustSwapSweepRouterOptimism.SweepRoute(WETH, AMOUNT_IN, target, target, 0,
            vm.parseJsonBytes(fixture, string.concat(key, ".data")));
        DustSwapSweepRouterOptimism.SweepParams memory params = DustSwapSweepRouterOptimism.SweepParams(
            USDC, recipient, minimum, block.timestamp + 1200, 200);
        ISignatureTransfer.PermitBatchTransferFrom memory permit;
        permit.permitted = new ISignatureTransfer.TokenPermissions[](0);
        vm.prank(user);
        IERC20(WETH).approve(DEPLOYED, AMOUNT_IN);
        vm.recordLogs();
        vm.prank(user);
        (uint256 gross, uint256 fee, uint256 net) = router.sweep(
            DustSwapSweepRouterOptimism.SweepMode.Allowance, routes, params, permit, ""
        );
        assertGe(gross, minimum);
        assertEq(fee, gross * 200 / 10_000);
        assertEq(IERC20(USDC).balanceOf(COLLECTOR) - collectorUsdcInitial, fee);
        assertEq(IERC20(USDC).balanceOf(recipient) - recipientUsdcInitial, net);
        assertEq(IERC20(USDC).balanceOf(DEPLOYED), routerInputInitial[USDC]);
        assertEq(IERC20(WETH).balanceOf(DEPLOYED), routerInputInitial[WETH]);
        assertEq(IERC20(WETH).allowance(user, DEPLOYED), 0);
        assertEq(IERC20(WETH).allowance(DEPLOYED, target), 0);
        uint256 refund;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == DEPLOYED && logs[i].topics[0] == keccak256("InputRefunded(address,address,uint256)")) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), WETH);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), user);
                refund += abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(IERC20(WETH).balanceOf(user), refund);
        assertLt(refund, AMOUNT_IN);
        _assertEventsFromLogs(1, logs);
        emit log_named_uint(string.concat("deployed ", provider, " USDC gross"), gross);
        emit log_named_uint(string.concat("deployed ", provider, " WETH refund"), refund);
    }

    function testDeployedAggregatorKyber() public { _runDeployedAggregator("kyber", KYBER); }
    function testDeployedAggregatorLifi() public { _runDeployedAggregator("lifi", LIFI); }
}
