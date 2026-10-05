// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
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
///         supply, its supply locked forever across one to five Uniswap v4 markets, and optional
///         creator first buys in each market.
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
///      3. THE WHOLE SUPPLY IS ALLOCATED AT LAUNCH. The factory splits it equally between distinct
///         listed quotes, with the final market receiving any raw-unit remainder. Each market gets
///         one single-sided position; rounding dust goes to 0x...dEaD and the factory keeps nothing.
///         It has no function that could remove liquidity, and the hook rejects every removal.
///
///      4. NOTHING A CREATOR CHOOSES CAN EXCEED THE OWNER'S BOUNDS, and nothing the owner sets can
///         reach a coin after launch: the terms are snapshotted into the hook here.
///
///      5. THE OPENING PRICE IS EXACT AND GUARDED. The start tick is computed on chain from the
///         quote's USD price (LaunchMath, mirrored by the app). The creator passes the tick the app
///         showed for each market; the launch reverts if any price exceeded its allowed drift.
///         Every market uses the same coin-wide opening FDV and total supply to price one coin.
contract MemeFunFactory is IUnlockCallback, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    IB20Factory public constant B20_FACTORY =
        IB20Factory(0xB20f000000000000000000000000000000000000);
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_URI_BYTES = 256;
    uint256 public constant MAX_MARKETS = 5;
    uint256 public constant MIN_AUTHOR_SHARE_BPS = 2000;
    uint256 public constant MAX_AUTHOR_SHARE_BPS = 10_000;
    bytes32 public constant TWEET_LAUNCH_TYPEHASH = keccak256(
        "TweetLaunch(address launcher,bytes32 salt,uint256 postId,uint256 authorXUserId,uint16 authorShareBps,uint256 deadline)"
    );

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

    struct PairParams {
        address quote;
        uint256 firstBuyAmount;
        uint256 firstBuyMinCoins;
        int24 expectedStartTick;
        uint24 maxTickDrift;
    }

    struct TweetParams {
        uint256 postId;
        uint256 authorXUserId;
        uint16 authorShareBps;
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

    struct MarketSetup {
        address coin;
        address module;
        uint256 openingFdvUsdE8;
        Mode mode;
        uint16 feeBps;
        uint16 creatorKeepBps;
        MemeFunConfig.LaunchTerms terms;
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

    event MarketLaunched(
        address indexed coin,
        address indexed quote,
        PoolId indexed poolId,
        uint256 allocation,
        uint256 deposited,
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
    error AmountTooLarge(uint256 amount);
    error StartTickDrift(int24 expected, int24 actual);
    error FirstBuySlippage(uint256 minCoins, uint256 coins);
    error CoinSetupFailed();
    error NotPoolManager();
    error EthTransferFailed();
    error InvalidMarketCount(uint256 count);
    error DuplicateQuote(address quote);
    error PrimaryPairMismatch();
    error TweetAttestorDisabled();
    error InvalidTweetAttestation();
    error InvalidTweetIdentity();
    error InvalidAuthorShare(uint256 shareBps);
    error TweetRequiresCreatorMode();

    constructor(
        IPoolManager poolManager_,
        IMemeFunHook hook_,
        MemeFunConfig config_
    )
        EIP712("MemeFunFactory", "1")
    {
        poolManager = poolManager_;
        hook = hook_;
        config = config_;
    }

    /// @notice The address `creator` will get for `salt`, so the app can show it before launch.
    function predictCoin(address creator, bytes32 salt) external view returns (address) {
        return B20_FACTORY.getB20Address(
            IB20Factory.B20Variant.ASSET, address(this), _scopedSalt(creator, salt)
        );
    }

    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address coin, PoolId poolId, uint256 coinsBought)
    {
        PairParams[] memory pairs = new PairParams[](1);
        pairs[0] = PairParams(
            p.quote, p.firstBuyAmount, p.firstBuyMinCoins, p.expectedStartTick, p.maxTickDrift
        );
        PoolId[] memory ids;
        uint256[] memory bought;
        (coin, ids, bought) = _launch(p, pairs, TweetParams(0, 0, 0));
        return (coin, ids[0], bought[0]);
    }

    /// @notice Creates one coin and atomically splits its fixed supply equally across 1-5 markets.
    /// @dev The base's primary-pair fields must exactly match pairs[0]. All markets share fee terms.
    function launchMulti(
        LaunchParams calldata base,
        PairParams[] calldata pairs
    )
        external
        payable
        nonReentrant
        returns (address coin, PoolId[] memory poolIds, uint256[] memory coinsBought)
    {
        _checkPairs(base, pairs);
        return _launch(base, pairs, TweetParams(0, 0, 0));
    }

    /// @notice Creates creator-mode markets with immutable, backend-attested tweet attribution.
    /// @dev Attribution is established before the atomic first buys. The author share is taken
    ///      from the existing creator allocation, preserving platform and referral shares.
    function launchTweetMulti(
        LaunchParams calldata base,
        PairParams[] calldata pairs,
        TweetParams calldata tweet,
        uint256 attestationDeadline,
        bytes calldata signature
    )
        external
        payable
        nonReentrant
        returns (address coin, PoolId[] memory poolIds, uint256[] memory coinsBought)
    {
        _checkPairs(base, pairs);
        if (base.mode != Mode.CREATOR) revert TweetRequiresCreatorMode();
        if (tweet.postId == 0 || tweet.authorXUserId == 0) revert InvalidTweetIdentity();
        if (
            tweet.authorShareBps < MIN_AUTHOR_SHARE_BPS
                || tweet.authorShareBps > MAX_AUTHOR_SHARE_BPS
        ) revert InvalidAuthorShare(tweet.authorShareBps);
        if (block.timestamp > attestationDeadline) revert Expired();
        address attestor = config.tweetAttestor();
        if (attestor == address(0)) revert TweetAttestorDisabled();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TWEET_LAUNCH_TYPEHASH,
                    msg.sender,
                    base.salt,
                    tweet.postId,
                    tweet.authorXUserId,
                    tweet.authorShareBps,
                    attestationDeadline
                )
            )
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != attestor) {
            revert InvalidTweetAttestation();
        }
        return _launch(base, pairs, tweet);
    }

    function _checkPairs(LaunchParams calldata base, PairParams[] calldata pairs) private pure {
        if (pairs.length == 0 || pairs.length > MAX_MARKETS) {
            revert InvalidMarketCount(pairs.length);
        }
        PairParams calldata primary = pairs[0];
        if (
            base.quote != primary.quote || base.firstBuyAmount != primary.firstBuyAmount
                || base.firstBuyMinCoins != primary.firstBuyMinCoins
                || base.expectedStartTick != primary.expectedStartTick
                || base.maxTickDrift != primary.maxTickDrift
        ) revert PrimaryPairMismatch();
    }

    function _launch(
        LaunchParams calldata p,
        PairParams[] memory pairs,
        TweetParams memory tweet
    )
        private
        returns (address coin, PoolId[] memory poolIds, uint256[] memory coinsBought)
    {
        MemeFunConfig.LaunchTerms memory terms = config.launchTerms();
        address module = _validate(p, terms);
        uint256 count = pairs.length;
        uint256 expectedValue = terms.creationFee;
        for (uint256 i; i < count; ++i) {
            address quote = pairs[i].quote;
            // SwapParams uses a signed amount: exact input must remain negative after casting.
            if (pairs[i].firstBuyAmount > uint256(type(int256).max)) {
                revert AmountTooLarge(pairs[i].firstBuyAmount);
            }
            if (!config.isLaunchableQuote(quote)) revert QuoteNotLaunchable(quote);
            for (uint256 j; j < i; ++j) {
                if (pairs[j].quote == quote) revert DuplicateQuote(quote);
            }
            if (quote == address(0)) expectedValue += pairs[i].firstBuyAmount;
        }
        if (msg.value != expectedValue) revert WrongValue(expectedValue, msg.value);
        unchecked {
            ++launchCount;
        }

        uint256 openingFdvUsdE8 = config.openingFdvUsdE8();
        coin = _createCoin(p, msg.sender);
        if (tweet.authorXUserId != 0) {
            hook.feeVault()
                .registerTweetAttribution(
                    coin, tweet.postId, tweet.authorXUserId, tweet.authorShareBps
                );
        }
        poolIds = new PoolId[](count);
        Callback[] memory callbacks = new Callback[](count);
        LaunchRecord[] memory records = new LaunchRecord[](count);
        uint256 keepBps = p.mode == Mode.CREATOR ? 0 : p.creatorKeepBps;
        MarketSetup memory setup =
            MarketSetup(coin, module, openingFdvUsdE8, p.mode, p.feeBps, uint16(keepBps), terms);
        uint256 slice = LaunchMath.SUPPLY / count;
        for (uint256 i; i < count; ++i) {
            uint256 allocation = i + 1 == count ? LaunchMath.SUPPLY - slice * i : slice;
            (callbacks[i], records[i]) = _prepareMarket(setup, pairs[i], allocation);
            poolIds[i] = records[i].poolId;
        }

        uint256[] memory quoteSpent;
        uint256[] memory deposited;
        (coinsBought, quoteSpent, deposited) = abi.decode(
            poolManager.unlock(abi.encode(callbacks)), (uint256[], uint256[], uint256[])
        );

        // Rounding dust from sizing the position: provably out of circulation, never kept.
        uint256 dust = IERC20(coin).balanceOf(address(this));
        if (dust != 0) IERC20(coin).safeTransfer(DEAD, dust);
        uint256 refund;
        for (uint256 i; i < count; ++i) {
            records[i].firstBuyQuote = quoteSpent[i];
            records[i].firstBuyCoins = coinsBought[i];
            uint256 allocation = i + 1 == count ? LaunchMath.SUPPLY - slice * i : slice;
            emit MarketLaunched(
                coin, pairs[i].quote, poolIds[i], allocation, deposited[i], records[i]
            );
            if (pairs[i].quote == address(0)) refund = pairs[i].firstBuyAmount - quoteSpent[i];
        }
        emit Launched(coin, msg.sender, pairs[0].quote, p.name, p.symbol, p.contractURI, records[0]);

        // ETH leaves last: the creation fee to the treasury, then anything a partial first buy left.
        if (terms.creationFee != 0) _sendEth(config.treasury(), terms.creationFee);
        if (refund != 0) _sendEth(msg.sender, refund);
    }

    function _prepareMarket(
        MarketSetup memory s,
        PairParams memory pair,
        uint256 allocation
    )
        private
        returns (Callback memory callback, LaunchRecord memory record)
    {
        uint256 quoteUsdE8 = config.quotePriceUsdE8(pair.quote);
        bool coinIsCurrency0 = uint160(s.coin) < uint160(pair.quote);
        int24 startTick = LaunchMath.startTick(
            quoteUsdE8, config.quote(pair.quote).decimals, coinIsCurrency0, s.openingFdvUsdE8
        );
        _checkDrift(pair.expectedStartTick, startTick, pair.maxTickDrift);
        uint128 liquidity = LaunchMath.liquidityForAmount(startTick, coinIsCurrency0, allocation);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(coinIsCurrency0 ? s.coin : pair.quote),
            currency1: Currency.wrap(coinIsCurrency0 ? pair.quote : s.coin),
            fee: 0,
            tickSpacing: LaunchMath.TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        PoolId id = key.toId();
        hook.registerPool(
            key,
            IMemeFunHook.PoolConfig({
                coin: s.coin,
                quoteIsCurrency0: !coinIsCurrency0,
                mode: s.mode,
                feeBps: s.feeBps,
                platformShareBps: s.terms.platformShareBps,
                referralShareBps: s.terms.referralShareBps,
                creatorKeepBps: s.creatorKeepBps,
                protectionStartBps: s.terms.protectionStartBps,
                module: s.module,
                launchedAt: 0,
                protectionDurationSec: s.terms.protectionDurationSec,
                seeded: false
            }),
            msg.sender
        );
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));
        callback = Callback(
            key,
            coinIsCurrency0,
            startTick,
            liquidity,
            msg.sender,
            pair.firstBuyAmount,
            pair.firstBuyMinCoins
        );
        record.poolId = id;
        record.mode = s.mode;
        record.module = s.module;
        record.feeBps = s.feeBps;
        record.platformShareBps = s.terms.platformShareBps;
        record.referralShareBps = s.terms.referralShareBps;
        record.creatorKeepBps = s.creatorKeepBps;
        record.protectionStartBps = s.terms.protectionStartBps;
        record.protectionDurationSec = s.terms.protectionDurationSec;
        record.startTick = startTick;
        record.liquidity = liquidity;
        record.quoteUsdE8 = quoteUsdE8;
        record.openingFdvUsdE8 = s.openingFdvUsdE8;
    }

    /// @dev Seeds every launch position, then runs optional first buys. Only reachable through
    ///      `launch` or `launchMulti`: the PoolManager calls back the contract that unlocked it.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Callback[] memory markets = abi.decode(data, (Callback[]));
        uint256[] memory bought = new uint256[](markets.length);
        uint256[] memory spent = new uint256[](markets.length);
        uint256[] memory deposited = new uint256[](markets.length);
        // Seed every market before any first buy can trade the coin.
        for (uint256 i; i < markets.length; ++i) {
            deposited[i] = _seed(markets[i]);
        }
        for (uint256 i; i < markets.length; ++i) {
            (bought[i], spent[i]) = _firstBuy(markets[i]);
        }
        return abi.encode(bought, spent, deposited);
    }

    function _seed(Callback memory c) private returns (uint256 coinOwed) {
        Currency coinCurrency = c.coinIsCurrency0 ? c.key.currency0 : c.key.currency1;

        // Each market's allocated supply, single-sided, from the opening price to the range end.
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
        coinOwed = uint256(-int256(c.coinIsCurrency0 ? added.amount0() : added.amount1()));
        poolManager.sync(coinCurrency);
        IERC20(Currency.unwrap(coinCurrency)).safeTransfer(address(poolManager), coinOwed);
        poolManager.settle();
    }

    function _firstBuy(Callback memory c) private returns (uint256 coins, uint256 quoteSpent) {
        if (c.firstBuyAmount == 0) return (0, 0);
        Currency coinCurrency = c.coinIsCurrency0 ? c.key.currency0 : c.key.currency1;
        Currency quoteCurrency = c.coinIsCurrency0 ? c.key.currency1 : c.key.currency0;

        // 2. The creator's first buy: exact input, quote for coin, at the base fee.
        bool zeroForOne = !c.coinIsCurrency0;
        BalanceDelta swapped = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(c.firstBuyAmount),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        quoteSpent = uint256(-int256(c.coinIsCurrency0 ? swapped.amount1() : swapped.amount0()));
        coins = uint256(int256(c.coinIsCurrency0 ? swapped.amount0() : swapped.amount1()));
        if (coins < c.firstBuyMinCoins) revert FirstBuySlippage(c.firstBuyMinCoins, coins);

        if (quoteCurrency.isAddressZero()) {
            poolManager.settle{value: quoteSpent}();
        } else {
            poolManager.sync(quoteCurrency);
            IERC20(Currency.unwrap(quoteCurrency))
                .safeTransferFrom(c.creator, address(poolManager), quoteSpent);
            poolManager.settle();
        }
        poolManager.take(coinCurrency, c.creator, coins);
    }

    // -------------------------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------------------------

    function _validate(
        LaunchParams calldata p,
        MemeFunConfig.LaunchTerms memory terms
    )
        private
        view
        returns (address module)
    {
        if (terms.launchesPaused) revert LaunchesPaused();
        if (block.timestamp > p.deadline) revert Expired();
        if (!config.isLaunchableQuote(p.quote)) revert QuoteNotLaunchable(p.quote);

        MemeFunConfig.ModeInfo memory info = config.modeInfo(p.mode);
        if (!info.enabled || (p.mode != Mode.CREATOR && info.module == address(0))) {
            revert ModeNotEnabled(p.mode);
        }
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
        if (
            IB20(coin).totalSupply() != LaunchMath.SUPPLY
                || IB20(coin).balanceOf(address(this)) != LaunchMath.SUPPLY
        ) revert CoinSetupFailed();
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
