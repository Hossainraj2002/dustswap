// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {MemeFunConfig} from "../MemeFunConfig.sol";
import {IFeeVault} from "../interfaces/IFeeVault.sol";
import {IMemeFunHook} from "../interfaces/IMemeFunHook.sol";
import {Mode} from "../types/MemeFunTypes.sol";

/// @title HolderRewardDistributor
/// @notice Destination module for holder-mode coins: their fees are paid out to holders, epoch
///         by epoch, separately in each market's quote asset.
///
/// @dev B20 tokens have no transfer hooks, so balances cannot be tracked on chain. Each epoch the
///      memefun indexer computes every holder's time-weighted balance from public Transfer events
///      and the rewards publisher posts ONE Merkle root covering holder-mode markets. Review
///      notes:
///
///      1. THE PUBLISHER CAN NEVER PAY OUT MORE THAN A MARKET EARNED. Publishing reserves each
///         market's total from its own accrued quote fees. Claims cannot exceed that budget or
///         spend another market's currency, whatever the root says.
///
///      2. A BAD ROOT CAN BE STOPPED. Claims open only after a 12-hour window in which the owner (a
///         Safe) can veto the epoch, which returns reserved amounts to their market pots. Anyone
///         can recompute a root from chain data and raise the alarm.
///
///      3. NOTHING IS STRANDED. Rewards unclaimed after 90 days (including any credited to
///         contracts that cannot claim) return to their market pots for later epochs.
///
///      4. EACH ROOT USES ONE LEAF FORMAT. Legacy publishEpoch/claim retain double-hashed
///         (epoch, coin, index, account, amount) leaves for primary markets. publishEpochFor/claimFor
///         use double-hashed (uint8(1), epoch, poolId, index, account, amount) leaves. The formats
///         cannot mix within an epoch. Budgets and claimed bitmaps are keyed by (epoch, poolId).
///
///      5. ANYONE MAY SUBMIT A CLAIM; FUNDS ALWAYS GO TO THE ACCOUNT IN THE LEAF.
contract HolderRewardDistributor is IUnlockCallback, ReentrancyGuardTransient {
    using BitMaps for BitMaps.BitMap;

    uint256 public constant VETO_WINDOW = 12 hours;
    uint256 public constant CLAIM_PERIOD = 90 days;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    IFeeVault public immutable feeVault;
    MemeFunConfig public immutable config;

    struct Epoch {
        bytes32 root;
        uint40 publishedAt;
        bool vetoed;
    }

    struct Claim {
        uint64 epoch;
        address coin;
        uint256 index;
        address account;
        uint256 amount;
        bytes32[] proof;
    }

    struct PoolClaim {
        uint64 epoch;
        PoolId poolId;
        uint256 index;
        address account;
        uint256 amount;
        bytes32[] proof;
    }

    struct Payout {
        Currency currency;
        address to;
        uint256 amount;
    }

    /// @notice Fees pulled for a market and not yet reserved by an epoch.
    mapping(PoolId pool => uint256) private _available;
    mapping(uint64 epoch => Epoch) public epochs;
    uint64 public lastEpoch;
    mapping(uint64 epoch => mapping(PoolId pool => uint256)) private _epochTotal;
    mapping(uint64 epoch => mapping(PoolId pool => uint256)) private _epochClaimed;
    /// @notice True once an epoch's leftover for a market has returned to that market's pot.
    mapping(uint64 epoch => mapping(PoolId pool => bool)) private _epochReleased;
    mapping(uint64 epoch => mapping(PoolId pool => BitMaps.BitMap)) internal _claimed;
    /// @notice False for legacy coin leaves, true for the separately domain-bound market leaves.
    mapping(uint64 epoch => bool) public epochPoolLeaves;

    event EpochPublished(uint64 indexed epoch, bytes32 root, address[] coins, uint256[] totals);
    event EpochVetoed(uint64 indexed epoch);
    event EpochReleased(uint64 indexed epoch, address indexed coin, uint256 returned);
    event Claimed(
        uint64 indexed epoch,
        address indexed coin,
        uint256 index,
        address indexed account,
        uint256 amount
    );
    event MarketEpochPublished(
        uint64 indexed epoch, bytes32 root, PoolId[] poolIds, uint256[] totals
    );
    event MarketEpochReleased(
        uint64 indexed epoch, address indexed coin, PoolId indexed poolId, uint256 returned
    );
    event MarketClaimed(
        uint64 indexed epoch,
        address indexed coin,
        PoolId indexed poolId,
        uint256 index,
        address account,
        uint256 amount
    );

    error NotPublisher();
    error NotOwner();
    error NotHolderCoin(address coin);
    error WrongEpoch(uint64 expected, uint64 given);
    error EmptyRoot();
    error LengthMismatch();
    error DuplicateCoin(address coin);
    error InsufficientRewards(address coin, uint256 total, uint256 available);
    error VetoWindowClosed();
    error ClaimsNotOpen();
    error ClaimPeriodOver();
    error EpochUnavailable();
    error AlreadyClaimed();
    error InvalidProof();
    error ExceedsEpochTotal();
    error NotReleasable();
    error NotPoolManager();
    error DuplicatePool(PoolId poolId);
    error WrongLeafFormat();

    constructor(
        IPoolManager poolManager_,
        IMemeFunHook hook_,
        IFeeVault feeVault_,
        MemeFunConfig config_
    ) {
        poolManager = poolManager_;
        hook = hook_;
        feeVault = feeVault_;
        config = config_;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Standard OpenZeppelin leaf, hashed twice so no internal node can pass as a leaf.
    function leaf(
        uint64 epoch,
        address coin,
        uint256 index,
        address account,
        uint256 amount
    )
        public
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, coin, index, account, amount))));
    }

    function isClaimed(uint64 epoch, address coin, uint256 index) external view returns (bool) {
        return _claimed[epoch][_primary(coin)].get(index);
    }

    /// @notice Pool leaf domain 1, distinct from the unchanged legacy coin leaf.
    function leafFor(
        uint64 epoch,
        PoolId poolId,
        uint256 index,
        address account,
        uint256 amount
    )
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            bytes.concat(keccak256(abi.encode(uint8(1), epoch, poolId, index, account, amount)))
        );
    }

    function available(address coin) external view returns (uint256) {
        return _available[_primary(coin)];
    }

    function epochTotal(uint64 epoch, address coin) external view returns (uint256) {
        return _epochTotal[epoch][_primary(coin)];
    }

    function epochClaimed(uint64 epoch, address coin) external view returns (uint256) {
        return _epochClaimed[epoch][_primary(coin)];
    }

    function epochReleased(uint64 epoch, address coin) external view returns (bool) {
        return _epochReleased[epoch][_primary(coin)];
    }

    function availableFor(address coin, address quote) external view returns (uint256) {
        return _available[hook.poolIdFor(coin, quote)];
    }

    function epochTotalFor(uint64 epoch, PoolId poolId) external view returns (uint256) {
        return _epochTotal[epoch][poolId];
    }

    function epochClaimedFor(uint64 epoch, PoolId poolId) external view returns (uint256) {
        return _epochClaimed[epoch][poolId];
    }

    function epochReleasedFor(uint64 epoch, PoolId poolId) external view returns (bool) {
        return _epochReleased[epoch][poolId];
    }

    function isClaimedFor(uint64 epoch, PoolId poolId, uint256 index) external view returns (bool) {
        return _claimed[epoch][poolId].get(index);
    }

    function _primary(address coin) private view returns (PoolId) {
        return hook.creatorOf(coin) == address(0) ? PoolId.wrap(bytes32(0)) : hook.poolIdOf(coin);
    }

    // -------------------------------------------------------------------------------------------
    // Publishing
    // -------------------------------------------------------------------------------------------

    /// @notice Publishes epoch `epoch` (always the next one) for every coin it covers.
    function publishEpoch(
        uint64 epoch,
        bytes32 root,
        address[] calldata coins,
        uint256[] calldata totals
    )
        external
        nonReentrant
    {
        _validateEpoch(epoch, root, coins.length, totals.length);
        for (uint256 i; i < coins.length; ++i) {
            _reserve(epoch, hook.poolIdOf(coins[i]), totals[i], false);
        }
        epochs[epoch] = Epoch({root: root, publishedAt: uint40(block.timestamp), vetoed: false});
        lastEpoch = epoch;
        emit EpochPublished(epoch, root, coins, totals);
    }

    /// @notice Publishes one market-leaf root, with independent earned-fee budgets per market.
    function publishEpochFor(
        uint64 epoch,
        bytes32 root,
        PoolId[] calldata poolIds,
        uint256[] calldata totals
    )
        external
        nonReentrant
    {
        _validateEpoch(epoch, root, poolIds.length, totals.length);
        for (uint256 i; i < poolIds.length; ++i) {
            _reserve(epoch, poolIds[i], totals[i], true);
        }
        epochs[epoch] = Epoch({root: root, publishedAt: uint40(block.timestamp), vetoed: false});
        epochPoolLeaves[epoch] = true;
        lastEpoch = epoch;
        emit MarketEpochPublished(epoch, root, poolIds, totals);
    }

    function _validateEpoch(
        uint64 epoch,
        bytes32 root,
        uint256 count,
        uint256 totalCount
    )
        private
        view
    {
        if (msg.sender != config.rewardsPublisher()) revert NotPublisher();
        if (epoch != lastEpoch + 1) revert WrongEpoch(lastEpoch + 1, epoch);
        if (root == bytes32(0)) revert EmptyRoot();
        if (count != totalCount) revert LengthMismatch();
    }

    function _reserve(uint64 epoch, PoolId id, uint256 total, bool poolLeaves) private {
        IMemeFunHook.PoolConfig memory c = hook.configOfPool(id);
        if (c.mode != Mode.HOLDERS || c.module != address(this)) revert NotHolderCoin(c.coin);
        if (_epochTotal[epoch][id] != 0) {
            if (poolLeaves) revert DuplicatePool(id);
            revert DuplicateCoin(c.coin);
        }
        address quote = Currency.unwrap(hook.quoteCurrencyOfPool(id));
        uint256 pot = _available[id] + feeVault.pullDestinationFor(c.coin, quote);
        if (total == 0 || total > pot) revert InsufficientRewards(c.coin, total, pot);
        _available[id] = pot - total;
        _epochTotal[epoch][id] = total;
    }

    /// @notice Owner (Safe) stops an epoch before claims open. Return its funds with
    ///         `releaseEpoch`, which anyone may call.
    function vetoEpoch(uint64 epoch) external {
        if (msg.sender != config.owner()) revert NotOwner();
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0) || e.vetoed) revert EpochUnavailable();
        if (block.timestamp >= uint256(e.publishedAt) + VETO_WINDOW) revert VetoWindowClosed();
        e.vetoed = true;
        emit EpochVetoed(epoch);
    }

    /// @notice Returns an epoch's unclaimed rewards to each coin's pot, once the epoch was vetoed
    ///         or its 90-day claim period is over. Idempotent per coin.
    function releaseEpoch(uint64 epoch, address[] calldata coins) external {
        _validateRelease(epoch);
        for (uint256 i; i < coins.length; ++i) {
            _release(epoch, hook.poolIdOf(coins[i]));
        }
    }

    function releaseEpochFor(uint64 epoch, PoolId[] calldata poolIds) external {
        _validateRelease(epoch);
        for (uint256 i; i < poolIds.length; ++i) {
            _release(epoch, poolIds[i]);
        }
    }

    function _validateRelease(uint64 epoch) private view {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert EpochUnavailable();
        if (!e.vetoed && block.timestamp <= uint256(e.publishedAt) + CLAIM_PERIOD) {
            revert NotReleasable();
        }
    }

    function _release(uint64 epoch, PoolId id) private {
        address coin = hook.configOfPool(id).coin;
        if (_epochTotal[epoch][id] == 0 || _epochReleased[epoch][id]) return;
        _epochReleased[epoch][id] = true;
        uint256 returned = _epochTotal[epoch][id] - _epochClaimed[epoch][id];
        _available[id] += returned;
        if (epochPoolLeaves[epoch]) emit MarketEpochReleased(epoch, coin, id, returned);
        else emit EpochReleased(epoch, coin, returned);
    }

    // -------------------------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------------------------

    function claim(Claim calldata c) external nonReentrant {
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = _record(c);
        poolManager.unlock(abi.encode(payouts));
    }

    /// @notice Claims many (epoch, coin) leaves in one transaction, paying each in its pair asset.
    function claimMany(Claim[] calldata claims) external nonReentrant {
        Payout[] memory payouts = new Payout[](claims.length);
        for (uint256 i; i < claims.length; ++i) {
            payouts[i] = _record(claims[i]);
        }
        poolManager.unlock(abi.encode(payouts));
    }

    function _record(Claim calldata c) private returns (Payout memory) {
        if (epochPoolLeaves[c.epoch]) revert WrongLeafFormat();
        return _recordPool(
            c.epoch,
            hook.poolIdOf(c.coin),
            c.index,
            c.account,
            c.amount,
            c.proof,
            leaf(c.epoch, c.coin, c.index, c.account, c.amount)
        );
    }

    function claimFor(PoolClaim calldata c) external nonReentrant {
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = _recordFor(c);
        poolManager.unlock(abi.encode(payouts));
    }

    function claimManyFor(PoolClaim[] calldata claims) external nonReentrant {
        Payout[] memory payouts = new Payout[](claims.length);
        for (uint256 i; i < claims.length; ++i) {
            payouts[i] = _recordFor(claims[i]);
        }
        poolManager.unlock(abi.encode(payouts));
    }

    function _recordFor(PoolClaim calldata c) private returns (Payout memory) {
        if (!epochPoolLeaves[c.epoch]) revert WrongLeafFormat();
        return _recordPool(
            c.epoch,
            c.poolId,
            c.index,
            c.account,
            c.amount,
            c.proof,
            leafFor(c.epoch, c.poolId, c.index, c.account, c.amount)
        );
    }

    function _recordPool(
        uint64 epoch,
        PoolId id,
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata proof,
        bytes32 hash
    )
        private
        returns (Payout memory)
    {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0) || e.vetoed || _epochReleased[epoch][id]) {
            revert EpochUnavailable();
        }
        if (block.timestamp < uint256(e.publishedAt) + VETO_WINDOW) revert ClaimsNotOpen();
        if (block.timestamp > uint256(e.publishedAt) + CLAIM_PERIOD) revert ClaimPeriodOver();
        BitMaps.BitMap storage bitmap = _claimed[epoch][id];
        if (bitmap.get(index)) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, e.root, hash)) revert InvalidProof();

        bitmap.set(index);
        uint256 claimed = _epochClaimed[epoch][id] + amount;
        if (claimed > _epochTotal[epoch][id]) revert ExceedsEpochTotal();
        _epochClaimed[epoch][id] = claimed;
        address coin = hook.configOfPool(id).coin;
        if (epochPoolLeaves[epoch]) emit MarketClaimed(epoch, coin, id, index, account, amount);
        else emit Claimed(epoch, coin, index, account, amount);
        return Payout(hook.quoteCurrencyOfPool(id), account, amount);
    }

    /// @dev Only reachable through this contract's own unlock.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Payout[] memory payouts = abi.decode(data, (Payout[]));
        for (uint256 i; i < payouts.length; ++i) {
            Payout memory p = payouts[i];
            if (p.amount == 0) continue;
            poolManager.burn(address(this), p.currency.toId(), p.amount);
            poolManager.take(p.currency, p.to, p.amount);
        }
        return "";
    }
}
