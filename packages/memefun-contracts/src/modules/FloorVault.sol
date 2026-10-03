// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {IFeeVault} from "../interfaces/IFeeVault.sol";
import {IMemeFunHook} from "../interfaces/IMemeFunHook.sol";
import {LaunchMath} from "../libraries/LaunchMath.sol";
import {Mode} from "../types/MemeFunTypes.sol";

/// @title FloorVault
/// @notice Destination module for floor-mode coins: their fees become permanent buy-side liquidity
///         under the price, so sellers always meet a growing bid.
///
/// @dev Review notes:
///
///      1. PERMANENT. Each `addFloor` places the coin's accrued quote as a single-sided position the
///         vault owns forever. There is no code path to remove it, and the hook rejects removals
///         from everyone regardless.
///
///      2. QUOTE-ONLY, BELOW THE PRICE. The band runs from 50% to 90% under the reference price, so
///         it holds only the pair asset and can only buy the coin as the coin falls. The hook
///         enforces the quote-only shape on its side too.
///
///      3. A PUMP CANNOT LIFT THE FLOOR. The reference price is the cheaper of the live price and
///         the block-start price the hook records, and adds are spaced an hour apart, so raising
///         the price within a block does not raise the band.
///
///      4. THE FLOOR RATCHETS UP. As the coin grows, new deposits land higher; `floorNearTick` keeps
///         the edge of the highest band so the app can show the price the floor supports.
contract FloorVault is IUnlockCallback, ReentrancyGuardTransient {
    using StateLibrary for IPoolManager;

    uint256 public constant COOLDOWN = 1 hours;
    /// @notice Ticks for a 2x and a 10x price move (ln 2 and ln 10 over ln 1.0001, rounded up).
    int24 public constant NEAR_OFFSET = 6_932;
    int24 public constant FAR_OFFSET = 23_027;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    IFeeVault public immutable feeVault;

    mapping(address coin => uint256) public balanceOf;
    mapping(address coin => uint256) public lastAddAt;
    mapping(address coin => uint256) public totalFloored;
    /// @notice Edge of the highest floor band (the coin price the floor supports), 0 before the first.
    mapping(address coin => int24) public floorNearTick;
    mapping(address coin => bool) public hasFloor;

    event FloorAdded(address indexed coin, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 quoteUsed);

    error NotFloorCoin(address coin);
    error CoolingDown(uint256 nextAt);
    error NothingToAdd();
    error BandOutOfRange();
    error NotPoolManager();

    constructor(IPoolManager poolManager_, IMemeFunHook hook_, IFeeVault feeVault_) {
        poolManager = poolManager_;
        hook = hook_;
        feeVault = feeVault_;
    }

    /// @notice Places the coin's accrued fees as floor liquidity 50-90% under the price.
    function addFloor(address coin)
        external
        nonReentrant
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 used)
    {
        IMemeFunHook.PoolConfig memory c = hook.configOf(coin);
        if (c.mode != Mode.FLOOR || c.module != address(this)) revert NotFloorCoin(coin);
        uint256 nextAt = lastAddAt[coin] + COOLDOWN;
        if (lastAddAt[coin] != 0 && block.timestamp < nextAt) revert CoolingDown(nextAt);

        uint256 amount = balanceOf[coin] + feeVault.pullDestination(coin);
        if (amount == 0) revert NothingToAdd();

        PoolKey memory key = hook.poolKeyOf(coin);
        PoolId id = key.toId();
        (tickLower, tickUpper) = _band(id, c.quoteIsCurrency0);

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        liquidity = c.quoteIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, amount);
        if (liquidity == 0) revert NothingToAdd();

        // Book-keeping first: the cooldown starts and the pot is spoken for before the add.
        lastAddAt[coin] = block.timestamp;
        balanceOf[coin] = 0;
        used = abi.decode(poolManager.unlock(abi.encode(key, c.quoteIsCurrency0, tickLower, tickUpper, liquidity)), (uint256));

        balanceOf[coin] = amount - used;
        totalFloored[coin] += used;
        int24 near = c.quoteIsCurrency0 ? tickLower : tickUpper;
        // The coin is pricier at lower ticks when the quote is currency0, at higher ticks otherwise.
        if (!hasFloor[coin] || (c.quoteIsCurrency0 ? near < floorNearTick[coin] : near > floorNearTick[coin])) {
            floorNearTick[coin] = near;
            hasFloor[coin] = true;
        }
        emit FloorAdded(coin, tickLower, tickUpper, liquidity, used);
    }

    /// @dev Only reachable through `addFloor`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool quoteIsCurrency0, int24 tickLower, int24 tickUpper, uint128 liquidity) =
            abi.decode(data, (PoolKey, bool, int24, int24, uint128));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        uint256 owed = uint256(-int256(quoteIsCurrency0 ? delta.amount0() : delta.amount1()));
        Currency quote = quoteIsCurrency0 ? key.currency0 : key.currency1;
        poolManager.burn(address(this), quote.toId(), owed);
        return abi.encode(owed);
    }

    /// @dev Band 2x-10x cheaper than the reference price, snapped inward to the tick spacing.
    function _band(PoolId id, bool quoteIsCurrency0) private view returns (int24 tickLower, int24 tickUpper) {
        (uint160 current,,,) = poolManager.getSlot0(id);
        uint160 start = hook.blockStartSqrtPriceX96(id);
        int24 spacing = LaunchMath.TICK_SPACING;
        if (quoteIsCurrency0) {
            // Coin is currency1: a cheaper coin is a higher sqrt price.
            int24 ref = TickMath.getTickAtSqrtPrice(current > start ? current : start);
            tickLower = _ceil(ref + NEAR_OFFSET, spacing);
            tickUpper = _floor(_min(ref + FAR_OFFSET, LaunchMath.MAX_USABLE_TICK), spacing);
        } else {
            // Coin is currency0: a cheaper coin is a lower sqrt price.
            int24 ref = TickMath.getTickAtSqrtPrice(current < start ? current : start);
            tickLower = _ceil(_max(ref - FAR_OFFSET, LaunchMath.MIN_USABLE_TICK), spacing);
            tickUpper = _floor(ref - NEAR_OFFSET, spacing);
        }
        if (tickLower >= tickUpper) revert BandOutOfRange();
    }

    function _floor(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }

    function _ceil(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick > 0 && tick % spacing != 0) compressed++;
        return compressed * spacing;
    }

    function _min(int24 a, int24 b) private pure returns (int24) {
        return a < b ? a : b;
    }

    function _max(int24 a, int24 b) private pure returns (int24) {
        return a > b ? a : b;
    }
}
