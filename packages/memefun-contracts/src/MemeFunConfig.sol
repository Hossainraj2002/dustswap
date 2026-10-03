// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {Mode, PriceSource, QuoteKind} from "./types/MemeFunTypes.sol";

/// @title MemeFunConfig
/// @notice Every setting the memefun owner (a Safe) can change, and nothing else.
///
/// @dev What makes this contract safe to hand to an owner:
///
///      1. IT ONLY SHAPES NEW LAUNCHES. MemeFunFactory reads these values when a coin launches and
///         MemeFunHook snapshots them into that coin's pool config. No value here is ever read for
///         an existing coin's trades, so no setting can change a coin's terms under its holders.
///
///      2. EVERY VALUE IS BOUNDED BY A COMPILE-TIME CAP (`MAX_*`), mirroring HARD_CAPS in
///         apps/memefun/src/core/constants.ts. Not even the owner can exceed them.
///
///      3. THE SETTER NAMES ARE THE ADMIN PAGE'S. apps/memefun/src/lib/admin/ownerCalls.ts already
///         prepares `setCreationFee`, `setFeeBounds`, `setPlatformShareBps`, `setReferralShareBps`,
///         `setCreatorKeepMaxBps`, `setLaunchProtection`, `setOpeningFdvUsd`, `setLaunchesPaused`,
///         `setModeEnabled` and `setQuoteKindEnabled` with exactly these signatures.
///
///      4. PRICES ONLY PLACE OPENING PRICES. A quote's USD price sets where a new coin's single-sided
///         position starts (about $5,000 FDV on every pair). It is never used for trading. A stale
///         or missing price blocks new launches on that quote, and nothing else.
contract MemeFunConfig is Ownable2Step {
    // -------------------------------------------------------------------------------------------
    // Hard caps
    // -------------------------------------------------------------------------------------------

    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_PLATFORM_SHARE_BPS = 5_000;
    uint256 public constant MAX_REFERRAL_SHARE_BPS = 5_000;
    uint256 public constant MAX_CREATOR_KEEP_BPS = 5_000;
    uint256 public constant MAX_PROTECTION_START_BPS = 9_900;
    uint256 public constant MAX_PROTECTION_DURATION_SEC = 300;
    uint256 public constant MAX_CREATION_FEE = 0.05 ether;
    uint256 public constant MIN_OPENING_FDV_USD_E8 = 1_000e8;
    uint256 public constant MAX_OPENING_FDV_USD_E8 = 1_000_000e8;
    /// @notice The price keeper may move a manual price at most this far per update.
    uint256 public constant MAX_MANUAL_PRICE_MOVE_BPS = 2_000;
    /// @notice No quote price may be trusted for longer than this, whatever its own max age.
    uint256 public constant MAX_PRICE_AGE = 7 days;

    // -------------------------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------------------------

    /// @notice Terms every new coin is launched with. Packed into one slot.
    struct LaunchTerms {
        uint96 creationFee;
        uint16 feeMinBps;
        uint16 feeMaxBps;
        uint16 defaultFeeBps;
        uint16 platformShareBps;
        uint16 referralShareBps;
        uint16 creatorKeepMaxBps;
        uint16 protectionStartBps;
        uint16 protectionDurationSec;
        bool launchesPaused;
    }

    struct Quote {
        bool listed;
        bool enabled;
        QuoteKind kind;
        uint8 decimals;
        PriceSource source;
        uint32 maxAge;
        uint64 priceUsdE8;
        uint40 priceUpdatedAt;
        address feed;
    }

    struct ModeInfo {
        bool enabled;
        address module;
    }

    LaunchTerms internal _terms;
    uint64 public openingFdvUsdE8;

    mapping(address quote => Quote) internal _quotes;
    address[] internal _quoteList;
    mapping(QuoteKind kind => bool) public kindEnabled;
    mapping(Mode mode => ModeInfo) internal _modes;

    /// @notice Receives the platform share of every fee.
    address public treasury;
    /// @notice May update MANUAL quote prices (tokenized stock NAVs), within bounds.
    address public priceKeeper;
    /// @notice May publish holder-reward epochs, which the owner can veto.
    address public rewardsPublisher;

    // -------------------------------------------------------------------------------------------
    // Events and errors
    // -------------------------------------------------------------------------------------------

    event SettingUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue);
    event QuoteListed(
        address indexed quote,
        QuoteKind kind,
        uint8 decimals,
        PriceSource source,
        address feed,
        uint64 priceUsdE8,
        uint32 maxAge
    );
    event QuotePricingUpdated(address indexed quote, PriceSource source, address feed, uint64 priceUsdE8, uint32 maxAge);
    event QuoteEnabled(address indexed quote, bool enabled);
    event QuotePriceSet(address indexed quote, uint64 oldPriceUsdE8, uint64 newPriceUsdE8, address indexed setter);
    event QuoteKindEnabled(QuoteKind indexed kind, bool enabled);
    event ModeUpdated(Mode indexed mode, bool enabled, address module);
    event RoleUpdated(bytes32 indexed role, address oldAccount, address newAccount);

    error ValueAboveCap(bytes32 key, uint256 value, uint256 cap);
    error InvalidFeeBounds(uint256 minBps, uint256 maxBps, uint256 defaultBps);
    error InvalidOpeningFdv(uint256 usdE8);
    error InvalidMode(uint256 mode);
    error InvalidKind(uint256 kind);
    error InvalidModule(Mode mode, address module);
    error ZeroAddress();
    error QuoteAlreadyListed(address quote);
    error QuoteNotListed(address quote);
    error InvalidQuote(address quote);
    error InvalidPriceConfig();
    error PriceMoveTooLarge(uint256 oldPriceUsdE8, uint256 newPriceUsdE8);
    error NotPriceKeeper();
    error StalePrice(address quote, uint256 updatedAt);
    error InvalidPrice(address quote);
    error OwnershipCannotBeRenounced();

    bytes32 private constant KEY_CREATION_FEE = "creationFee";
    bytes32 private constant KEY_FEE_MIN = "feeMinBps";
    bytes32 private constant KEY_FEE_MAX = "feeMaxBps";
    bytes32 private constant KEY_FEE_DEFAULT = "defaultFeeBps";
    bytes32 private constant KEY_PLATFORM_SHARE = "platformShareBps";
    bytes32 private constant KEY_REFERRAL_SHARE = "referralShareBps";
    bytes32 private constant KEY_CREATOR_KEEP_MAX = "creatorKeepMaxBps";
    bytes32 private constant KEY_PROTECTION_START = "protectionStartBps";
    bytes32 private constant KEY_PROTECTION_DURATION = "protectionDurationSec";
    bytes32 private constant KEY_OPENING_FDV = "openingFdvUsdE8";
    bytes32 private constant KEY_LAUNCHES_PAUSED = "launchesPaused";
    bytes32 private constant ROLE_TREASURY = "treasury";
    bytes32 private constant ROLE_PRICE_KEEPER = "priceKeeper";
    bytes32 private constant ROLE_REWARDS_PUBLISHER = "rewardsPublisher";

    /// @param owner_ Owner. Use a Safe: it controls settings for new launches and nothing else.
    /// @param treasury_ Receives the platform share of fees.
    /// @dev Starts with the same defaults as DEFAULT_LAUNCH_SETTINGS in the app: free launches,
    ///      a 1-5% fee (1% default), a 20% platform share, 25% of it for referrers, creators may
    ///      keep up to 50% in community modes, 50% launch protection over 15 s, a $5,000 opening
    ///      FDV, ETH and stable pairs on and stock pairs off until legal review.
    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        _terms = LaunchTerms({
            creationFee: 0,
            feeMinBps: 100,
            feeMaxBps: 500,
            defaultFeeBps: 100,
            platformShareBps: 2_000,
            referralShareBps: 2_500,
            creatorKeepMaxBps: 5_000,
            protectionStartBps: 5_000,
            protectionDurationSec: 15,
            launchesPaused: false
        });
        openingFdvUsdE8 = 5_000e8;
        // Creator mode needs no module; the community modes are enabled once their modules exist.
        _modes[Mode.CREATOR].enabled = true;
        kindEnabled[QuoteKind.NATIVE] = true;
        kindEnabled[QuoteKind.STABLE] = true;
        emit RoleUpdated(ROLE_TREASURY, address(0), treasury_);
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    function launchTerms() external view returns (LaunchTerms memory) {
        return _terms;
    }

    function quote(address quoteToken) external view returns (Quote memory) {
        return _quotes[quoteToken];
    }

    function quotes() external view returns (address[] memory) {
        return _quoteList;
    }

    function modeInfo(Mode mode) external view returns (ModeInfo memory) {
        return _modes[mode];
    }

    /// @notice True when new coins may launch against `quoteToken` right now (price freshness is
    ///         checked separately by `quotePriceUsdE8`).
    function isLaunchableQuote(address quoteToken) public view returns (bool) {
        Quote storage q = _quotes[quoteToken];
        return q.listed && q.enabled && kindEnabled[q.kind];
    }

    /// @notice USD price of one whole `quoteToken`, 8 decimals. Reverts when the price is missing
    ///         or older than the quote's max age; the factory then refuses new launches on it.
    function quotePriceUsdE8(address quoteToken) external view returns (uint256) {
        Quote storage q = _quotes[quoteToken];
        if (!q.listed) revert QuoteNotListed(quoteToken);
        if (q.source == PriceSource.FIXED) return q.priceUsdE8;
        if (q.source == PriceSource.MANUAL) {
            if (block.timestamp - q.priceUpdatedAt > q.maxAge) revert StalePrice(quoteToken, q.priceUpdatedAt);
            return q.priceUsdE8;
        }
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(q.feed).latestRoundData();
        if (answer <= 0) revert InvalidPrice(quoteToken);
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > q.maxAge) revert StalePrice(quoteToken, updatedAt);
        return uint256(answer);
    }

    // -------------------------------------------------------------------------------------------
    // Launch terms (signatures match the admin page)
    // -------------------------------------------------------------------------------------------

    function setCreationFee(uint256 feeWei) external onlyOwner {
        _cap(KEY_CREATION_FEE, feeWei, MAX_CREATION_FEE);
        emit SettingUpdated(KEY_CREATION_FEE, _terms.creationFee, feeWei);
        _terms.creationFee = uint96(feeWei);
    }

    /// @notice Range creators may choose from at launch, and the value the app preselects.
    function setFeeBounds(uint256 minBps, uint256 maxBps, uint256 defaultBps) external onlyOwner {
        _cap(KEY_FEE_MAX, maxBps, MAX_FEE_BPS);
        if (minBps > defaultBps || defaultBps > maxBps) revert InvalidFeeBounds(minBps, maxBps, defaultBps);
        LaunchTerms storage t = _terms;
        emit SettingUpdated(KEY_FEE_MIN, t.feeMinBps, minBps);
        emit SettingUpdated(KEY_FEE_MAX, t.feeMaxBps, maxBps);
        emit SettingUpdated(KEY_FEE_DEFAULT, t.defaultFeeBps, defaultBps);
        t.feeMinBps = uint16(minBps);
        t.feeMaxBps = uint16(maxBps);
        t.defaultFeeBps = uint16(defaultBps);
    }

    function setPlatformShareBps(uint256 bps) external onlyOwner {
        _cap(KEY_PLATFORM_SHARE, bps, MAX_PLATFORM_SHARE_BPS);
        emit SettingUpdated(KEY_PLATFORM_SHARE, _terms.platformShareBps, bps);
        _terms.platformShareBps = uint16(bps);
    }

    function setReferralShareBps(uint256 bps) external onlyOwner {
        _cap(KEY_REFERRAL_SHARE, bps, MAX_REFERRAL_SHARE_BPS);
        emit SettingUpdated(KEY_REFERRAL_SHARE, _terms.referralShareBps, bps);
        _terms.referralShareBps = uint16(bps);
    }

    function setCreatorKeepMaxBps(uint256 bps) external onlyOwner {
        _cap(KEY_CREATOR_KEEP_MAX, bps, MAX_CREATOR_KEEP_BPS);
        emit SettingUpdated(KEY_CREATOR_KEEP_MAX, _terms.creatorKeepMaxBps, bps);
        _terms.creatorKeepMaxBps = uint16(bps);
    }

    /// @notice Fee at the moment of launch and how long it takes to decay to the coin's own fee.
    ///         A start at or below the coin's fee, or a zero duration, turns protection off.
    function setLaunchProtection(uint256 startBps, uint256 durationSec) external onlyOwner {
        _cap(KEY_PROTECTION_START, startBps, MAX_PROTECTION_START_BPS);
        _cap(KEY_PROTECTION_DURATION, durationSec, MAX_PROTECTION_DURATION_SEC);
        emit SettingUpdated(KEY_PROTECTION_START, _terms.protectionStartBps, startBps);
        emit SettingUpdated(KEY_PROTECTION_DURATION, _terms.protectionDurationSec, durationSec);
        _terms.protectionStartBps = uint16(startBps);
        _terms.protectionDurationSec = uint16(durationSec);
    }

    /// @param usdE8 Opening fully diluted value in USD with 8 decimals ($5,000 is 5_000e8).
    function setOpeningFdvUsd(uint256 usdE8) external onlyOwner {
        if (usdE8 < MIN_OPENING_FDV_USD_E8 || usdE8 > MAX_OPENING_FDV_USD_E8) revert InvalidOpeningFdv(usdE8);
        emit SettingUpdated(KEY_OPENING_FDV, openingFdvUsdE8, usdE8);
        openingFdvUsdE8 = uint64(usdE8);
    }

    /// @notice Stops or resumes NEW launches. Existing coins trade regardless; nothing can stop them.
    function setLaunchesPaused(bool paused) external onlyOwner {
        emit SettingUpdated(KEY_LAUNCHES_PAUSED, _terms.launchesPaused ? 1 : 0, paused ? 1 : 0);
        _terms.launchesPaused = paused;
    }

    // -------------------------------------------------------------------------------------------
    // Modes
    // -------------------------------------------------------------------------------------------

    /// @param mode Index as in the app: 0 creator, 1 burn, 2 holders, 3 floor.
    function setModeEnabled(uint256 mode, bool enabled) external onlyOwner {
        Mode m = _mode(mode);
        ModeInfo storage info = _modes[m];
        if (enabled && m != Mode.CREATOR && info.module == address(0)) revert InvalidModule(m, address(0));
        info.enabled = enabled;
        emit ModeUpdated(m, enabled, info.module);
    }

    /// @notice Points a community mode at the module that will receive its fees, for NEW launches.
    ///         Coins already launched keep the module they launched with.
    function setModeModule(uint256 mode, address module) external onlyOwner {
        Mode m = _mode(mode);
        if (m == Mode.CREATOR || module.code.length == 0) revert InvalidModule(m, module);
        _modes[m].module = module;
        emit ModeUpdated(m, _modes[m].enabled, module);
    }

    // -------------------------------------------------------------------------------------------
    // Quotes
    // -------------------------------------------------------------------------------------------

    /// @param kind Index as in the app: 0 native, 1 stable, 2 stock.
    function setQuoteKindEnabled(uint256 kind, bool enabled) external onlyOwner {
        if (kind > uint256(type(QuoteKind).max)) revert InvalidKind(kind);
        kindEnabled[QuoteKind(kind)] = enabled;
        emit QuoteKindEnabled(QuoteKind(kind), enabled);
    }

    /// @notice Lists a pair asset, disabled until `setQuoteEnabled`. `address(0)` is native ETH.
    function listQuote(
        address quoteToken,
        QuoteKind kind,
        PriceSource source,
        address feed,
        uint64 priceUsdE8,
        uint32 maxAge
    ) external onlyOwner {
        Quote storage q = _quotes[quoteToken];
        if (q.listed) revert QuoteAlreadyListed(quoteToken);
        if ((kind == QuoteKind.NATIVE) != (quoteToken == address(0))) revert InvalidQuote(quoteToken);
        uint8 decimals = quoteToken == address(0) ? 18 : IERC20Metadata(quoteToken).decimals();
        if (decimals < 6 || decimals > 18) revert InvalidQuote(quoteToken);

        q.listed = true;
        q.kind = kind;
        q.decimals = decimals;
        _setPricing(q, source, feed, priceUsdE8, maxAge);
        _quoteList.push(quoteToken);
        emit QuoteListed(quoteToken, kind, decimals, source, feed, priceUsdE8, maxAge);
    }

    function updateQuotePricing(address quoteToken, PriceSource source, address feed, uint64 priceUsdE8, uint32 maxAge)
        external
        onlyOwner
    {
        Quote storage q = _quotes[quoteToken];
        if (!q.listed) revert QuoteNotListed(quoteToken);
        _setPricing(q, source, feed, priceUsdE8, maxAge);
        emit QuotePricingUpdated(quoteToken, source, feed, priceUsdE8, maxAge);
    }

    function setQuoteEnabled(address quoteToken, bool enabled) external onlyOwner {
        Quote storage q = _quotes[quoteToken];
        if (!q.listed) revert QuoteNotListed(quoteToken);
        q.enabled = enabled;
        emit QuoteEnabled(quoteToken, enabled);
    }

    /// @notice Updates a MANUAL price, e.g. a tokenized stock's NAV. The price keeper may move it at
    ///         most 20% per update; the owner may set any positive value.
    function setManualPrice(address quoteToken, uint64 priceUsdE8) external {
        bool isOwner = msg.sender == owner();
        if (!isOwner && msg.sender != priceKeeper) revert NotPriceKeeper();
        Quote storage q = _quotes[quoteToken];
        if (!q.listed) revert QuoteNotListed(quoteToken);
        if (q.source != PriceSource.MANUAL || priceUsdE8 == 0) revert InvalidPriceConfig();
        uint64 old = q.priceUsdE8;
        if (!isOwner) {
            uint256 maxMove = uint256(old) * MAX_MANUAL_PRICE_MOVE_BPS / 10_000;
            uint256 move = priceUsdE8 > old ? priceUsdE8 - old : old - priceUsdE8;
            if (move > maxMove) revert PriceMoveTooLarge(old, priceUsdE8);
        }
        q.priceUsdE8 = priceUsdE8;
        q.priceUpdatedAt = uint40(block.timestamp);
        emit QuotePriceSet(quoteToken, old, priceUsdE8, msg.sender);
    }

    // -------------------------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------------------------

    function setTreasury(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        emit RoleUpdated(ROLE_TREASURY, treasury, account);
        treasury = account;
    }

    /// @notice `address(0)` leaves price updates to the owner alone.
    function setPriceKeeper(address account) external onlyOwner {
        emit RoleUpdated(ROLE_PRICE_KEEPER, priceKeeper, account);
        priceKeeper = account;
    }

    /// @notice `address(0)` stops new holder epochs from being published.
    function setRewardsPublisher(address account) external onlyOwner {
        emit RoleUpdated(ROLE_REWARDS_PUBLISHER, rewardsPublisher, account);
        rewardsPublisher = account;
    }

    /// @notice Disabled. Without an owner, new launches could never be paused and treasury, keeper
    ///         and module settings would be frozen. Hand over with `transferOwnership` instead.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    // -------------------------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------------------------

    function _setPricing(Quote storage q, PriceSource source, address feed, uint64 priceUsdE8, uint32 maxAge) private {
        if (source == PriceSource.FIXED) {
            if (priceUsdE8 == 0 || feed != address(0)) revert InvalidPriceConfig();
            q.feed = address(0);
            q.maxAge = 0;
        } else if (source == PriceSource.CHAINLINK) {
            if (feed.code.length == 0 || maxAge == 0 || maxAge > MAX_PRICE_AGE) revert InvalidPriceConfig();
            if (IAggregatorV3(feed).decimals() != 8) revert InvalidPriceConfig();
            q.feed = feed;
            q.maxAge = maxAge;
            priceUsdE8 = 0;
        } else {
            if (priceUsdE8 == 0 || feed != address(0) || maxAge == 0 || maxAge > MAX_PRICE_AGE) revert InvalidPriceConfig();
            q.feed = address(0);
            q.maxAge = maxAge;
            q.priceUpdatedAt = uint40(block.timestamp);
        }
        q.source = source;
        q.priceUsdE8 = priceUsdE8;
    }

    function _mode(uint256 mode) private pure returns (Mode) {
        if (mode > uint256(type(Mode).max)) revert InvalidMode(mode);
        return Mode(mode);
    }

    function _cap(bytes32 key, uint256 value, uint256 cap) private pure {
        if (value > cap) revert ValueAboveCap(key, value, cap);
    }
}
