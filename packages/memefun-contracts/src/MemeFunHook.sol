// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {IMemeFunHook} from "./interfaces/IMemeFunHook.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {HookDataLib} from "./libraries/HookDataLib.sol";
import {LaunchMath} from "./libraries/LaunchMath.sol";
import {Mode} from "./types/MemeFunTypes.sol";

/// @title MemeFunHook
/// @notice The Uniswap v4 hook on every memefun pool: the registry of each coin's frozen terms,
///         the lock on its liquidity, and the fee engine.
///
/// @dev Review notes:
///
///      1. ONLY THE FACTORY CREATES POOLS. `beforeInitialize` rejects every other caller and every
///         pool the factory has not registered, so no third party can attach this hook to a pool
///         of their own and borrow memefun's name or events.
///
///      2. LIQUIDITY IS LOCKED BY CONSTRUCTION. The factory may add liquidity exactly once (the
///         launch position holding that market's allocation). A floor-mode coin's FloorVault may add
///         liquidity on the quote side of the price only. Every other add reverts, and every
///         removal and donation reverts for everyone, the factory and the owner included.
///
///      3. THE FEE IS ALWAYS TAKEN IN THE PAIR ASSET (ETH, USDC or the stock), never in the coin,
///         for all four swap types, using the deltas v4 gives hooks:
///            buy,  exact in : beforeSwap keeps F of the quote input   F = ceil(X * r)
///            sell, exact out: beforeSwap adds F to the quote output   F = ceil(N * r / (1 - r))
///            sell, exact in : afterSwap keeps F of the quote output   F = ceil(Y * r)
///            buy,  exact out: afterSwap adds F to the quote input     F = ceil(Y * r / (1 - r))
///         so the fee is always rate r of the trade's gross quote amount, rounded up. F is minted
///         to FeeVault as ERC-6909 claims in the same call, so the hook ends every swap holding
///         nothing and owing nothing.
///
///      4. TERMS ARE SNAPSHOTTED AT LAUNCH. Every number that prices a trade is copied into the
///         pool's config by `registerPool` and never re-read from MemeFunConfig. Only `feeBps` can
///         change afterwards, only by the creator, and only downward.
///
///      5. EXEMPTIONS ARE NARROW AND ON-CHAIN. The factory's atomic first buy pays the coin's base
///         fee without launch protection. A burn-mode coin's own BuybackBurnVault pays no fee. Both
///         are immutable contracts with no other trading path.
///
///      6. REFERRALS ARE HONORED ONLY THROUGH MemeFunRouter, whose hookData names the trader and
///         referrer. Anyone can put anything in hookData through another router, so for every
///         other sender hookData is ignored and the referral share stays with the platform.
contract MemeFunHook is BaseHook, IMemeFunHook {
    using SafeCast for uint256;
    using SafeCast for int256;
    using StateLibrary for IPoolManager;

    int24 internal constant TICK_SPACING = LaunchMath.TICK_SPACING;

    address public immutable factory;
    IFeeVault public immutable feeVault;
    address public immutable router;

    /// @dev Price at the first swap of the current block, per pool. Modules compare the live price
    ///      with it so a price pumped earlier in the same block cannot steer a buyback or a floor.
    struct BlockStart {
        uint64 blockNumber;
        uint160 sqrtPriceX96;
    }

    mapping(PoolId id => PoolConfig) internal _pools;
    mapping(address coin => PoolKey) internal _keys;
    mapping(PoolId id => PoolKey) internal _poolKeys;
    mapping(address coin => mapping(address quote => PoolId)) internal _pairIds;
    mapping(address coin => PoolId[]) internal _coinPools;
    mapping(address coin => address) public creatorOf;
    mapping(address coin => address) public pendingCreatorOf;
    mapping(PoolId id => BlockStart) internal _blockStart;

    // Transient slots carrying one swap's fee context from beforeSwap to afterSwap. Transient
    // storage is cleared after every transaction and never overlaps persistent storage; afterSwap
    // also zeroes these so a second swap in the same transaction starts clean.
    bytes32 private constant T_FEE_BPS = keccak256("memefun.hook.transient.feeBps");
    bytes32 private constant T_FEE = keccak256("memefun.hook.transient.fee");
    bytes32 private constant T_TRADER = keccak256("memefun.hook.transient.trader");
    bytes32 private constant T_REFERRER = keccak256("memefun.hook.transient.referrer");

    event PoolRegistered(
        PoolId indexed id, address indexed coin, address indexed creator, PoolConfig config
    );
    /// @notice One per swap on a memefun pool, from the trader's point of view.
    /// @param quoteAmount Gross quote amount: paid on a buy (fee included), or released by the pool on
    ///        a sell (the seller receives quoteAmount - fee).
    /// @param trader The MemeFunRouter user, or the PoolManager caller (e.g. a router contract).
    /// @param sqrtPriceX96 The pool price after the swap, so an indexer needs no other event source.
    /// @param tick The pool tick after the swap.
    event Trade(
        PoolId indexed id,
        address indexed coin,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmount,
        uint256 coinAmount,
        uint256 fee,
        uint256 feeBps,
        address referrer,
        uint160 sqrtPriceX96,
        int24 tick
    );
    event FeeLowered(address indexed coin, uint256 oldFeeBps, uint256 newFeeBps);
    event CreatorProposed(address indexed coin, address indexed current, address indexed proposed);
    event CreatorTransferred(address indexed coin, address indexed previous, address indexed next);

    error NotFactory();
    error NotCreator();
    error NotPendingCreator();
    error UnknownCoin(address coin);
    error AlreadyRegistered(address coin);
    error UnknownPool(PoolId id);
    error UnknownPair(address coin, address quote);
    error TooManyMarkets();
    error TermsMismatch();
    error PoolNotRegistered();
    error InvalidPoolKey();
    error AlreadySeeded();
    error LiquidityLocked();
    error FloorNotQuoteSided();
    error DonationsDisabled();
    error FeeNotLower(uint256 currentBps, uint256 requestedBps);

    constructor(
        IPoolManager poolManager_,
        address factory_,
        IFeeVault feeVault_,
        address router_
    )
        BaseHook(poolManager_)
    {
        factory = factory_;
        feeVault = feeVault_;
        router = router_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // -------------------------------------------------------------------------------------------
    // Registry (factory)
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMemeFunHook
    function registerPool(
        PoolKey calldata key,
        PoolConfig calldata config,
        address creator
    )
        external
    {
        if (msg.sender != factory) revert NotFactory();
        address coin = config.coin;
        if (
            address(key.hooks) != address(this) || key.fee != 0 || key.tickSpacing != TICK_SPACING
                || Currency.unwrap(config.quoteIsCurrency0 ? key.currency1 : key.currency0) != coin
        ) revert InvalidPoolKey();

        PoolId id = key.toId();
        if (_pools[id].coin != address(0)) revert AlreadyRegistered(coin);
        bool first = address(_keys[coin].hooks) == address(0);
        if (!first) {
            if (_coinPools[coin].length >= 5) revert TooManyMarkets();
            PoolConfig storage primary = _pools[_keys[coin].toId()];
            if (
                creatorOf[coin] != creator || primary.mode != config.mode
                    || primary.feeBps != config.feeBps
                    || primary.platformShareBps != config.platformShareBps
                    || primary.referralShareBps != config.referralShareBps
                    || primary.creatorKeepBps != config.creatorKeepBps
                    || primary.protectionStartBps != config.protectionStartBps
                    || primary.protectionDurationSec != config.protectionDurationSec
                    || primary.module != config.module || primary.launchedAt != block.timestamp
            ) revert TermsMismatch();
        }
        PoolConfig storage stored = _pools[id];
        stored.coin = coin;
        stored.quoteIsCurrency0 = config.quoteIsCurrency0;
        stored.mode = config.mode;
        stored.feeBps = config.feeBps;
        stored.platformShareBps = config.platformShareBps;
        stored.referralShareBps = config.referralShareBps;
        stored.creatorKeepBps = config.creatorKeepBps;
        stored.protectionStartBps = config.protectionStartBps;
        stored.module = config.module;
        stored.launchedAt = uint40(block.timestamp);
        stored.protectionDurationSec = config.protectionDurationSec;
        stored.seeded = false;

        if (first) {
            _keys[coin] = key;
            creatorOf[coin] = creator;
        }
        _poolKeys[id] = key;
        address quote = Currency.unwrap(config.quoteIsCurrency0 ? key.currency0 : key.currency1);
        _pairIds[coin][quote] = id;
        _coinPools[coin].push(id);
        emit PoolRegistered(id, coin, creator, stored);
    }

    // -------------------------------------------------------------------------------------------
    // Creator
    // -------------------------------------------------------------------------------------------

    /// @notice Lowers the coin's fee for every future trade. It can never be raised again.
    function lowerFee(address coin, uint256 newFeeBps) external {
        if (msg.sender != creatorOf[coin]) revert NotCreator();
        PoolConfig storage config = _pools[_keyOf(coin).toId()];
        uint256 current = config.feeBps;
        if (newFeeBps >= current) revert FeeNotLower(current, newFeeBps);
        PoolId[] storage ids = _coinPools[coin];
        for (uint256 i; i < ids.length; ++i) {
            _pools[ids[i]].feeBps = uint16(newFeeBps);
        }
        emit FeeLowered(coin, current, newFeeBps);
    }

    /// @notice First step of handing the creator role (fee earnings and `lowerFee`) to `proposed`.
    ///         `address(0)` cancels a pending proposal.
    function proposeCreator(address coin, address proposed) external {
        address current = creatorOf[coin];
        if (msg.sender != current) revert NotCreator();
        pendingCreatorOf[coin] = proposed;
        emit CreatorProposed(coin, current, proposed);
    }

    function acceptCreator(address coin) external {
        if (msg.sender != pendingCreatorOf[coin] || msg.sender == address(0)) {
            revert NotPendingCreator();
        }
        address previous = creatorOf[coin];
        creatorOf[coin] = msg.sender;
        delete pendingCreatorOf[coin];
        emit CreatorTransferred(coin, previous, msg.sender);
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMemeFunHook
    function poolKeyOf(address coin) external view returns (PoolKey memory) {
        return _keyOf(coin);
    }

    function poolKeyFor(address coin, address quote) external view returns (PoolKey memory) {
        return _poolKeys[_pairId(coin, quote)];
    }

    function poolKeyOfPool(PoolId id) external view returns (PoolKey memory) {
        _knownPool(id);
        return _poolKeys[id];
    }

    function poolIdsOf(address coin) external view returns (PoolId[] memory) {
        _keyOf(coin);
        return _coinPools[coin];
    }

    function poolKeysOf(address coin) external view returns (PoolKey[] memory keys) {
        _keyOf(coin);
        PoolId[] storage ids = _coinPools[coin];
        keys = new PoolKey[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            keys[i] = _poolKeys[ids[i]];
        }
    }

    /// @inheritdoc IMemeFunHook
    function poolIdOf(address coin) external view returns (PoolId) {
        return _keyOf(coin).toId();
    }

    function poolIdFor(address coin, address quote) external view returns (PoolId) {
        return _pairId(coin, quote);
    }

    /// @inheritdoc IMemeFunHook
    function configOf(address coin) external view returns (PoolConfig memory) {
        return _pools[_keyOf(coin).toId()];
    }

    function configOfPool(PoolId id) external view returns (PoolConfig memory) {
        _knownPool(id);
        return _pools[id];
    }

    function configFor(address coin, address quote) external view returns (PoolConfig memory) {
        return _pools[_pairId(coin, quote)];
    }

    /// @inheritdoc IMemeFunHook
    function quoteCurrencyOf(address coin) external view returns (Currency) {
        PoolKey storage key = _keyOf(coin);
        return _pools[key.toId()].quoteIsCurrency0 ? key.currency0 : key.currency1;
    }

    function quoteCurrencyOfPool(PoolId id) external view returns (Currency) {
        _knownPool(id);
        PoolKey storage key = _poolKeys[id];
        return _pools[id].quoteIsCurrency0 ? key.currency0 : key.currency1;
    }

    /// @inheritdoc IMemeFunHook
    function moduleOf(address coin) external view returns (address) {
        PoolKey storage key = _keys[coin];
        if (address(key.hooks) == address(0)) return address(0);
        return _pools[key.toId()].module;
    }

    function moduleOfPool(PoolId id) external view returns (address) {
        _knownPool(id);
        return _pools[id].module;
    }

    /// @notice Fee rate a trade would pay right now, launch protection included.
    function currentFeeBps(address coin) external view returns (uint256) {
        PoolConfig storage config = _pools[_keyOf(coin).toId()];
        return _rate(config);
    }

    /// @inheritdoc IMemeFunHook
    function blockStartSqrtPriceX96(PoolId id) external view returns (uint160) {
        BlockStart memory start = _blockStart[id];
        if (start.blockNumber == block.number) return start.sqrtPriceX96;
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        return sqrtPriceX96;
    }

    // -------------------------------------------------------------------------------------------
    // Pool lifecycle
    // -------------------------------------------------------------------------------------------

    function _beforeInitialize(
        address sender,
        PoolKey calldata key,
        uint160
    )
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != factory) revert NotFactory();
        if (_pools[key.toId()].coin == address(0)) revert PoolNotRegistered();
        return this.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata
    )
        internal
        override
        returns (bytes4)
    {
        PoolId id = key.toId();
        PoolConfig storage config = _pools[id];
        if (sender == factory) {
            if (config.seeded) revert AlreadySeeded();
            config.seeded = true;
            return this.beforeAddLiquidity.selector;
        }
        if (config.mode == Mode.FLOOR && sender == config.module && config.module != address(0)) {
            // Quote-only ranges: above the price when the quote is currency0, at or below it when
            // the quote is currency1. Such a position can only ever buy the coin as it falls.
            (, int24 tick,,) = poolManager.getSlot0(id);
            bool quoteOnly =
                config.quoteIsCurrency0 ? params.tickLower > tick : params.tickUpper <= tick;
            if (!quoteOnly) revert FloorNotQuoteSided();
            return this.beforeAddLiquidity.selector;
        }
        revert LiquidityLocked();
    }

    function _beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    )
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityLocked();
    }

    function _beforeDonate(
        address,
        PoolKey calldata,
        uint256,
        uint256,
        bytes calldata
    )
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonationsDisabled();
    }

    // -------------------------------------------------------------------------------------------
    // Swaps
    // -------------------------------------------------------------------------------------------

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolConfig storage config = _pools[id];
        _recordBlockStart(id);

        uint256 feeBps = _feeBpsFor(sender, config);
        (address trader, address referrer) = _parties(sender, hookData);
        _tstore(T_FEE_BPS, feeBps);
        _tstore(T_TRADER, uint256(uint160(trader)));
        _tstore(T_REFERRER, uint256(uint160(referrer)));

        bool exactIn = params.amountSpecified < 0;
        if (feeBps == 0 || !_specifiedIsQuote(exactIn, params.zeroForOne, config.quoteIsCurrency0))
        {
            _tstore(T_FEE, 0);
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Quote is the specified currency: an exact-input buy (gross input known) or an
        // exact-output sell (net output known).
        uint256 amount =
            exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = exactIn ? FeeMath.onGross(amount, feeBps) : FeeMath.onNet(amount, feeBps);
        _tstore(T_FEE, fee);
        if (fee == 0) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        _collect(config, _quoteOf(key, config), fee, referrer);
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt256().toInt128(), 0), 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    )
        internal
        override
        returns (bytes4, int128)
    {
        PoolConfig storage config = _pools[key.toId()];
        uint256 feeBps = _tload(T_FEE_BPS);
        uint256 fee = _tload(T_FEE);
        address trader = address(uint160(_tload(T_TRADER)));
        address referrer = address(uint160(_tload(T_REFERRER)));

        bool exactIn = params.amountSpecified < 0;
        bool isBuy = params.zeroForOne == config.quoteIsCurrency0;
        int128 quoteDelta = config.quoteIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 coinDelta = config.quoteIsCurrency0 ? delta.amount1() : delta.amount0();
        uint256 quoteAmount = _abs(quoteDelta);

        int128 hookDelta = 0;
        if (feeBps != 0 && !_specifiedIsQuote(exactIn, params.zeroForOne, config.quoteIsCurrency0))
        {
            // Quote is the unspecified currency: an exact-input sell (pool output is the gross) or
            // an exact-output buy (pool input is the net).
            fee =
                exactIn ? FeeMath.onGross(quoteAmount, feeBps) : FeeMath.onNet(quoteAmount, feeBps);
            if (fee != 0) {
                _collect(config, _quoteOf(key, config), fee, referrer);
                hookDelta = fee.toInt256().toInt128();
            }
        }

        // From the trader's side: a buyer pays the pool's input plus the fee, a seller gets the
        // pool's output minus the fee.
        _emitTrade(
            key.toId(),
            config.coin,
            trader,
            isBuy,
            isBuy ? quoteAmount + fee : quoteAmount,
            _abs(coinDelta),
            fee,
            feeBps,
            fee == 0 ? address(0) : referrer
        );

        _tstore(T_FEE_BPS, 0);
        _tstore(T_FEE, 0);
        _tstore(T_TRADER, 0);
        _tstore(T_REFERRER, 0);
        return (this.afterSwap.selector, hookDelta);
    }

    // -------------------------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------------------------

    /// @dev Fee rate for this sender: none for a burn coin's own buyback vault, the base fee for
    ///      the factory's first buy, otherwise the base fee plus any remaining launch protection.
    function _feeBpsFor(address sender, PoolConfig storage config) private view returns (uint256) {
        if (sender == config.module && config.mode == Mode.BURN && sender != address(0)) return 0;
        if (sender == factory) return config.feeBps;
        return _rate(config);
    }

    function _rate(PoolConfig storage config) private view returns (uint256) {
        return FeeMath.launchFeeBps(
            config.feeBps,
            config.protectionStartBps,
            config.protectionDurationSec,
            block.timestamp - config.launchedAt
        );
    }

    /// @dev Trader and referrer from MemeFunRouter's hookData; any other sender is the trader
    ///      itself, with no referrer. Self-referral is dropped.
    function _parties(
        address sender,
        bytes calldata hookData
    )
        private
        view
        returns (address trader, address referrer)
    {
        if (sender != router) return (sender, address(0));
        (bool ok, address decodedTrader, address decodedReferrer) = HookDataLib.decode(hookData);
        if (!ok) return (sender, address(0));
        trader = decodedTrader;
        if (decodedReferrer != decodedTrader) referrer = decodedReferrer;
    }

    /// @dev Mints the fee to FeeVault as claims (the hook's delta for it is settled by the fee
    ///      delta this hook returns) and records who it is owed to.
    function _collect(
        PoolConfig storage config,
        Currency quote,
        uint256 fee,
        address referrer
    )
        private
    {
        poolManager.mint(address(feeVault), quote.toId(), fee);
        FeeMath.Split memory s = FeeMath.split(
            fee,
            config.mode == Mode.CREATOR,
            config.platformShareBps,
            config.referralShareBps,
            config.creatorKeepBps,
            referrer != address(0)
        );
        feeVault.credit(
            config.coin, quote, s.platform, referrer, s.referral, s.creator, s.destination
        );
    }

    /// @dev The pool has already moved when afterSwap runs, and the hook's fee delta never moves
    ///      it, so slot0 here is the price the trade left behind.
    function _emitTrade(
        PoolId id,
        address coin,
        address trader,
        bool isBuy,
        uint256 quoteAmount,
        uint256 coinAmount,
        uint256 fee,
        uint256 feeBps,
        address referrer
    )
        private
    {
        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(id);
        emit Trade(
            id,
            coin,
            trader,
            isBuy,
            quoteAmount,
            coinAmount,
            fee,
            feeBps,
            referrer,
            sqrtPriceX96,
            tick
        );
    }

    function _recordBlockStart(PoolId id) private {
        if (_blockStart[id].blockNumber == block.number) return;
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        _blockStart[id] = BlockStart(uint64(block.number), sqrtPriceX96);
    }

    /// @dev The specified currency is currency0 exactly when (exactIn == zeroForOne).
    function _specifiedIsQuote(
        bool exactIn,
        bool zeroForOne,
        bool quoteIsCurrency0
    )
        private
        pure
        returns (bool)
    {
        return (exactIn == zeroForOne) == quoteIsCurrency0;
    }

    function _quoteOf(
        PoolKey calldata key,
        PoolConfig storage config
    )
        private
        view
        returns (Currency)
    {
        return config.quoteIsCurrency0 ? key.currency0 : key.currency1;
    }

    function _keyOf(address coin) private view returns (PoolKey storage key) {
        key = _keys[coin];
        if (address(key.hooks) == address(0)) revert UnknownCoin(coin);
    }

    function _pairId(address coin, address quote) private view returns (PoolId id) {
        id = _pairIds[coin][quote];
        if (_pools[id].coin != coin || address(_poolKeys[id].hooks) == address(0)) {
            revert UnknownPair(coin, quote);
        }
    }

    function _knownPool(PoolId id) private view {
        if (_pools[id].coin == address(0)) revert UnknownPool(id);
    }

    function _abs(int128 value) private pure returns (uint256) {
        return value < 0 ? uint256(-int256(value)) : uint256(int256(value));
    }

    function _tstore(bytes32 slot, uint256 value) private {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
