// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";

import {MemeFunTestBase} from "../utils/MemeFunTestBase.sol";

/// @notice M0 smoke test. Proves the pinned toolchain compiles together (v4-core, v4-periphery,
///         OpenZeppelin uniswap-hooks, base-std) and that the two facts the whole design rests on
///         hold: an admin-less B20 ends up with no role at all, and it works as a v4 currency.
contract ToolchainTest is MemeFunTestBase {
    address internal creator = makeAddr("creator");

    function test_adminlessCoin_hasFixedSupplyAndNoRoles() public {
        IB20 coin = _createAdminlessCoin(creator, bytes32(uint256(1)), "Toolchain Toad", "TOAD", address(this));

        assertEq(coin.totalSupply(), COIN_SUPPLY, "supply");
        assertEq(coin.balanceOf(address(this)), COIN_SUPPLY, "holder balance");
        assertEq(coin.supplyCap(), COIN_SUPPLY, "cap equals supply");
        assertEq(coin.decimals(), 18, "decimals");
        assertEq(coin.contractURI(), "ipfs://memefun-test", "uri");

        // Address shape: 0xB2 prefix, ASSET variant byte, and the coin sorts after USDC.
        assertEq(uint8(bytes20(address(coin))[0]), 0xB2, "B20 prefix");
        assertEq(uint8(bytes20(address(coin))[10]), 0x00, "ASSET variant byte");
        assertGt(uint160(address(coin)), uint160(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), "sorts after USDC");

        address[4] memory actors = [creator, address(this), address(B20_FACTORY), address(manager)];
        bytes32[9] memory roles = _allB20Roles();
        for (uint256 r; r < roles.length; ++r) {
            for (uint256 a; a < actors.length; ++a) {
                assertFalse(coin.hasRole(roles[r], actors[a]), "no role may exist");
            }
        }

        // With no role anywhere, the privileged surface is closed for everyone, creator included.
        vm.startPrank(creator);
        vm.expectRevert();
        coin.mint(creator, 1);
        vm.expectRevert();
        coin.updateSupplyCap(COIN_SUPPLY * 2);
        vm.expectRevert();
        coin.updateContractURI("ipfs://rug");
        vm.stopPrank();
    }

    function test_coinTradesAsUniswapV4Currency() public {
        IB20 coin = _createAdminlessCoin(creator, bytes32(uint256(2)), "Pool Pup", "PUP", address(this));
        coin.approve(address(modifyLiquidityRouter), type(uint256).max);
        coin.approve(address(swapRouter), type(uint256).max);

        // ETH (address 0) always sorts first, so the coin is currency1.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(coin)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });
        int24 startTick = 200_000;
        manager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));

        // Coin-only liquidity below the start price, the same shape a memefun launch uses.
        int24 tickLower = TickMath.minUsableTick(200);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(startTick), COIN_SUPPLY / 2
        );
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: startTick, liquidityDelta: int256(uint256(liquidity)), salt: 0}),
            ""
        );

        uint256 before = coin.balanceOf(address(this));
        BalanceDelta delta = swapRouter.swap{value: 0.1 ether}(
            key,
            _exactInput(true, 0.1 ether),
            _settingsNoClaims(),
            ""
        );
        assertEq(delta.amount0(), -0.1 ether, "paid exactly 0.1 ETH");
        assertGt(delta.amount1(), 0, "received coins");
        assertEq(coin.balanceOf(address(this)) - before, uint256(uint128(delta.amount1())), "coins arrived");
    }

    /// @dev Compile-time proof that OpenZeppelin's BaseHook builds against the pinned v4-core.
    function test_openZeppelinBaseHookIsLinked() public pure {
        assertTrue(BaseHook.getHookPermissions.selector != bytes4(0));
    }

    function _exactInput(bool zeroForOne, uint256 amount)
        private
        pure
        returns (SwapParams memory params)
    {
        params = SwapParams({
            zeroForOne: zeroForOne,
            // forge-lint: disable-next-line(unsafe-typecast)
            amountSpecified: -int256(amount),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _settingsNoClaims() private pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }
}

