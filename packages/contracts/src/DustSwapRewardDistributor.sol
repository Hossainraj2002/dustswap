// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DustSwapRewardDistributor
/// @notice One-shot USDC distribution for the DustSwap Particle Points close-out.
///         Allocations are fixed in a Merkle root at construction and can never be changed.
///         Unclaimed funds can only be recovered by the owner after `claimDeadline` has passed.
///
/// @dev Design notes that matter for review:
///
///      1. ELIGIBILITY IS CHECKED WITH A ZERO-VALUE TRANSACTION. `checkEligibility` writes no
///         storage, it only emits `EligibilityChecked`. It exists so that every check, positive
///         or negative, leaves a permanent on-chain record tied to the address that asked, and
///         so that the transaction carries the DustSwap builder-code attribution suffix the way
///         every other transaction from the app does.
///
///      2. NO FUNCTION IS `payable` AND THERE IS NO `receive()`, so an ordinary transaction
///         carrying ETH reverts. ETH can still arrive by `selfdestruct` or as a block reward,
///         which no contract can refuse, so `rescueEth` exists to recover it. A zero-value
///         transaction with empty or unrecognised calldata lands in `fallback()`, which records
///         a negative eligibility check rather than reverting, so a wallet that sends a bare
///         transfer to this address still gets a useful result.
///
///         The distribution token must be a plain ERC-20. A fee-on-transfer or rebasing token
///         would deliver less than the leaf says and strand the final claims. Base USDC is not
///         one; swapping the token for something exotic is not supported.
///
///      3. CALLDATA SUFFIXES ARE SAFE. The frontend appends the 29-byte ERC-8021 builder-code
///         suffix to every call. Solidity's calldata decoder validates that declared offsets and
///         lengths fit WITHIN calldatasize and ignores trailing bytes, so a suffix never changes
///         how arguments decode. `DustSwapRewardDistributor.t.sol` asserts this against the real
///         production suffix rather than taking it on trust.
///
///      4. LEAVES ARE DOUBLE-HASHED, matching the OpenZeppelin merkle-tree standard format, so an
///         internal node can never be replayed as a leaf.
///
///      5. THE CLAIMED BITMAP IS KEYED ON `index`, NOT ON `account`. A DustSwap account that has
///         linked two wallets can be given one leaf per wallet sharing a single index, which lets
///         either wallet claim while the account is still paid exactly once.
contract DustSwapRewardDistributor is Ownable2Step {
    using SafeERC20 for IERC20;
    using BitMaps for BitMaps.BitMap;

    /// @notice Token being distributed. On Base this is native USDC, 6 decimals.
    IERC20 public immutable token;

    /// @notice Root of the allocation tree. Immutable by design: nobody can be added, removed or
    ///         repriced after deployment, which is the entire trust guarantee of this contract.
    bytes32 public immutable merkleRoot;

    /// @notice Sum of every allocation in the tree, in token base units. Used by `isFullyFunded`.
    uint256 public immutable totalAllocation;

    /// @notice Last timestamp at which a claim is accepted. Sweeping is impossible until after it.
    uint64 public immutable claimDeadline;

    /// @notice Running total of everything claimed so far, in token base units.
    uint256 public totalClaimed;

    /// @notice Number of successful claims.
    uint256 public claimCount;

    BitMaps.BitMap private _claimed;

    /// @notice Emitted for every eligibility check, whether or not the caller is eligible.
    /// @param account        Address that asked.
    /// @param eligible       True when a valid proof for `account` was supplied.
    /// @param amount         Allocation in token base units, or 0 when not eligible.
    /// @param alreadyClaimed True when this allocation has already been paid out.
    event EligibilityChecked(address indexed account, bool eligible, uint256 amount, bool alreadyClaimed);

    /// @param caller Whoever submitted the transaction. Funds always go to `account`, so a third
    ///               party can pay the gas for a user who has no ETH on Base.
    event Claimed(uint256 indexed index, address indexed account, uint256 amount, address caller);

    event Swept(address indexed to, uint256 amount);
    event TokenRescued(address indexed rescuedToken, address indexed to, uint256 amount);
    event EthRescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroRoot();
    error ZeroAllocation();
    error DeadlineNotInFuture();
    error ClaimWindowClosed();
    error ClaimWindowStillOpen();
    error AlreadyClaimed();
    error InvalidProof();
    error NothingToSweep();
    error CannotRescueDistributionToken();
    error OwnershipCannotBeRenounced();
    error EthTransferFailed();

    /// @param token_           Distribution token. Base USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.
    /// @param merkleRoot_      Root of the frozen allocation tree.
    /// @param totalAllocation_ Sum of all allocations, in token base units.
    /// @param claimDeadline_   Unix timestamp of the last claimable second. Must be in the future.
    /// @param owner_           Owner. Use a multisig: after the deadline this address can sweep
    ///                         everything that is left.
    constructor(
        address token_,
        bytes32 merkleRoot_,
        uint256 totalAllocation_,
        uint64 claimDeadline_,
        address owner_
    ) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (merkleRoot_ == bytes32(0)) revert ZeroRoot();
        if (totalAllocation_ == 0) revert ZeroAllocation();
        if (claimDeadline_ <= block.timestamp) revert DeadlineNotInFuture();

        token = IERC20(token_);
        merkleRoot = merkleRoot_;
        totalAllocation = totalAllocation_;
        claimDeadline = claimDeadline_;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Standard OpenZeppelin merkle-tree leaf: keccak256 of the abi-encoded tuple, hashed
    ///         a second time so that no internal node can be presented as a leaf.
    function leaf(uint256 index, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    /// @notice True when `proof` proves that `account` is allocated `amount` at `index`.
    function verify(uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        public
        view
        returns (bool)
    {
        return MerkleProof.verifyCalldata(proof, merkleRoot, leaf(index, account, amount));
    }

    /// @notice True once the allocation at `index` has been paid out.
    function isClaimed(uint256 index) public view returns (bool) {
        return _claimed.get(index);
    }

    /// @notice True when the contract still holds enough token to honour every unclaimed leaf.
    function isFullyFunded() external view returns (bool) {
        return token.balanceOf(address(this)) + totalClaimed >= totalAllocation;
    }

    /// @notice Token base units still owed to unclaimed leaves.
    function outstandingAllocation() external view returns (uint256) {
        return totalAllocation - totalClaimed;
    }

    /// @notice True while claims are still being accepted.
    function isClaimOpen() external view returns (bool) {
        return block.timestamp <= claimDeadline;
    }

    // -------------------------------------------------------------------------------------------
    // Eligibility check (zero value, no storage writes)
    // -------------------------------------------------------------------------------------------

    /// @notice Records an eligibility check for `msg.sender` against the frozen allocation tree.
    /// @dev Costs only gas plus one log. Deliberately not `payable`, so the transaction must carry
    ///      zero ETH. Callers supply their own proof, which is published alongside the allocation
    ///      list, so the result emitted here is verified on chain rather than asserted by a server.
    function checkEligibility(uint256 index, uint256 amount, bytes32[] calldata proof) external {
        bool eligible = verify(index, msg.sender, amount, proof);
        emit EligibilityChecked(msg.sender, eligible, eligible ? amount : 0, eligible && isClaimed(index));
    }

    /// @notice Records a negative eligibility check for an address that holds no allocation.
    /// @dev An address with no leaf has no proof to present, so there is nothing to verify. The
    ///      event is a record that the address asked, and is only meaningful when read together
    ///      with the published allocation list that `merkleRoot` commits to.
    function checkEligibility() external {
        emit EligibilityChecked(msg.sender, false, 0, false);
    }

    // -------------------------------------------------------------------------------------------
    // Claim
    // -------------------------------------------------------------------------------------------

    /// @notice Pays `amount` to `account` against a valid proof. Callable by anyone: funds always
    ///         go to `account`, never to `msg.sender`, so gas can be sponsored safely.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed();
        if (_claimed.get(index)) revert AlreadyClaimed();
        if (!verify(index, account, amount, proof)) revert InvalidProof();

        // Effects before interaction. Marking the index first makes re-entry through a hostile
        // token a no-op, without paying for a reentrancy guard on every claim.
        _claimed.set(index);
        totalClaimed += amount;
        unchecked {
            ++claimCount;
        }

        token.safeTransfer(account, amount);

        emit Claimed(index, account, amount, msg.sender);
    }

    // -------------------------------------------------------------------------------------------
    // Owner
    // -------------------------------------------------------------------------------------------

    /// @notice Recovers everything left after the claim window closes. Reverts while it is open.
    function sweep(address to) external onlyOwner {
        if (block.timestamp <= claimDeadline) revert ClaimWindowStillOpen();
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert NothingToSweep();

        token.safeTransfer(to, balance);
        emit Swept(to, balance);
    }

    /// @notice Disabled. Ownership is what makes `sweep` callable after the deadline, so
    ///         renouncing it would freeze every unclaimed dollar in this contract forever.
    ///         Use `transferOwnership` to hand over, never to throw away.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    /// @notice Recovers ETH that was force-fed in. No function here is payable, so the only way
    ///         ETH arrives is `selfdestruct` or a block reward, and none of it belongs to the
    ///         distribution. Not gated on the deadline because it can never touch claim funds.
    function rescueEth(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToSweep();

        (bool sent,) = to.call{value: balance}("");
        if (!sent) revert EthTransferFailed();

        emit EthRescued(to, balance);
    }

    /// @notice Recovers an unrelated token sent here by mistake. Can never touch the distribution
    ///         token, which is governed by `sweep` and its deadline alone.
    function rescueToken(address rescuedToken, address to) external onlyOwner {
        if (rescuedToken == address(token)) revert CannotRescueDistributionToken();
        if (rescuedToken == address(0) || to == address(0)) revert ZeroAddress();

        uint256 balance = IERC20(rescuedToken).balanceOf(address(this));
        if (balance == 0) revert NothingToSweep();

        IERC20(rescuedToken).safeTransfer(to, balance);
        emit TokenRescued(rescuedToken, to, balance);
    }

    // -------------------------------------------------------------------------------------------
    // Fallback
    // -------------------------------------------------------------------------------------------

    /// @notice Treats a bare transaction to this address as a negative eligibility check.
    /// @dev Reached when calldata is empty, or when it does not begin with a known selector, which
    ///      includes a transaction carrying nothing but the ERC-8021 builder-code suffix. Not
    ///      `payable`, so any transaction carrying ETH reverts and no ETH can be stranded here.
    fallback() external {
        emit EligibilityChecked(msg.sender, false, 0, false);
    }
}
