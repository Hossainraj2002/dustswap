// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice A separate, non-upgradeable, fully funded reward for 1,000 distinct launcher wallets.
/// @dev The immutable signer attests original launches from launchFactory, canonical confirmation,
///      and chronological slots. The existing factory has no immutable wallet/rank registry.
///      Creator transfers never change eligibility. Claims pay only their signed wallet.
///      No function can withdraw the reserved token, change rewards/signers, or pause old claims.
///      The owner may enable a trade rule once, for launches in future blocks only. The signer
///      must retain every earlier wallet's original slot when issuing or refreshing tickets.
///      Reward tokens must transfer exact amounts; taxed/rebasing tokens are unsupported.
contract MemeFunLaunchRewards is Ownable2Step, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_RECIPIENTS = 1000;
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address wallet,uint16 slot,address coin,uint256 launchBlock,uint256 tradeBlock,uint256 deadline)"
    );

    IERC20 public immutable rewardToken;
    uint8 public immutable tokenDecimals;
    uint256 public immutable rewardAmountRaw;
    uint256 public immutable totalAllocation;
    address public immutable campaignSigner;
    address public immutable launchFactory;

    bool public activated;
    uint256 public startBlock;
    uint256 public tradeRequiredFromBlock;
    uint256 public claimedCount;
    mapping(address wallet => bool) public claimed;
    mapping(uint16 slot => bool) public slotClaimed;

    struct Claim {
        address wallet;
        uint16 slot;
        address coin;
        uint256 launchBlock;
        uint256 tradeBlock;
        uint256 deadline;
    }

    event Activated(uint256 indexed startBlock, uint256 totalAllocation);
    event TradeRequirementEnabled(uint256 indexed fromBlock);
    event Claimed(
        address indexed wallet,
        uint16 indexed slot,
        address indexed coin,
        uint256 rewardAmountRaw,
        uint256 launchBlock,
        uint256 tradeBlock
    );

    error InvalidConfiguration();
    error WrongTokenDecimals(uint8 expected, uint8 actual);
    error AlreadyActivated();
    error NotActivated();
    error InsufficientFunding(uint256 balance, uint256 required);
    error TradeRequirementAlreadyEnabled();
    error WrongWallet();
    error InvalidAllocation();
    error WalletAlreadyClaimed();
    error SlotAlreadyClaimed();
    error CampaignFull();
    error Expired();
    error InvalidLaunchBlock();
    error InvalidTradeBlock();
    error TradeRequired();
    error InvalidSignature();
    error InexactTokenTransfer();
    error OwnershipCannotBeRenounced();

    constructor(
        address owner_,
        IERC20 token_,
        uint8 decimals_,
        uint256 rewardAmountRaw_,
        address signer_,
        address launchFactory_
    )
        Ownable(owner_)
        EIP712("MemeFunLaunchRewards", "1")
    {
        if (
            address(token_).code.length == 0 || signer_ == address(0)
                || launchFactory_.code.length == 0 || rewardAmountRaw_ == 0
                || rewardAmountRaw_ > type(uint256).max / MAX_RECIPIENTS
        ) revert InvalidConfiguration();
        uint8 actualDecimals = IERC20Metadata(address(token_)).decimals();
        if (actualDecimals != decimals_) revert WrongTokenDecimals(decimals_, actualDecimals);
        rewardToken = token_;
        tokenDecimals = decimals_;
        rewardAmountRaw = rewardAmountRaw_;
        totalAllocation = rewardAmountRaw_ * MAX_RECIPIENTS;
        campaignSigner = signer_;
        launchFactory = launchFactory_;
    }

    /// @notice Fund via a plain token transfer first. Only later-block launches are eligible.
    function activate() external onlyOwner {
        if (activated) revert AlreadyActivated();
        _requireFunding(totalAllocation);
        activated = true;
        startBlock = block.number;
        emit Activated(startBlock, totalAllocation);
    }

    /// @notice Applies once to future launches. Existing participants retain launch-only terms.
    function enableTradeRequirement() external onlyOwner {
        if (!activated) revert NotActivated();
        if (tradeRequiredFromBlock != 0) revert TradeRequirementAlreadyEnabled();
        tradeRequiredFromBlock = block.number + 1;
        emit TradeRequirementEnabled(tradeRequiredFromBlock);
    }

    function remainingReserve() public view returns (uint256) {
        return (MAX_RECIPIENTS - claimedCount) * rewardAmountRaw;
    }

    /// @notice Public/server feature flags may advertise only when this on-chain condition holds.
    function isEnabled() external view returns (bool) {
        return activated && claimedCount < MAX_RECIPIENTS
            && rewardToken.balanceOf(address(this)) >= remainingReserve();
    }

    function claimDigest(Claim calldata allocation) external view returns (bytes32) {
        return _digest(allocation);
    }

    function claim(
        address wallet,
        uint16 slot,
        address coin,
        uint256 launchBlock,
        uint256 tradeBlock,
        uint256 deadline,
        bytes calldata signature
    )
        external
        nonReentrant
    {
        if (!activated) revert NotActivated();
        if (msg.sender != wallet || wallet == address(0)) revert WrongWallet();
        if (slot >= MAX_RECIPIENTS || coin == address(0)) revert InvalidAllocation();
        if (claimed[wallet]) revert WalletAlreadyClaimed();
        if (slotClaimed[slot]) revert SlotAlreadyClaimed();
        if (claimedCount >= MAX_RECIPIENTS) revert CampaignFull();
        if (block.timestamp > deadline) revert Expired();
        if (launchBlock <= startBlock || launchBlock > block.number) revert InvalidLaunchBlock();
        if (tradeBlock > block.number) revert InvalidTradeBlock();
        if (
            tradeRequiredFromBlock != 0 && launchBlock >= tradeRequiredFromBlock
                && tradeBlock <= launchBlock
        ) revert TradeRequired();
        Claim memory allocation = Claim(wallet, slot, coin, launchBlock, tradeBlock, deadline);
        (address recovered, ECDSA.RecoverError error,) =
            ECDSA.tryRecover(_digest(allocation), signature);
        if (error != ECDSA.RecoverError.NoError || recovered != campaignSigner) {
            revert InvalidSignature();
        }
        _requireFunding(remainingReserve());
        uint256 contractBefore = rewardToken.balanceOf(address(this));
        uint256 walletBefore = rewardToken.balanceOf(wallet);
        claimed[wallet] = true;
        slotClaimed[slot] = true;
        ++claimedCount;
        rewardToken.safeTransfer(wallet, rewardAmountRaw);
        uint256 contractAfter = rewardToken.balanceOf(address(this));
        uint256 walletAfter = rewardToken.balanceOf(wallet);
        if (
            contractAfter != contractBefore - rewardAmountRaw || walletAfter < walletBefore
                || walletAfter - walletBefore != rewardAmountRaw
        ) revert InexactTokenTransfer();
        _requireFunding(remainingReserve());
        emit Claimed(wallet, slot, coin, rewardAmountRaw, launchBlock, tradeBlock);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    function _digest(Claim memory allocation) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLAIM_TYPEHASH,
                    allocation.wallet,
                    allocation.slot,
                    allocation.coin,
                    allocation.launchBlock,
                    allocation.tradeBlock,
                    allocation.deadline
                )
            )
        );
    }

    function _requireFunding(uint256 required) private view {
        uint256 balance = rewardToken.balanceOf(address(this));
        if (balance < required) revert InsufficientFunding(balance, required);
    }
}
