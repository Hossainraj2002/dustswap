// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";

import {MemeFunConfig} from "./MemeFunConfig.sol";
import {IMemeFunHook} from "./interfaces/IMemeFunHook.sol";
import {LaunchMath} from "./libraries/LaunchMath.sol";
import {Mode} from "./types/MemeFunTypes.sol";

/// @title MemeFunFactory
/// @notice Launches a memefun coin in one transaction: a native B20 with no admin and a fixed
///         supply, its whole supply locked forever in one Uniswap v4 position, and optionally the
///         creator's first buy.
///
/// @dev Review notes:
///
///      1. THE COIN HAS NO OWNER, EVER. It is created with `initialAdmin = address(0)` and no role
///         grant in its init calls. The calls that do run (cap the supply at the supply, mint it
///         once to this factory, set the metadata URI) are allowed only inside the B20 creation
///         window, which closes when `createB20` returns. Nobody can mint, pause, seize, rename or
///         re-point it afterwards, this factory and the memefun owner included.
///
///      2. THE COIN ADDRESS IS SCOPED TO ITS CREATOR. B20 addresses derive from (variant, caller,
///         salt), and the salt here is keccak256(creator, salt), so nobody can squat or front-run
///         a creator's predicted address.
///
///      3. THE WHOLE SUPPLY GOES INTO THE POOL. The factory adds one single-sided position holding
///         all of it (rounding dust, well under a millionth of a coin, goes to 0x...dEaD) and keeps
///         nothing. It has no function that could remove liquidity, and the hook rejects removals
///         from anyone regardless.
///
///      4. NOTHING A CREATOR CHOOSES CAN EXCEED THE OWNER'S BOUNDS, and nothing the owner sets can
///         reach a coin after launch: the terms are snapshotted into the hook here.
///
///      5. THE OPENING PRICE IS EXACT AND GUARDED. The start tick is computed on chain from the
///         quote's USD price (LaunchMath, mirrored by the app). The creator passes the tick the app
///         showed; the launch reverts if the price moved more than the allowed drift since.
contract MemeFunFactory is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IB20Factory public constant B20_FACTORY = IB20Factory(0xB20f000000000000000000000000000000000000);
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_URI_BYTES = 256;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    MemeFunConfig public immutable config;

    uint256 public launchCount;

    struct LaunchParams {
        string name;
        string symbol;
        /// ERC-7572 metadata URI (image, description, links). Immutable once set.
        string contractURI;
        /// Pair asset; address(0) is native ETH.
        address quote;
        Mode mode;
        uint16 feeBps;
        /// Community modes only: the creator's share of the destination side, in bps.
        uint16 creatorKeepBps;
        /// Creator-chosen salt; the coin address is scoped to msg.sender (see `predictCoin`).
        bytes32 salt;
        /// Optional first buy, in quote units. Pays the base fee, never launch protection.
        uint256 firstBuyAmount;
        uint256 firstBuyMinCoins;
        /// The start tick the app showed, and how far the live price may have moved from it.
        int24 expectedStartTick;
        uint24 maxTickDrift;
        uint256 deadline;
    }

    /// @notice Every immutable term of a launch, for indexers.
    struct LaunchRecord {
        PoolId poolId;
        Mode mode;
        address module;
        uint256 feeBps;
        uint256 platformShareBps;
        uint256 referralShareBps;
        uint256 creatorKeepBps;
        uint256 protectionStartBps;
        uint256 protectionDurationSec;
        int24 startTick;
        uint128 liquidity;
        uint256 quoteUsdE8;
        uint256 openingFdvUsdE8;
        uint256 firstBuyQuote;
        uint256 firstBuyCoins;
    }

    struct Callback {
        PoolKey key;
        bool coinIsCurrency0;
        int24 startTick;
        uint128 liquidity;
        address creator;
        uint256 firstBuyAmount;
        uint256 firstBuyMinCoins;
    }

    event Launched(
        address indexed coin,
        address indexed creator,
        address indexed quote,
        string name,
        string symbol,
        string contractURI,
        LaunchRecord record
    );

    error LaunchesPaused();
    error Expired();
    error QuoteNotLaunchable(address quote);
    error ModeNotEnabled(Mode mode);
    error FeeOutOfBounds(uint256 feeBps, uint256 minBps, uint256 maxBps);
    error CreatorKeepNotAllowed(uint256 keepBps, uint256 maxBps);
    error InvalidName();
    error InvalidSymbol();
    error InvalidUri();
    error WrongValue(uint256 expected, uint256 received);
    error StartTickDrift(int24 expected, int24 actual);
    error FirstBuySlippage(uint256 minCoins, uint256 coins);
    error CoinSetupFailed();
    error NotPoolManager();
    error EthTransferFailed();

    constructor(IPoolManager poolManager_, IMemeFunHook hook_, MemeFunConfig config_) {
        poolManager = poolManager_;
        hook = hook_;
        config = config_;
    }

    /// @notice The address `creator` will get for `salt`, so the app can show it before launch.
    function predictCoin(address creator, bytes32 salt) external view returns (address) {
        return B20_FACTORY.getB20Address(IB20Factory.B20Variant.ASSET, address(this), _scopedSalt(creator, salt));
    }

    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address coin, PoolId poolId, uint256 coinsBought)
    {
        MemeFunConfig.LaunchTerms memory terms = config.launchTerms();
        address module = _validate(p, terms);
        unchecked {
            ++launchCount;
        }

        // Opening price, computed exactly and checked against what the creator saw.
        uint256 quoteUsdE8 = config.quotePriceUsdE8(p.quote);
        uint256 openingFdvUsdE8 = config.openingFdvUsdE8();
        coin = _createCoin(p, msg.sender);
        bool coinIsCurrency0 = uint160(coin) < uint160(p.quote);
        int24 startTick = LaunchMath.startTick(quoteUsdE8, config.quote(p.quote).decimals, coinIsCurrency0, openingFdvUsdE8);
        _checkDrift(p.expectedStartTick, startTick, p.maxTickDrift);
        uint128 liquidity = LaunchMath.liquidityForSupply(startTick, coinIsCurrency0);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(coinIsCurrency0 ? coin : p.quote),
            currency1: Currency.wrap(coinIsCurrency0 ? p.quote : coin),
            fee: 0,
            tickSpacing: LaunchMath.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
        uint256 keepBps = p.mode == Mode.CREATOR ? 0 : p.creatorKeepBps;
        hook.registerPool(
            key,
            IMemeFunHook.PoolConfig({
                coin: coin,
                quoteIsCurrency0: !coinIsCurrency0,
                mode: p.mode,
                feeBps: p.feeBps,
                platformShareBps: terms.platformShareBps,
                referralShareBps: terms.referralShareBps,
                creatorKeepBps: uint16(keepBps),
                protectionStartBps: terms.protectionStartBps,
                module: module,
                launchedAt: 0,
                protectionDurationSec: terms.protectionDurationSec,
                seeded: false
            }),
            msg.sender
        );
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));

        uint256 quoteSpent;
        (coinsBought, quoteSpent) = abi.decode(
            poolManager.unlock(
                abi.encode(
                    Callback({
                        key: key,
                        coinIsCurrency0: coinIsCurrency0,
                        startTick: startTick,
                        liquidity: liquidity,
                        creator: msg.sender,
                        firstBuyAmount: p.firstBuyAmount,
                        firstBuyMinCoins: p.firstBuyMinCoins
                    })
                )
            ),
            (uint256, uint256)
        );

        // Rounding dust from sizing the position: provably out of circulation, never kept.
        uint256 dust = IERC20(coin).balanceOf(address(this));
        if (dust != 0) IERC20(coin).safeTransfer(DEAD, dust);

        emit Launched(
            coin,
            msg.sender,
            p.quote,
            p.name,
            p.symbol,
            p.contractURI,
            LaunchRecord({
                poolId: poolId,
                mode: p.mode,
                module: module,
                feeBps: p.feeBps,
                platformShareBps: terms.platformShareBps,
                referralShareBps: terms.referralShareBps,
                creatorKeepBps: keepBps,
                protectionStartBps: terms.protectionStartBps,
                protectionDurationSec: terms.protectionDurationSec,
                startTick: startTick,
                liquidity: liquidity,
                quoteUsdE8: quoteUsdE8,
                openingFdvUsdE8: openingFdvUsdE8,
                firstBuyQuote: quoteSpent,
                firstBuyCoins: coinsBought
            })
        );

        // ETH leaves last: the creation fee to the treasury, then anything a partial first buy left.
        if (terms.creationFee != 0) _sendEth(config.treasury(), terms.creationFee);
        if (p.quote == address(0) && quoteSpent < p.firstBuyAmount) _sendEth(msg.sender, p.firstBuyAmount - quoteSpent);
    }

    /// @dev Seeds the launch position and runs the optional first buy. Only reachable through
    ///      `launch`: the PoolManager calls back the contract that unlocked it.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Callback memory c = abi.decode(data, (Callback));
        Currency coinCurrency = c.coinIsCurrency0 ? c.key.currency0 : c.key.currency1;
        Currency quoteCurrency = c.coinIsCurrency0 ? c.key.currency1 : c.key.currency0;

        // 1. The whole supply, single-sided, from the opening price to the end of the range.
        (int24 tickLower, int24 tickUpper) = LaunchMath.launchRange(c.startTick, c.coinIsCurrency0);
        (BalanceDelta added,) = poolManager.modifyLiquidity(
            c.key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(c.liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        uint256 coinOwed = uint256(-int256(c.coinIsCurrency0 ? added.amount0() : added.amount1()));
        poolManager.sync(coinCurrency);
        IERC20(Currency.unwrap(coinCurrency)).safeTransfer(address(poolManager), coinOwed);
        poolManager.settle();

        if (c.firstBuyAmount == 0) return abi.encode(uint256(0), uint256(0));

        // 2. The creator's first buy: exact input, quote for coin, at the base fee.
        bool zeroForOne = !c.coinIsCurrency0;
        BalanceDelta swapped = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(c.firstBuyAmount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 quoteSpent = uint256(-int256(c.coinIsCurrency0 ? swapped.amount1() : swapped.amount0()));
        uint256 coins = uint256(int256(c.coinIsCurrency0 ? swapped.amount0() : swapped.amount1()));
        if (coins < c.firstBuyMinCoins) revert FirstBuySlippage(c.firstBuyMinCoins, coins);

        if (quoteCurrency.isAddressZero()) {
            poolManager.settle{value: quoteSpent}();
        } else {
            poolManager.sync(quoteCurrency);
            IERC20(Currency.unwrap(quoteCurrency)).safeTransferFrom(c.creator, address(poolManager), quoteSpent);
            poolManager.settle();
        }
        poolManager.take(coinCurrency, c.creator, coins);
        return abi.encode(coins, quoteSpent);
    }

    // -------------------------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------------------------

    function _validate(LaunchParams calldata p, MemeFunConfig.LaunchTerms memory terms)
        private
        view
        returns (address module)
    {
        if (terms.launchesPaused) revert LaunchesPaused();
        if (block.timestamp > p.deadline) revert Expired();
        if (!config.isLaunchableQuote(p.quote)) revert QuoteNotLaunchable(p.quote);

        MemeFunConfig.ModeInfo memory info = config.modeInfo(p.mode);
        if (!info.enabled || (p.mode != Mode.CREATOR && info.module == address(0))) revert ModeNotEnabled(p.mode);
        module = info.module;

        if (p.feeBps < terms.feeMinBps || p.feeBps > terms.feeMaxBps) {
            revert FeeOutOfBounds(p.feeBps, terms.feeMinBps, terms.feeMaxBps);
        }
        uint256 maxKeep = p.mode == Mode.CREATOR ? 0 : terms.creatorKeepMaxBps;
        if (p.creatorKeepBps > maxKeep) revert CreatorKeepNotAllowed(p.creatorKeepBps, maxKeep);

        uint256 nameLength = bytes(p.name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_BYTES) revert InvalidName();
        uint256 symbolLength = bytes(p.symbol).length;
        if (symbolLength == 0 || symbolLength > MAX_SYMBOL_BYTES) revert InvalidSymbol();
        if (bytes(p.contractURI).length > MAX_URI_BYTES) revert InvalidUri();

        uint256 expectedValue = terms.creationFee + (p.quote == address(0) ? p.firstBuyAmount : 0);
        if (msg.value != expectedValue) revert WrongValue(expectedValue, msg.value);
    }

    function _createCoin(LaunchParams calldata p, address creator) private returns (address coin) {
        bytes[] memory initCalls = new bytes[](3);
        initCalls[0] = B20FactoryLib.encodeUpdateSupplyCap(LaunchMath.SUPPLY);
        initCalls[1] = abi.encodeCall(IB20.mint, (address(this), LaunchMath.SUPPLY));
        initCalls[2] = B20FactoryLib.encodeUpdateContractURI(p.contractURI);
        coin = B20_FACTORY.createB20(
            IB20Factory.B20Variant.ASSET,
            _scopedSalt(creator, p.salt),
            B20FactoryLib.encodeAssetCreateParams(p.name, p.symbol, address(0), 18),
            initCalls
        );
        if (IB20(coin).totalSupply() != LaunchMath.SUPPLY || IB20(coin).balanceOf(address(this)) != LaunchMath.SUPPLY) {
            revert CoinSetupFailed();
        }
    }

    function _checkDrift(int24 expected, int24 actual, uint24 maxDrift) private pure {
        uint256 drift = expected > actual
            ? uint256(int256(expected) - int256(actual))
            : uint256(int256(actual) - int256(expected));
        if (drift > maxDrift) revert StartTickDrift(expected, actual);
    }

    function _scopedSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
