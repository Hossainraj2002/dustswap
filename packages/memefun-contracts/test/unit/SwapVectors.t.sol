// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {TestToken} from "../utils/TestTokens.sol";

/// @notice Replays test/vectors/swaps.json, written by apps/memefun/scripts/vectors.ts from the
///         app's swap engine (src/core/uniswap/swap.ts), on a real v4 PoolManager: a fee-0,
///         spacing-200 pool like every memefun pool, built and traded op by op. Every swap must
///         match to the unit in input used, output, price and tick, so the amounts the app quotes
///         (and the minimum outputs it signs) are the amounts the pool fills.
contract SwapVectorsTest is Test, IUnlockCallback {
    using StateLibrary for IPoolManager;

    uint8 internal constant ADD = 0;

    IPoolManager internal manager;
    PoolKey internal key;

    function setUp() public {
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        TestToken a = new TestToken("A", "A", 18);
        TestToken b = new TestToken("B", "B", 18);
        (TestToken t0, TestToken t1) = address(a) < address(b) ? (a, b) : (b, a);
        t0.mint(address(this), 1 << 250);
        t1.mint(address(this), 1 << 250);
        key = PoolKey(Currency.wrap(address(t0)), Currency.wrap(address(t1)), 0, 200, IHooks(address(0)));
    }

    function test_swapVectors() public {
        string memory json = vm.readFile("test/vectors/swaps.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGe(count, 100, "vectors present");
        uint256 swaps;
        for (uint256 i; i < count; ++i) {
            uint256 snapshot = vm.snapshotState();
            swaps += _replay(json, string.concat(".cases[", vm.toString(i), "]"));
            vm.revertToState(snapshot);
        }
        assertGe(swaps, 400, "swaps replayed");
    }

    function _replay(string memory json, string memory at) internal returns (uint256 swaps) {
        manager.initialize(key, uint160(vm.parseJsonUint(json, string.concat(at, ".sqrtPriceX96"))));
        uint256 ops = vm.parseJsonUint(json, string.concat(at, ".opCount"));
        for (uint256 j; j < ops; ++j) {
            string memory op = string.concat(at, ".ops[", vm.toString(j), "]");
            if (vm.parseJsonUint(json, string.concat(op, ".kind")) == ADD) {
                manager.unlock(
                    abi.encode(
                        ADD,
                        abi.encode(
                            int24(vm.parseJsonInt(json, string.concat(op, ".tickLower"))),
                            int24(vm.parseJsonInt(json, string.concat(op, ".tickUpper"))),
                            vm.parseJsonUint(json, string.concat(op, ".liquidity"))
                        )
                    )
                );
                continue;
            }
            bool zeroForOne = vm.parseJsonBool(json, string.concat(op, ".zeroForOne"));
            uint256 amountIn = vm.parseJsonUint(json, string.concat(op, ".amountIn"));
            (uint256 used, uint256 out) =
                abi.decode(manager.unlock(abi.encode(ADD + 1, abi.encode(zeroForOne, amountIn))), (uint256, uint256));
            (uint160 sqrtPriceX96, int24 tick,,) = manager.getSlot0(key.toId());
            assertEq(used, vm.parseJsonUint(json, string.concat(op, ".amountInUsed")), string.concat(op, " input used"));
            assertEq(out, vm.parseJsonUint(json, string.concat(op, ".amountOut")), string.concat(op, " output"));
            assertEq(sqrtPriceX96, vm.parseJsonUint(json, string.concat(op, ".sqrtPriceAfterX96")), string.concat(op, " price"));
            assertEq(tick, vm.parseJsonInt(json, string.concat(op, ".tickAfter")), string.concat(op, " tick"));
            ++swaps;
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only the PoolManager");
        (uint8 kind, bytes memory args) = abi.decode(data, (uint8, bytes));
        if (kind == ADD) {
            (int24 tickLower, int24 tickUpper, uint256 liquidity) = abi.decode(args, (int24, int24, uint256));
            (BalanceDelta delta,) = manager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(liquidity), salt: bytes32(0)
                }),
                ""
            );
            _settle(key.currency0, delta.amount0());
            _settle(key.currency1, delta.amount1());
            return "";
        }
        (bool zeroForOne, uint256 amountIn) = abi.decode(args, (bool, uint256));
        // No price limit, exactly like MemeFunRouter.
        BalanceDelta swapDelta = manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 input, int128 output) =
            zeroForOne ? (swapDelta.amount0(), swapDelta.amount1()) : (swapDelta.amount1(), swapDelta.amount0());
        _settle(key.currency0, swapDelta.amount0());
        _settle(key.currency1, swapDelta.amount1());
        return abi.encode(uint256(int256(-input)), uint256(int256(output)));
    }

    /// @dev Pays what this contract owes the pool and takes what the pool owes it.
    function _settle(Currency currency, int128 amount) private {
        if (amount < 0) {
            manager.sync(currency);
            TestToken(Currency.unwrap(currency)).transfer(address(manager), uint256(int256(-amount)));
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, address(this), uint256(int256(amount)));
        }
    }
}
