// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IMemeFunHook} from "./interfaces/IMemeFunHook.sol";
import {HookDataLib} from "./libraries/HookDataLib.sol";

/// @title MemeFunRouter
/// @notice The memefun app's way to trade: exact-input buys and sells on registered coin markets, with
///         a minimum output, a deadline and an optional referrer.
///
/// @dev Review notes:
///
///      1. IT NEVER HOLDS FUNDS. Input goes straight from the payer to the PoolManager and output
///         straight from the PoolManager to the recipient, inside one unlock. Only native ETH
///         passes through, as `msg.value`, and anything a swap did not use is refunded in the
///         same call.
///
///      2. IT IS THE ONLY CALLER WHOSE hookData THE HOOK TRUSTS. It always encodes the real
///         `msg.sender` as the trader, so a referral can be honored and self-referral dropped.
///         Every other route (Uniswap's router, aggregators) works too, at the same fee, but its
///         referral share stays with the platform.
///
///      3. NO CALLER-SET PRICE LIMIT. Swaps may traverse the full v4 price range and enforce
///         `minAmountOut`. If the finite launch range exhausts, unused native input is refunded;
///         unused token input is never transferred. Exact-input buy fees use the requested input.
///
///      4. PERMITS ARE BEST EFFORT. `*WithPermit` tries the ERC-2612 permit and continues if it
///         fails, so a front-run permit cannot block the trade; the transfer itself still needs a
///         valid allowance.
///
///      5. CALLDATA SUFFIXES ARE IGNORED. The app appends the ERC-8021 builder-code suffix to every
///         call; ABI decoding ignores trailing bytes, which the test suite asserts.
contract MemeFunRouter is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;

    struct TradeParams {
        address coin;
        /// Exact input: quote units for a buy, coin units for a sell.
        uint256 amountIn;
        uint256 minAmountOut;
        /// Receives the output; address(0) means msg.sender.
        address recipient;
        /// Earns the referral share of the platform fee; ignored when it is the trader.
        address referrer;
        uint256 deadline;
    }

    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Callback {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minAmountOut;
        address payer;
        address recipient;
        address referrer;
    }

    error Expired();
    error ZeroAmount();
    error AmountTooLarge(uint256 amount);
    error WrongValue(uint256 expected, uint256 received);
    error InsufficientOutput(uint256 minAmountOut, uint256 amountOut);
    error NotPoolManager();
    error EthTransferFailed();

    constructor(IPoolManager poolManager_, IMemeFunHook hook_) {
        poolManager = poolManager_;
        hook = hook_;
    }

    /// @notice Buys `p.coin` with exactly `p.amountIn` of its pair asset (send it as msg.value when
    ///         the pair is ETH; approve this router otherwise).
    function buy(TradeParams calldata p) external payable nonReentrant returns (uint256 amountOut) {
        return _trade(p, true, hook.poolKeyOf(p.coin));
    }

    /// @notice Sells exactly `p.amountIn` of `p.coin` for its pair asset. Approve this router first.
    function sell(TradeParams calldata p) external nonReentrant returns (uint256 amountOut) {
        return _trade(p, false, hook.poolKeyOf(p.coin));
    }

    function buyFor(
        TradeParams calldata p,
        address quote
    )
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        return _trade(p, true, hook.poolKeyFor(p.coin, quote));
    }

    function sellFor(
        TradeParams calldata p,
        address quote
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        return _trade(p, false, hook.poolKeyFor(p.coin, quote));
    }

    /// @notice `buy` for ERC-20 pairs (USDC, stocks) with an ERC-2612 permit instead of an approval.
    function buyWithPermit(
        TradeParams calldata p,
        Permit calldata permit
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        _tryPermit(Currency.unwrap(hook.quoteCurrencyOf(p.coin)), permit);
        return _trade(p, true, hook.poolKeyOf(p.coin));
    }

    /// @notice `sell` with an ERC-2612 permit on the coin, so a sale is one signature and one
    ///         transaction.
    function sellWithPermit(
        TradeParams calldata p,
        Permit calldata permit
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        _tryPermit(p.coin, permit);
        return _trade(p, false, hook.poolKeyOf(p.coin));
    }

    function buyForWithPermit(
        TradeParams calldata p,
        address quote,
        Permit calldata permit
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        PoolKey memory key = hook.poolKeyFor(p.coin, quote);
        _tryPermit(quote, permit);
        return _trade(p, true, key);
    }

    function sellForWithPermit(
        TradeParams calldata p,
        address quote,
        Permit calldata permit
    )
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        PoolKey memory key = hook.poolKeyFor(p.coin, quote);
        _tryPermit(p.coin, permit);
        return _trade(p, false, key);
    }

    /// @dev Only reachable through this contract's own unlock.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Callback memory c = abi.decode(data, (Callback));

        BalanceDelta delta = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -int256(c.amountIn),
                sqrtPriceLimitX96: c.zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            HookDataLib.encode(c.payer, c.referrer)
        );
        uint256 owed = uint256(-int256(c.zeroForOne ? delta.amount0() : delta.amount1()));
        uint256 amountOut = uint256(int256(c.zeroForOne ? delta.amount1() : delta.amount0()));
        if (amountOut < c.minAmountOut) revert InsufficientOutput(c.minAmountOut, amountOut);

        Currency input = c.zeroForOne ? c.key.currency0 : c.key.currency1;
        Currency output = c.zeroForOne ? c.key.currency1 : c.key.currency0;
        if (input.isAddressZero()) {
            poolManager.settle{value: owed}();
        } else {
            poolManager.sync(input);
            IERC20(Currency.unwrap(input)).safeTransferFrom(c.payer, address(poolManager), owed);
            poolManager.settle();
        }
        poolManager.take(output, c.recipient, amountOut);
        return abi.encode(amountOut, owed);
    }

    function _trade(
        TradeParams calldata p,
        bool isBuy,
        PoolKey memory key
    )
        private
        returns (uint256 amountOut)
    {
        if (block.timestamp > p.deadline) revert Expired();
        if (p.amountIn == 0) revert ZeroAmount();
        // A narrowing signed cast would reinterpret oversized input as exact output.
        if (p.amountIn > uint256(type(int256).max)) revert AmountTooLarge(p.amountIn);

        Currency quote = hook.quoteCurrencyOfPool(key.toId());
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(quote);
        uint256 expectedValue = isBuy && quote.isAddressZero() ? p.amountIn : 0;
        if (msg.value != expectedValue) revert WrongValue(expectedValue, msg.value);

        uint256 spent;
        (amountOut, spent) = abi.decode(
            poolManager.unlock(
                abi.encode(
                    Callback({
                        key: key,
                        // A buy sends the quote in, a sell sends the coin in.
                        zeroForOne: isBuy == quoteIsCurrency0,
                        amountIn: p.amountIn,
                        minAmountOut: p.minAmountOut,
                        payer: msg.sender,
                        recipient: p.recipient == address(0) ? msg.sender : p.recipient,
                        referrer: p.referrer
                    })
                )
            ),
            (uint256, uint256)
        );
        // A swap without a price limit spends everything unless the pool runs out of coins.
        if (msg.value > spent) {
            (bool ok,) = msg.sender.call{value: msg.value - spent}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    function _tryPermit(address token, Permit calldata permit) private {
        try IERC20Permit(token)
            .permit(
                msg.sender,
                address(this),
                permit.value,
                permit.deadline,
                permit.v,
                permit.r,
                permit.s
            ) {}
            catch {}
    }
}
