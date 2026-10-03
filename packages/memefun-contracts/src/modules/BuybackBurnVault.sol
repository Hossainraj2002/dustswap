// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IFeeVault} from "../interfaces/IFeeVault.sol";
import {IMemeFunHook} from "../interfaces/IMemeFunHook.sol";
import {Mode} from "../types/MemeFunTypes.sol";

/// @title BuybackBurnVault
/// @notice Destination module for burn-mode coins: their fees buy the coin back from its own
///         pool, and every coin bought goes to 0x...dEaD, out of circulation for good.
///
/// @dev Review notes:
///
///      1. PERMISSIONLESS. A memefun keeper calls `executeBuyback` on a schedule, but anyone may, so
///         buybacks cannot stall if the keeper stops. Callers gain nothing from calling it.
///
///      2. HARD TO STEER. A buyback refuses to run if the coin was pumped earlier in the same block
///         (live price vs. the block-start price the hook records), and each run may move the price
///         at most about 2% (a swap price limit; whatever is not spent waits for the next run).
///         A 10-minute cooldown spaces runs out. Together these leave nothing for a sandwich or a
///         pump-and-trigger to extract beyond ordinary trading fees.
///
///      3. FEE-EXEMPT AND HOLDS NOTHING. The hook charges this vault no fee on its own coin's
///         buybacks. Quote is held as ERC-6909 claims and spent by burning them; bought coins are
///         taken straight to dEaD. The vault never holds the coin.
///
///      4. PER-COIN ACCOUNTING. Claims are fungible per currency, so the vault tracks each coin's
///         share and only ever spends a coin's own fees on that coin.
contract BuybackBurnVault is IUnlockCallback, ReentrancyGuardTransient {
    using StateLibrary for IPoolManager;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant COOLDOWN = 10 minutes;
    /// @notice Largest move of the sqrt price since block start, toward a pricier coin, that still
    ///         allows a buyback: 50 bps of sqrt price is about 1% of price.
    uint256 public constant MAX_PUMP_SQRT_BPS = 50;
    /// @notice Largest sqrt-price move one buyback may cause: 100 bps is about 2% of price.
    uint256 public constant MAX_IMPACT_SQRT_BPS = 100;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    IFeeVault public immutable feeVault;

    mapping(address coin => uint256) public balanceOf;
    mapping(address coin => uint256) public lastBuybackAt;
    mapping(address coin => uint256) public totalSpent;
    mapping(address coin => uint256) public totalBurned;

    event Buyback(address indexed coin, uint256 quoteSpent, uint256 coinsBurned, uint256 quoteLeft);

    error NotBurnCoin(address coin);
    error CoolingDown(uint256 nextAt);
    error PricePumped(uint160 blockStartSqrtPriceX96, uint160 currentSqrtPriceX96);
    error NothingToBuy();
    error NotPoolManager();

    constructor(IPoolManager poolManager_, IMemeFunHook hook_, IFeeVault feeVault_) {
        poolManager = poolManager_;
        hook = hook_;
        feeVault = feeVault_;
    }

    /// @notice Spends the coin's accrued fees on its own coin and burns what it buys.
    function executeBuyback(address coin) external nonReentrant returns (uint256 spent, uint256 burned) {
        IMemeFunHook.PoolConfig memory c = hook.configOf(coin);
        if (c.mode != Mode.BURN || c.module != address(this)) revert NotBurnCoin(coin);
        uint256 nextAt = lastBuybackAt[coin] + COOLDOWN;
        if (lastBuybackAt[coin] != 0 && block.timestamp < nextAt) revert CoolingDown(nextAt);

        uint256 amount = balanceOf[coin] + feeVault.pullDestination(coin);
        if (amount == 0) revert NothingToBuy();

        PoolKey memory key = hook.poolKeyOf(coin);
        PoolId id = key.toId();
        (uint160 current,,,) = poolManager.getSlot0(id);
        uint160 start = hook.blockStartSqrtPriceX96(id);
        // Buying moves the price toward a pricier coin: down in sqrt price when the quote is
        // currency0, up when it is currency1. Refuse if that move already happened this block.
        bool zeroForOne = c.quoteIsCurrency0;
        bool pumped = zeroForOne
            ? uint256(current) * 10_000 < uint256(start) * (10_000 - MAX_PUMP_SQRT_BPS)
            : uint256(current) * 10_000 > uint256(start) * (10_000 + MAX_PUMP_SQRT_BPS);
        if (pumped) revert PricePumped(start, current);

        uint160 limit = zeroForOne
            ? uint160(uint256(current) * (10_000 - MAX_IMPACT_SQRT_BPS) / 10_000)
            : uint160(uint256(current) * (10_000 + MAX_IMPACT_SQRT_BPS) / 10_000);

        // Book-keeping first: the cooldown starts and the pot is spoken for before the swap.
        lastBuybackAt[coin] = block.timestamp;
        balanceOf[coin] = 0;
        (spent, burned) = abi.decode(poolManager.unlock(abi.encode(key, zeroForOne, amount, limit)), (uint256, uint256));

        balanceOf[coin] = amount - spent;
        totalSpent[coin] += spent;
        totalBurned[coin] += burned;
        emit Buyback(coin, spent, burned, amount - spent);
    }

    /// @dev Only reachable through `executeBuyback`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amount, uint160 limit) =
            abi.decode(data, (PoolKey, bool, uint256, uint160));

        BalanceDelta delta = poolManager.swap(
            key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}), ""
        );
        uint256 spent = uint256(-int256(zeroForOne ? delta.amount0() : delta.amount1()));
        uint256 bought = uint256(int256(zeroForOne ? delta.amount1() : delta.amount0()));
        Currency quote = zeroForOne ? key.currency0 : key.currency1;
        Currency coin = zeroForOne ? key.currency1 : key.currency0;

        // Pay with the fee claims; send every coin bought to dEaD.
        if (spent != 0) poolManager.burn(address(this), quote.toId(), spent);
        if (bought != 0) poolManager.take(coin, DEAD, bought);
        return abi.encode(spent, bought);
    }
}
