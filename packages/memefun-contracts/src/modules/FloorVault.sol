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
/// @notice Destination module for floor-mode coins: each market's quote fees become permanent
///         buy-side liquidity below that market's price. Each band supports its own market;
///         it does not promise to buy the coin's entire circulating supply.
///
/// @dev Review notes:
///
///      1. PERMANENT. Each `addFloorFor` places that market's accrued quote as a single-sided
///         position the vault owns forever. No code path can remove it, and the hook rejects removals
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
///      4. THE FLOOR RATCHETS UP PER MARKET. As its price grows, new deposits land higher;
///         `floorNearTickFor` keeps the edge of its highest band. Balances, bands and cooldowns
///         stay separate per pool even when several markets trade the same coin.
contract FloorVault is IUnlockCallback, ReentrancyGuardTransient {
    using StateLibrary for IPoolManager;

    uint256 public constant COOLDOWN = 1 hours;
    /// @notice Ticks for a 2x and a 10x price move (ln 2 and ln 10 over ln 1.0001, rounded up).
    int24 public constant NEAR_OFFSET = 6932;
    int24 public constant FAR_OFFSET = 23_027;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    IFeeVault public immutable feeVault;

    struct MarketBalance {
        uint256 balance;
        uint256 lastAdd;
        uint256 floored;
        int24 nearTick;
        bool hasFloor;
    }
    mapping(PoolId id => MarketBalance) private _markets;

    event FloorAdded(
        address indexed coin, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 quoteUsed
    );
    event MarketFloorAdded(
        address indexed coin,
        address indexed quote,
        PoolId indexed poolId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 quoteUsed
    );

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

    function balanceOf(address coin) external view returns (uint256) {
        return _markets[_primary(coin)].balance;
    }

    function lastAddAt(address coin) external view returns (uint256) {
        return _markets[_primary(coin)].lastAdd;
    }

    function totalFloored(address coin) external view returns (uint256) {
        return _markets[_primary(coin)].floored;
    }

    function floorNearTick(address coin) external view returns (int24) {
        return _markets[_primary(coin)].nearTick;
    }

    function hasFloor(address coin) external view returns (bool) {
        return _markets[_primary(coin)].hasFloor;
    }

    function balanceOfFor(address coin, address quote) external view returns (uint256) {
        return _markets[hook.poolIdFor(coin, quote)].balance;
    }

    function lastAddAtFor(address coin, address quote) external view returns (uint256) {
        return _markets[hook.poolIdFor(coin, quote)].lastAdd;
    }

    function totalFlooredFor(address coin, address quote) external view returns (uint256) {
        return _markets[hook.poolIdFor(coin, quote)].floored;
    }

    function floorNearTickFor(address coin, address quote) external view returns (int24) {
        return _markets[hook.poolIdFor(coin, quote)].nearTick;
    }

    function hasFloorFor(address coin, address quote) external view returns (bool) {
        return _markets[hook.poolIdFor(coin, quote)].hasFloor;
    }

    function _primary(address coin) private view returns (PoolId) {
        return hook.creatorOf(coin) == address(0) ? PoolId.wrap(bytes32(0)) : hook.poolIdOf(coin);
    }

    /// @notice Places the coin's accrued fees as floor liquidity 50-90% under the price.
    function addFloor(address coin)
        external
        nonReentrant
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 used)
    {
        return _addFloor(coin, hook.poolIdOf(coin));
    }

    function addFloorFor(
        address coin,
        address quote
    )
        external
        nonReentrant
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 used)
    {
        return _addFloor(coin, hook.poolIdFor(coin, quote));
    }

    function _addFloor(
        address coin,
        PoolId id
    )
        private
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 used)
    {
        IMemeFunHook.PoolConfig memory c = hook.configOfPool(id);
        if (c.mode != Mode.FLOOR || c.module != address(this)) revert NotFloorCoin(coin);
        MarketBalance storage book = _markets[id];
        uint256 nextAt = book.lastAdd + COOLDOWN;
        if (book.lastAdd != 0 && block.timestamp < nextAt) revert CoolingDown(nextAt);

        address quoteAddress = Currency.unwrap(hook.quoteCurrencyOfPool(id));
        uint256 amount = book.balance + feeVault.pullDestinationFor(coin, quoteAddress);
        if (amount == 0) revert NothingToAdd();

        PoolKey memory key = hook.poolKeyOfPool(id);
        (tickLower, tickUpper) = _band(id, c.quoteIsCurrency0);

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        liquidity = c.quoteIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, amount);
        if (liquidity == 0) revert NothingToAdd();

        // Book-keeping first: the cooldown starts and the pot is spoken for before the add.
        book.lastAdd = block.timestamp;
        book.balance = 0;
        used = abi.decode(
            poolManager.unlock(
                abi.encode(key, c.quoteIsCurrency0, tickLower, tickUpper, liquidity)
            ),
            (uint256)
        );

        book.balance = amount - used;
        book.floored += used;
        int24 near = c.quoteIsCurrency0 ? tickLower : tickUpper;
        // The coin is pricier at lower ticks when the quote is currency0, at higher ticks otherwise.
        if (!book.hasFloor || (c.quoteIsCurrency0 ? near < book.nearTick : near > book.nearTick)) {
            book.nearTick = near;
            book.hasFloor = true;
        }
        emit MarketFloorAdded(coin, quoteAddress, id, tickLower, tickUpper, liquidity, used);
        if (PoolId.unwrap(id) == PoolId.unwrap(hook.poolIdOf(coin))) {
            emit FloorAdded(coin, tickLower, tickUpper, liquidity, used);
        }
    }

    /// @dev Only reachable through `addFloor`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (
            PoolKey memory key,
            bool quoteIsCurrency0,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity
        ) = abi.decode(data, (PoolKey, bool, int24, int24, uint128));
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
    function _band(
        PoolId id,
        bool quoteIsCurrency0
    )
        private
        view
        returns (int24 tickLower, int24 tickUpper)
    {
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
