// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {MemeFunConfig} from "../MemeFunConfig.sol";
import {IFeeVault} from "../interfaces/IFeeVault.sol";
import {IMemeFunHook} from "../interfaces/IMemeFunHook.sol";
import {Mode} from "../types/MemeFunTypes.sol";

/// @title HolderRewardDistributor
/// @notice Destination module for holder-mode coins: their fees are paid out to holders, epoch
///         by epoch, in the coin's pair asset.
///
/// @dev B20 tokens have no transfer hooks, so balances cannot be tracked on chain. Each epoch the
///      memefun indexer computes every holder's time-weighted balance from public Transfer events
///      and the rewards publisher posts ONE Merkle root covering every holder-mode coin. Review
///      notes:
///
///      1. THE PUBLISHER CAN NEVER PAY OUT MORE THAN A COIN EARNED. Publishing reserves each coin's
///         total from fees that coin actually accrued, and claims against a coin can never exceed
///         its reserved total, whatever the root says.
///
///      2. A BAD ROOT CAN BE STOPPED. Claims open only after a 12-hour window in which the owner (a
///         Safe) can veto the epoch, which returns every reserved amount to its coin's pot. Anyone
///         can recompute a root from chain data and raise the alarm.
///
///      3. NOTHING IS STRANDED. Rewards unclaimed after 90 days (including any credited to
///         contracts that cannot claim) return to the coin's pot for later epochs.
///
///      4. LEAVES ARE DOUBLE-HASHED (OpenZeppelin standard) over (epoch, coin, index, account,
///         amount), so a proof can never be replayed in another epoch or for another coin, and the
///         claimed bitmap is keyed by index per (epoch, coin), as in DustSwapRewardDistributor.
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

    struct Payout {
        Currency currency;
        address to;
        uint256 amount;
    }

    /// @notice Fees pulled for a coin and not yet reserved by an epoch.
    mapping(address coin => uint256) public available;
    mapping(uint64 epoch => Epoch) public epochs;
    uint64 public lastEpoch;
    mapping(uint64 epoch => mapping(address coin => uint256)) public epochTotal;
    mapping(uint64 epoch => mapping(address coin => uint256)) public epochClaimed;
    /// @notice True once an epoch's leftover for a coin has gone back to the coin's pot.
    mapping(uint64 epoch => mapping(address coin => bool)) public epochReleased;
    mapping(uint64 epoch => mapping(address coin => BitMaps.BitMap)) internal _claimed;

    event EpochPublished(uint64 indexed epoch, bytes32 root, address[] coins, uint256[] totals);
    event EpochVetoed(uint64 indexed epoch);
    event EpochReleased(uint64 indexed epoch, address indexed coin, uint256 returned);
    event Claimed(uint64 indexed epoch, address indexed coin, uint256 index, address indexed account, uint256 amount);

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

    constructor(IPoolManager poolManager_, IMemeFunHook hook_, IFeeVault feeVault_, MemeFunConfig config_) {
        poolManager = poolManager_;
        hook = hook_;
        feeVault = feeVault_;
        config = config_;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Standard OpenZeppelin leaf, hashed twice so no internal node can pass as a leaf.
    function leaf(uint64 epoch, address coin, uint256 index, address account, uint256 amount)
        public
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, coin, index, account, amount))));
    }

    function isClaimed(uint64 epoch, address coin, uint256 index) external view returns (bool) {
        return _claimed[epoch][coin].get(index);
    }

    // -------------------------------------------------------------------------------------------
    // Publishing
    // -------------------------------------------------------------------------------------------

    /// @notice Publishes epoch `epoch` (always the next one) for every coin it covers.
    function publishEpoch(uint64 epoch, bytes32 root, address[] calldata coins, uint256[] calldata totals)
        external
        nonReentrant
    {
        if (msg.sender != config.rewardsPublisher()) revert NotPublisher();
        if (epoch != lastEpoch + 1) revert WrongEpoch(lastEpoch + 1, epoch);
        if (root == bytes32(0)) revert EmptyRoot();
        if (coins.length != totals.length) revert LengthMismatch();

        for (uint256 i; i < coins.length; ++i) {
            address coin = coins[i];
            IMemeFunHook.PoolConfig memory c = hook.configOf(coin);
            if (c.mode != Mode.HOLDERS || c.module != address(this)) revert NotHolderCoin(coin);
            if (epochTotal[epoch][coin] != 0) revert DuplicateCoin(coin);
            uint256 pot = available[coin] + feeVault.pullDestination(coin);
            if (totals[i] == 0 || totals[i] > pot) revert InsufficientRewards(coin, totals[i], pot);
            available[coin] = pot - totals[i];
            epochTotal[epoch][coin] = totals[i];
        }

        epochs[epoch] = Epoch({root: root, publishedAt: uint40(block.timestamp), vetoed: false});
        lastEpoch = epoch;
        emit EpochPublished(epoch, root, coins, totals);
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
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert EpochUnavailable();
        if (!e.vetoed && block.timestamp <= uint256(e.publishedAt) + CLAIM_PERIOD) revert NotReleasable();
        for (uint256 i; i < coins.length; ++i) {
            address coin = coins[i];
            if (epochReleased[epoch][coin]) continue;
            epochReleased[epoch][coin] = true;
            uint256 returned = epochTotal[epoch][coin] - epochClaimed[epoch][coin];
            available[coin] += returned;
            emit EpochReleased(epoch, coin, returned);
        }
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
        Epoch storage e = epochs[c.epoch];
        if (e.root == bytes32(0) || e.vetoed || epochReleased[c.epoch][c.coin]) revert EpochUnavailable();
        if (block.timestamp < uint256(e.publishedAt) + VETO_WINDOW) revert ClaimsNotOpen();
        if (block.timestamp > uint256(e.publishedAt) + CLAIM_PERIOD) revert ClaimPeriodOver();
        BitMaps.BitMap storage bitmap = _claimed[c.epoch][c.coin];
        if (bitmap.get(c.index)) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(c.proof, e.root, leaf(c.epoch, c.coin, c.index, c.account, c.amount))) {
            revert InvalidProof();
        }

        bitmap.set(c.index);
        uint256 claimed = epochClaimed[c.epoch][c.coin] + c.amount;
        if (claimed > epochTotal[c.epoch][c.coin]) revert ExceedsEpochTotal();
        epochClaimed[c.epoch][c.coin] = claimed;
        emit Claimed(c.epoch, c.coin, c.index, c.account, c.amount);
        return Payout(hook.quoteCurrencyOf(c.coin), c.account, c.amount);
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
