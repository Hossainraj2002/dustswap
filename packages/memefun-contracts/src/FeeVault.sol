// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {MemeFunConfig} from "./MemeFunConfig.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {IMemeFunHook} from "./interfaces/IMemeFunHook.sol";

/// @title FeeVault
/// @notice Holds every memefun fee until whoever earned it claims it.
///
/// @dev How value moves, and why it is safe:
///
///      1. FEES ARRIVE AS ERC-6909 CLAIMS, NOT TOKENS. On each trade the hook mints the fee to this
///         vault as PoolManager claims (cheap, no token transfer) and then calls `credit` with the
///         exact split. Only the hook can credit, and the hook only credits what it just minted, so
///         the vault's claim balance per currency always equals the sum of what it owes.
///
///      2. PULL, NEVER PUSH. Nobody is paid during a trade. Creators, referrers and the treasury
///         claim when they choose: the vault burns its claims and the PoolManager sends the real
///         ETH or token straight to the recipient. A recipient that cannot receive ETH only blocks
///         its own claim, never a trade or anyone else's payout.
///
///      3. PAYOUT RIGHTS ARE ENFORCED. A coin's creator share is claimable only by that
///         coin's current creator (two-step transferable in the hook), its destination share only
///         by the module the coin launched with, referral balances only by the referrer, and the
///         platform share only to the configured treasury. Author rewards follow the disclosed
///         shared treasury rule below. No owner or admin path bypasses these payout rules.
///
///      4. CHECKS, EFFECTS, THEN INTERACTION, under a transient reentrancy guard: a ledger is zeroed
///         before the PoolManager is unlocked to pay it out.
///
///      5. TWEET AUTHOR RESERVES ARE SEPARATE. The immutable author share comes only from the
///         creator allocation and accrues forever. An author may bind an attested caller wallet
///         at any time. After 180 days FROM LAUNCH, the configured treasury may also withdraw the
///         same unpaid balance, even when the author verified or claimed earlier. Either payout
///         reduces the shared balance; later fees replenish it. The clock is not per fee accrual.
contract FeeVault is IFeeVault, IUnlockCallback, ReentrancyGuardTransient, EIP712 {
    using SafeCast for uint256;

    uint256 public constant AUTHOR_TREASURY_LOCK_PERIOD = 180 days;
    /// @notice Deprecated ABI alias for AUTHOR_TREASURY_LOCK_PERIOD; not a verification cutoff.
    uint256 public constant AUTHOR_VERIFICATION_PERIOD = AUTHOR_TREASURY_LOCK_PERIOD;
    uint256 public constant MIN_AUTHOR_SHARE_BPS = 2000;
    uint256 public constant MAX_AUTHOR_SHARE_BPS = 10_000;
    bytes32 public constant AUTHOR_VERIFICATION_TYPEHASH = keccak256(
        "AuthorVerification(address coin,uint256 authorXUserId,address wallet,uint256 deadline)"
    );

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    MemeFunConfig public immutable config;

    /// @dev Both non-platform shares for one (coin, quote currency) market. One slot.
    struct CoinPending {
        uint128 creator;
        uint128 destination;
    }

    struct Payout {
        Currency currency;
        address to;
        uint256 amount;
    }

    /// @notice Immutable attribution. Only verifiedWallet transitions once to an attested caller.
    /// @dev verifyBy is the legacy ABI name for the treasury's withdrawal unlock timestamp.
    struct TweetAttribution {
        uint256 postId;
        uint256 authorXUserId;
        uint16 authorShareBps;
        uint40 verifyBy;
        address verifiedWallet;
    }

    mapping(address coin => mapping(Currency currency => CoinPending)) internal _coinPending;
    mapping(Currency currency => uint256) public platformPending;
    mapping(address referrer => mapping(Currency currency => uint256)) public referralPending;
    mapping(address coin => TweetAttribution) public tweetAttribution;
    mapping(address coin => mapping(Currency currency => uint256)) private _authorPending;

    event CreatorClaimed(
        address indexed coin, address indexed creator, address to, Currency currency, uint256 amount
    );
    event ReferralClaimed(
        address indexed referrer, Currency indexed currency, address to, uint256 amount
    );
    event PlatformClaimed(Currency indexed currency, address indexed treasury, uint256 amount);
    event DestinationPulled(address indexed coin, address indexed module, uint256 amount);
    event MarketDestinationPulled(
        address indexed coin, address indexed quote, PoolId indexed poolId, uint256 amount
    );
    event TweetAttributed(
        address indexed coin,
        uint256 indexed postId,
        uint256 indexed authorXUserId,
        uint256 authorShareBps,
        uint256 verifyBy
    );
    event AuthorVerified(
        address indexed coin, uint256 indexed authorXUserId, address indexed wallet
    );
    event AuthorClaimed(
        address indexed coin,
        address indexed quote,
        uint256 indexed authorXUserId,
        address wallet,
        address to,
        uint256 amount
    );
    event AuthorRewardsReclaimed(
        address indexed coin,
        address indexed quote,
        uint256 indexed authorXUserId,
        address treasury,
        uint256 amount
    );

    error NotHook();
    error NotCreator();
    error NotModule();
    error NotPoolManager();
    error NothingToClaim();
    error ZeroAddress();
    error ClaimTransferFailed();
    error NotFactory();
    error InvalidTweetIdentity();
    error InvalidAuthorShare(uint256 shareBps);
    error TweetAlreadyAttributed();
    error UnknownTweet(address coin);
    error TweetAttestorDisabled();
    error InvalidAuthorAttestation();
    error AuthorAlreadyVerified();
    error AttestationExpired();
    error NotAuthorWallet();
    error NotTreasury();
    /// @dev Legacy name: treasury withdrawal is still locked; author rights do not expire.
    error AuthorReserveNotExpired(uint256 verifyBy);

    constructor(
        IPoolManager poolManager_,
        IMemeFunHook hook_,
        MemeFunConfig config_
    )
        EIP712("MemeFunFeeVault", "1")
    {
        poolManager = poolManager_;
        hook = hook_;
        config = config_;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    function creatorPending(address coin) external view returns (uint256) {
        if (hook.creatorOf(coin) == address(0)) return 0;
        return _coinPending[coin][hook.quoteCurrencyOf(coin)].creator;
    }

    function destinationPending(address coin) external view returns (uint256) {
        if (hook.creatorOf(coin) == address(0)) return 0;
        return _coinPending[coin][hook.quoteCurrencyOf(coin)].destination;
    }

    function creatorPendingFor(address coin, address quote) external view returns (uint256) {
        hook.poolIdFor(coin, quote);
        return _coinPending[coin][Currency.wrap(quote)].creator;
    }

    function destinationPendingFor(address coin, address quote) external view returns (uint256) {
        hook.poolIdFor(coin, quote);
        return _coinPending[coin][Currency.wrap(quote)].destination;
    }

    /// @notice Shared unpaid author quote rewards. The author may claim after wallet binding;
    ///         after the treasury unlock time, the configured treasury may withdraw them too.
    function authorPending(address coin) external view returns (uint256) {
        if (hook.creatorOf(coin) == address(0)) return 0;
        return _authorPending[coin][hook.quoteCurrencyOf(coin)];
    }

    function authorPendingFor(address coin, address quote) external view returns (uint256) {
        hook.poolIdFor(coin, quote);
        return _authorPending[coin][Currency.wrap(quote)];
    }

    /// @inheritdoc IFeeVault
    function registerTweetAttribution(
        address coin,
        uint256 postId,
        uint256 authorXUserId,
        uint16 authorShareBps
    )
        external
    {
        if (msg.sender != hook.factory()) revert NotFactory();
        if (coin == address(0) || postId == 0 || authorXUserId == 0) revert InvalidTweetIdentity();
        if (authorShareBps < MIN_AUTHOR_SHARE_BPS || authorShareBps > MAX_AUTHOR_SHARE_BPS) {
            revert InvalidAuthorShare(authorShareBps);
        }
        if (tweetAttribution[coin].authorXUserId != 0) revert TweetAlreadyAttributed();
        uint40 verifyBy = uint40(block.timestamp + AUTHOR_TREASURY_LOCK_PERIOD);
        tweetAttribution[coin] =
            TweetAttribution(postId, authorXUserId, authorShareBps, verifyBy, address(0));
        emit TweetAttributed(coin, postId, authorXUserId, authorShareBps, verifyBy);
    }

    // -------------------------------------------------------------------------------------------
    // Hook
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IFeeVault
    function credit(
        address coin,
        Currency currency,
        uint256 platform,
        address referrer,
        uint256 referral,
        uint256 creator,
        uint256 destination
    )
        external
    {
        if (msg.sender != address(hook)) revert NotHook();
        if (platform != 0) platformPending[currency] += platform;
        if (referral != 0) referralPending[referrer][currency] += referral;
        TweetAttribution storage attribution = tweetAttribution[coin];
        if (creator != 0 && attribution.authorXUserId != 0) {
            uint256 author = creator * attribution.authorShareBps / 10_000;
            creator -= author;
            _authorPending[coin][currency] += author;
        }
        if (creator != 0 || destination != 0) {
            CoinPending storage pending = _coinPending[coin][currency];
            pending.creator += creator.toUint128();
            pending.destination += destination.toUint128();
        }
    }

    // -------------------------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------------------------

    /// @notice Binds the author wallet at any time. The backend attests OAuth X-account control
    ///         and the caller wallet; it cannot replace a binding. Treasury access after 180 days
    ///         applies to this same unpaid balance even when a wallet has been bound.
    function verifyAuthor(
        address coin,
        address wallet,
        uint256 deadline,
        bytes calldata signature
    )
        external
        nonReentrant
    {
        TweetAttribution storage attribution = _tweet(coin);
        if (wallet == address(0) || msg.sender != wallet) revert NotAuthorWallet();
        if (attribution.verifiedWallet != address(0)) revert AuthorAlreadyVerified();
        if (block.timestamp > deadline) revert AttestationExpired();
        address attestor = config.tweetAttestor();
        if (attestor == address(0)) revert TweetAttestorDisabled();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    AUTHOR_VERIFICATION_TYPEHASH, coin, attribution.authorXUserId, wallet, deadline
                )
            )
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != attestor) {
            revert InvalidAuthorAttestation();
        }
        attribution.verifiedWallet = wallet;
        emit AuthorVerified(coin, attribution.authorXUserId, wallet);
    }

    function claimAuthor(address coin, address to) external nonReentrant returns (uint256 amount) {
        return _claimAuthor(coin, hook.quoteCurrencyOf(coin), to);
    }

    function claimAuthorFor(
        address coin,
        address quote,
        address to
    )
        external
        nonReentrant
        returns (uint256 amount)
    {
        hook.poolIdFor(coin, quote);
        return _claimAuthor(coin, Currency.wrap(quote), to);
    }

    function _claimAuthor(
        address coin,
        Currency currency,
        address to
    )
        private
        returns (uint256 amount)
    {
        TweetAttribution storage attribution = _tweet(coin);
        if (msg.sender != attribution.verifiedWallet) revert NotAuthorWallet();
        if (to == address(0)) revert ZeroAddress();
        amount = _authorPending[coin][currency];
        if (amount == 0) revert NothingToClaim();
        _authorPending[coin][currency] = 0;
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(currency, to, amount);
        _pay(payouts);
        emit AuthorClaimed(
            coin, Currency.unwrap(currency), attribution.authorXUserId, msg.sender, to, amount
        );
    }

    /// @notice The configured treasury may withdraw the shared unpaid author balance after
    ///         launch +180 days, even when the author verified or claimed earlier. This does not
    ///         stop author accrual or author claims from any remaining or later balance.
    /// @dev Legacy "expired" entry-point name: the timestamp unlocks treasury access.
    function reclaimExpiredAuthor(address coin) external nonReentrant returns (uint256 amount) {
        return _reclaimExpiredAuthor(coin, hook.quoteCurrencyOf(coin));
    }

    function reclaimExpiredAuthorFor(
        address coin,
        address quote
    )
        external
        nonReentrant
        returns (uint256 amount)
    {
        hook.poolIdFor(coin, quote);
        return _reclaimExpiredAuthor(coin, Currency.wrap(quote));
    }

    function _reclaimExpiredAuthor(
        address coin,
        Currency currency
    )
        private
        returns (uint256 amount)
    {
        TweetAttribution storage attribution = _tweet(coin);
        address treasury = config.treasury();
        if (msg.sender != treasury) revert NotTreasury();
        if (block.timestamp < attribution.verifyBy) {
            revert AuthorReserveNotExpired(attribution.verifyBy);
        }
        amount = _authorPending[coin][currency];
        if (amount == 0) revert NothingToClaim();
        _authorPending[coin][currency] = 0;
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(currency, treasury, amount);
        _pay(payouts);
        emit AuthorRewardsReclaimed(
            coin, Currency.unwrap(currency), attribution.authorXUserId, treasury, amount
        );
    }

    function _tweet(address coin) private view returns (TweetAttribution storage attribution) {
        attribution = tweetAttribution[coin];
        if (attribution.authorXUserId == 0) revert UnknownTweet(coin);
    }

    /// @notice Pays a coin's creator earnings to `to`, in the coin's pair asset.
    function claimCreator(address coin, address to) external nonReentrant returns (uint256 amount) {
        return _claimCreator(coin, hook.quoteCurrencyOf(coin), to);
    }

    function claimCreatorFor(
        address coin,
        address quote,
        address to
    )
        external
        nonReentrant
        returns (uint256 amount)
    {
        hook.poolIdFor(coin, quote);
        return _claimCreator(coin, Currency.wrap(quote), to);
    }

    function _claimCreator(
        address coin,
        Currency currency,
        address to
    )
        private
        returns (uint256 amount)
    {
        if (msg.sender != hook.creatorOf(coin)) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = _coinPending[coin][currency].creator;
        if (amount == 0) revert NothingToClaim();
        _coinPending[coin][currency].creator = 0;

        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(currency, to, amount);
        _pay(payouts);
        emit CreatorClaimed(coin, msg.sender, to, currency, amount);
    }

    /// @notice Claims several coins at once; coins with nothing pending are skipped. Each coin pays
    ///         in its own pair asset. Reverts if the caller is not the creator of every coin listed.
    function claimCreatorMany(
        address[] calldata coins,
        address to
    )
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (to == address(0)) revert ZeroAddress();
        Payout[] memory payouts = new Payout[](coins.length);
        uint256 count;
        for (uint256 i; i < coins.length; ++i) {
            address coin = coins[i];
            if (msg.sender != hook.creatorOf(coin)) revert NotCreator();
            Currency currency = hook.quoteCurrencyOf(coin);
            uint256 amount = _coinPending[coin][currency].creator;
            if (amount == 0) continue;
            _coinPending[coin][currency].creator = 0;
            payouts[count++] = Payout(currency, to, amount);
            emit CreatorClaimed(coin, msg.sender, to, currency, amount);
        }
        if (count == 0) revert NothingToClaim();
        assembly ("memory-safe") {
            mstore(payouts, count)
        }
        _pay(payouts);
        return count;
    }

    /// @notice Pays the caller's referral earnings in `currency` to `to`.
    function claimReferral(
        Currency currency,
        address to
    )
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        amount = referralPending[msg.sender][currency];
        if (amount == 0) revert NothingToClaim();
        referralPending[msg.sender][currency] = 0;

        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(currency, to, amount);
        _pay(payouts);
        emit ReferralClaimed(msg.sender, currency, to, amount);
    }

    /// @notice Sends the platform share in `currency` to the treasury. Anyone may trigger it; the
    ///         funds can only ever go to `config.treasury()`.
    function claimPlatform(Currency currency) external nonReentrant returns (uint256 amount) {
        amount = platformPending[currency];
        if (amount == 0) revert NothingToClaim();
        platformPending[currency] = 0;

        address treasury = config.treasury();
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(currency, treasury, amount);
        _pay(payouts);
        emit PlatformClaimed(currency, treasury, amount);
    }

    /// @inheritdoc IFeeVault
    /// @dev Transfers the claims themselves (no unlock): the module spends them inside its own
    ///      PoolManager unlock, burning claims to pay for a buyback or a floor position.
    function pullDestination(address coin) external nonReentrant returns (uint256 amount) {
        return _pullDestination(coin, hook.poolIdOf(coin));
    }

    function pullDestinationFor(
        address coin,
        address quote
    )
        external
        nonReentrant
        returns (uint256 amount)
    {
        return _pullDestination(coin, hook.poolIdFor(coin, quote));
    }

    function _pullDestination(address coin, PoolId id) private returns (uint256 amount) {
        address module = hook.moduleOfPool(id);
        if (module == address(0) || msg.sender != module) revert NotModule();
        Currency currency = hook.quoteCurrencyOfPool(id);
        amount = _coinPending[coin][currency].destination;
        if (amount == 0) return 0;
        _coinPending[coin][currency].destination = 0;
        if (!poolManager.transfer(module, currency.toId(), amount)) revert ClaimTransferFailed();
        emit MarketDestinationPulled(coin, Currency.unwrap(currency), id, amount);
        if (PoolId.unwrap(id) == PoolId.unwrap(hook.poolIdOf(coin))) {
            emit DestinationPulled(coin, module, amount);
        }
    }

    // -------------------------------------------------------------------------------------------
    // Payout
    // -------------------------------------------------------------------------------------------

    function _pay(Payout[] memory payouts) private {
        poolManager.unlock(abi.encode(payouts));
    }

    /// @dev Only reachable through `_pay`: the PoolManager calls back the contract that unlocked.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Payout[] memory payouts = abi.decode(data, (Payout[]));
        for (uint256 i; i < payouts.length; ++i) {
            Payout memory p = payouts[i];
            // Burning claims credits the vault; taking debits it by the same amount and sends the
            // real asset, so the vault ends the unlock with no open delta.
            poolManager.burn(address(this), p.currency.toId(), p.amount);
            poolManager.take(p.currency, p.to, p.amount);
        }
        return "";
    }
}
