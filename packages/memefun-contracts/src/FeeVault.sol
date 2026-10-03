// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

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
///      3. EVERY LEDGER HAS EXACTLY ONE OWNER. A coin's creator share is claimable only by that
///         coin's current creator (two-step transferable in the hook), its destination share only
///         by the module the coin launched with, referral balances only by the referrer, and the
///         platform share only to the configured treasury. No owner or admin path exists to move
///         anyone else's balance.
///
///      4. CHECKS, EFFECTS, THEN INTERACTION, under a transient reentrancy guard: a ledger is zeroed
///         before the PoolManager is unlocked to pay it out.
contract FeeVault is IFeeVault, IUnlockCallback, ReentrancyGuardTransient {
    using SafeCast for uint256;

    IPoolManager public immutable poolManager;
    IMemeFunHook public immutable hook;
    MemeFunConfig public immutable config;

    /// @dev Both sides of a coin's non-platform fee, in the coin's quote currency. One slot.
    struct CoinPending {
        uint128 creator;
        uint128 destination;
    }

    struct Payout {
        Currency currency;
        address to;
        uint256 amount;
    }

    mapping(address coin => CoinPending) internal _coinPending;
    mapping(Currency currency => uint256) public platformPending;
    mapping(address referrer => mapping(Currency currency => uint256)) public referralPending;

    event CreatorClaimed(address indexed coin, address indexed creator, address to, Currency currency, uint256 amount);
    event ReferralClaimed(address indexed referrer, Currency indexed currency, address to, uint256 amount);
    event PlatformClaimed(Currency indexed currency, address indexed treasury, uint256 amount);
    event DestinationPulled(address indexed coin, address indexed module, uint256 amount);

    error NotHook();
    error NotCreator();
    error NotModule();
    error NotPoolManager();
    error NothingToClaim();
    error ZeroAddress();
    error ClaimTransferFailed();

    constructor(IPoolManager poolManager_, IMemeFunHook hook_, MemeFunConfig config_) {
        poolManager = poolManager_;
        hook = hook_;
        config = config_;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    function creatorPending(address coin) external view returns (uint256) {
        return _coinPending[coin].creator;
    }

    function destinationPending(address coin) external view returns (uint256) {
        return _coinPending[coin].destination;
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
    ) external {
        if (msg.sender != address(hook)) revert NotHook();
        if (platform != 0) platformPending[currency] += platform;
        if (referral != 0) referralPending[referrer][currency] += referral;
        if (creator != 0 || destination != 0) {
            CoinPending storage pending = _coinPending[coin];
            pending.creator += creator.toUint128();
            pending.destination += destination.toUint128();
        }
    }

    // -------------------------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------------------------

    /// @notice Pays a coin's creator earnings to `to`, in the coin's pair asset.
    function claimCreator(address coin, address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != hook.creatorOf(coin)) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = _coinPending[coin].creator;
        if (amount == 0) revert NothingToClaim();
        _coinPending[coin].creator = 0;

        Currency currency = hook.quoteCurrencyOf(coin);
        Payout[] memory payouts = new Payout[](1);
        payouts[0] = Payout(currency, to, amount);
        _pay(payouts);
        emit CreatorClaimed(coin, msg.sender, to, currency, amount);
    }

    /// @notice Claims several coins at once; coins with nothing pending are skipped. Each coin pays
    ///         in its own pair asset. Reverts if the caller is not the creator of every coin listed.
    function claimCreatorMany(address[] calldata coins, address to) external nonReentrant returns (uint256 paid) {
        if (to == address(0)) revert ZeroAddress();
        Payout[] memory payouts = new Payout[](coins.length);
        uint256 count;
        for (uint256 i; i < coins.length; ++i) {
            address coin = coins[i];
            if (msg.sender != hook.creatorOf(coin)) revert NotCreator();
            uint256 amount = _coinPending[coin].creator;
            if (amount == 0) continue;
            _coinPending[coin].creator = 0;
            Currency currency = hook.quoteCurrencyOf(coin);
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
    function claimReferral(Currency currency, address to) external nonReentrant returns (uint256 amount) {
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
        address module = hook.moduleOf(coin);
        if (module == address(0) || msg.sender != module) revert NotModule();
        amount = _coinPending[coin].destination;
        if (amount == 0) return 0;
        _coinPending[coin].destination = 0;
        if (!poolManager.transfer(module, hook.quoteCurrencyOf(coin).toId(), amount)) revert ClaimTransferFailed();
        emit DestinationPulled(coin, module, amount);
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
