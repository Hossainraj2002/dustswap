// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DustSwapRewardDistributor} from "../src/DustSwapRewardDistributor.sol";

/// @dev Minimal 6-decimal token standing in for Base USDC.
contract MockUSDC {
    string public name = "Mock USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title DustSwapRewardDistributor tests
/// @notice The Merkle construction mirrored here is the same one `buildAllocation.ts` uses:
///         double-hashed leaves, leaves sorted ascending, sorted-pair parents, odd node promoted.
contract DustSwapRewardDistributorTest is Test {
    /// @dev The real production builder-code suffix, from `Attribution.toDataSuffix({codes:
    ///      ["bc_tpolfjho"]})` in apps/web/src/lib/builderCode.ts. 29 bytes. Hardcoded on purpose:
    ///      if the app's builder code changes, these tests must be re-pointed deliberately.
    bytes constant BUILDER_SUFFIX = hex"62635f74706f6c666a686f0b0080218021802180218021802180218021";

    MockUSDC internal usdc;
    MockUSDC internal other;
    DustSwapRewardDistributor internal dist;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0x7EA5);
    address internal relayer = address(0x3E14);

    // Allocation fixture. Indexes 3 and 4 share index 3 on purpose: that is the dual-wallet case,
    // one DustSwap account with two linked addresses and a single payout.
    address[] internal accounts;
    uint256[] internal indexes;
    uint256[] internal amounts;

    bytes32[] internal leaves;
    bytes32 internal root;
    uint64 internal deadline;
    uint256 internal totalAllocation;

    function setUp() public {
        usdc = new MockUSDC();
        other = new MockUSDC();

        _push(0, address(0x1001), 12_400000);
        _push(1, address(0x1002), 1_000000);
        _push(2, address(0x1003), 756_390000);
        _push(3, address(0x1004), 40_000000); // dual wallet, address A
        _push(3, address(0x1005), 40_000000); // dual wallet, address B, same index
        _push(4, address(0x1006), 500000);

        // The dual-wallet pair is one payout, so it is counted once.
        totalAllocation = 12_400000 + 1_000000 + 756_390000 + 40_000000 + 500000;

        root = _buildRoot();
        deadline = uint64(block.timestamp + 90 days);

        dist = new DustSwapRewardDistributor(address(usdc), root, totalAllocation, deadline, owner);
        usdc.mint(address(dist), totalAllocation);
    }

    // ------------------------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------------------------

    function test_constructor_setsState() public view {
        assertEq(address(dist.token()), address(usdc));
        assertEq(dist.merkleRoot(), root);
        assertEq(dist.totalAllocation(), totalAllocation);
        assertEq(dist.claimDeadline(), deadline);
        assertEq(dist.owner(), owner);
        assertEq(dist.totalClaimed(), 0);
        assertEq(dist.claimCount(), 0);
        assertTrue(dist.isFullyFunded());
        assertTrue(dist.isClaimOpen());
        assertEq(dist.outstandingAllocation(), totalAllocation);
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(DustSwapRewardDistributor.ZeroAddress.selector);
        new DustSwapRewardDistributor(address(0), root, 1, deadline, owner);
    }

    function test_constructor_rejectsZeroRoot() public {
        vm.expectRevert(DustSwapRewardDistributor.ZeroRoot.selector);
        new DustSwapRewardDistributor(address(usdc), bytes32(0), 1, deadline, owner);
    }

    function test_constructor_rejectsZeroAllocation() public {
        vm.expectRevert(DustSwapRewardDistributor.ZeroAllocation.selector);
        new DustSwapRewardDistributor(address(usdc), root, 0, deadline, owner);
    }

    function test_constructor_rejectsPastDeadline() public {
        vm.expectRevert(DustSwapRewardDistributor.DeadlineNotInFuture.selector);
        new DustSwapRewardDistributor(address(usdc), root, 1, uint64(block.timestamp), owner);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new DustSwapRewardDistributor(address(usdc), root, 1, deadline, address(0));
    }

    // ------------------------------------------------------------------------------------------
    // Proof verification
    // ------------------------------------------------------------------------------------------

    function test_leaf_matchesStandardFormat() public view {
        bytes32 expected = keccak256(bytes.concat(keccak256(abi.encode(uint256(7), address(0xBEEF), uint256(123)))));
        assertEq(dist.leaf(7, address(0xBEEF), 123), expected);
    }

    function test_verify_acceptsEveryLeaf() public view {
        for (uint256 i = 0; i < accounts.length; i++) {
            assertTrue(dist.verify(indexes[i], accounts[i], amounts[i], _proof(i)), "leaf should verify");
        }
    }

    function test_verify_rejectsWrongAmount() public view {
        assertFalse(dist.verify(indexes[0], accounts[0], amounts[0] + 1, _proof(0)));
    }

    function test_verify_rejectsWrongAccount() public view {
        assertFalse(dist.verify(indexes[0], address(0xDEAD), amounts[0], _proof(0)));
    }

    function test_verify_rejectsWrongIndex() public view {
        assertFalse(dist.verify(indexes[0] + 99, accounts[0], amounts[0], _proof(0)));
    }

    function test_verify_rejectsForeignProof() public view {
        assertFalse(dist.verify(indexes[0], accounts[0], amounts[0], _proof(1)));
    }

    /// @dev A double-hashed leaf means an internal node can never be replayed as a leaf.
    function test_verify_rejectsInternalNodeReplay() public view {
        bytes32[] memory p = _proof(0);
        bytes32 parent = _hashPair(leaves[_sortedPos(0)], p[0]);
        bytes32[] memory empty = new bytes32[](0);
        assertFalse(dist.verify(uint256(parent), address(0), 0, empty));
    }

    // ------------------------------------------------------------------------------------------
    // Claim
    // ------------------------------------------------------------------------------------------

    function test_claim_paysAccountAndRecordsState() public {
        uint256 i = 0;
        vm.expectEmit(true, true, false, true, address(dist));
        emit DustSwapRewardDistributor.Claimed(indexes[i], accounts[i], amounts[i], accounts[i]);

        vm.prank(accounts[i]);
        dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));

        assertEq(usdc.balanceOf(accounts[i]), amounts[i]);
        assertTrue(dist.isClaimed(indexes[i]));
        assertEq(dist.totalClaimed(), amounts[i]);
        assertEq(dist.claimCount(), 1);
        assertEq(dist.outstandingAllocation(), totalAllocation - amounts[i]);
    }

    function test_claim_isRelayable() public {
        uint256 i = 1;
        vm.prank(relayer);
        dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));

        assertEq(usdc.balanceOf(accounts[i]), amounts[i], "recipient is the leaf address");
        assertEq(usdc.balanceOf(relayer), 0, "relayer must never receive funds");
    }

    function test_claim_revertsOnSecondAttempt() public {
        uint256 i = 0;
        vm.prank(accounts[i]);
        dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));

        vm.expectRevert(DustSwapRewardDistributor.AlreadyClaimed.selector);
        vm.prank(accounts[i]);
        dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));
    }

    function test_claim_revertsOnInflatedAmount() public {
        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        dist.claim(indexes[0], accounts[0], amounts[0] + 1, _proof(0));
    }

    function test_claim_revertsOnSubstitutedAccount() public {
        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        dist.claim(indexes[0], address(0xDEAD), amounts[0], _proof(0));
    }

    function test_claim_revertsOnEmptyProof() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        dist.claim(indexes[0], accounts[0], amounts[0], empty);
    }

    function test_claim_succeedsOnTheDeadlineSecond() public {
        vm.warp(deadline);
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
        assertEq(usdc.balanceOf(accounts[0]), amounts[0]);
    }

    function test_claim_revertsOneSecondAfterDeadline() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(DustSwapRewardDistributor.ClaimWindowClosed.selector);
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
    }

    /// @dev The dual-wallet case: one DustSwap account, two linked addresses, one index. Either
    ///      address may claim, and the account is paid exactly once.
    function test_claim_dualWalletEitherAddressButOnlyOnce() public {
        uint256 a = 3; // address 0x1004
        uint256 b = 4; // address 0x1005, same index

        assertEq(indexes[a], indexes[b], "fixture must share an index");

        vm.prank(accounts[b]);
        dist.claim(indexes[b], accounts[b], amounts[b], _proof(b));
        assertEq(usdc.balanceOf(accounts[b]), amounts[b]);

        vm.expectRevert(DustSwapRewardDistributor.AlreadyClaimed.selector);
        vm.prank(accounts[a]);
        dist.claim(indexes[a], accounts[a], amounts[a], _proof(a));

        assertEq(usdc.balanceOf(accounts[a]), 0, "sibling wallet must not be paid twice");
        assertEq(dist.claimCount(), 1);
    }

    function test_claim_everyLeafDrainsExactlyTheAllocation() public {
        bool[] memory done = new bool[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            if (dist.isClaimed(indexes[i])) continue;
            dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));
            done[i] = true;
        }
        assertEq(dist.totalClaimed(), totalAllocation);
        assertEq(usdc.balanceOf(address(dist)), 0, "contract fully drained");
        assertEq(dist.outstandingAllocation(), 0);
    }

    // ------------------------------------------------------------------------------------------
    // Eligibility check
    // ------------------------------------------------------------------------------------------

    function test_checkEligibility_emitsTrueForValidProof() public {
        uint256 i = 0;
        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(accounts[i], true, amounts[i], false);

        vm.prank(accounts[i]);
        dist.checkEligibility(indexes[i], amounts[i], _proof(i));
    }

    function test_checkEligibility_reportsAlreadyClaimed() public {
        uint256 i = 0;
        vm.prank(accounts[i]);
        dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));

        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(accounts[i], true, amounts[i], true);

        vm.prank(accounts[i]);
        dist.checkEligibility(indexes[i], amounts[i], _proof(i));
    }

    function test_checkEligibility_emitsFalseForSomeoneElsesProof() public {
        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(address(0xDEAD), false, 0, false);

        vm.prank(address(0xDEAD));
        dist.checkEligibility(indexes[0], amounts[0], _proof(0));
    }

    function test_checkEligibility_noArgEmitsFalse() public {
        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(address(0xDEAD), false, 0, false);

        vm.prank(address(0xDEAD));
        dist.checkEligibility();
    }

    function test_checkEligibility_writesNoStorage() public {
        vm.prank(accounts[0]);
        dist.checkEligibility(indexes[0], amounts[0], _proof(0));

        assertFalse(dist.isClaimed(indexes[0]));
        assertEq(dist.totalClaimed(), 0);
        assertEq(dist.claimCount(), 0);
    }

    // ------------------------------------------------------------------------------------------
    // Builder-code suffix. These are the tests that matter for the app integration: every DustSwap
    // transaction appends the ERC-8021 attribution suffix, so every entry point must tolerate it.
    // ------------------------------------------------------------------------------------------

    function test_suffix_doesNotCollideWithAnySelector() public pure {
        bytes4 head = bytes4(BUILDER_SUFFIX);
        assertTrue(head != DustSwapRewardDistributor.claim.selector, "claim");
        assertTrue(head != bytes4(keccak256("checkEligibility(uint256,uint256,bytes32[])")), "checkEligibility/3");
        assertTrue(head != bytes4(keccak256("checkEligibility()")), "checkEligibility/0");
        assertTrue(head != DustSwapRewardDistributor.sweep.selector, "sweep");
        assertTrue(head != DustSwapRewardDistributor.rescueToken.selector, "rescueToken");
        assertTrue(head != DustSwapRewardDistributor.verify.selector, "verify");
        assertTrue(head != DustSwapRewardDistributor.isClaimed.selector, "isClaimed");
        assertTrue(head != DustSwapRewardDistributor.leaf.selector, "leaf");
    }

    function test_suffix_claimDecodesCorrectlyWithSuffixAppended() public {
        uint256 i = 2; // the largest allocation, and a multi-node proof
        bytes memory data = abi.encodePacked(
            abi.encodeCall(DustSwapRewardDistributor.claim, (indexes[i], accounts[i], amounts[i], _proof(i))),
            BUILDER_SUFFIX
        );

        vm.prank(accounts[i]);
        (bool ok,) = address(dist).call(data);

        assertTrue(ok, "claim with builder suffix must succeed");
        assertEq(usdc.balanceOf(accounts[i]), amounts[i], "suffix must not corrupt the decoded amount");
        assertTrue(dist.isClaimed(indexes[i]));
    }

    function test_suffix_checkEligibilityDecodesCorrectlyWithSuffixAppended() public {
        uint256 i = 0;
        bytes memory data = abi.encodePacked(
            abi.encodeWithSignature(
                "checkEligibility(uint256,uint256,bytes32[])", indexes[i], amounts[i], _proof(i)
            ),
            BUILDER_SUFFIX
        );

        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(accounts[i], true, amounts[i], false);

        vm.prank(accounts[i]);
        (bool ok,) = address(dist).call(data);
        assertTrue(ok, "check with builder suffix must succeed");
    }

    function test_suffix_noArgCheckWithSuffixAppended() public {
        bytes memory data = abi.encodePacked(abi.encodeWithSignature("checkEligibility()"), BUILDER_SUFFIX);

        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(address(0xDEAD), false, 0, false);

        vm.prank(address(0xDEAD));
        (bool ok,) = address(dist).call(data);
        assertTrue(ok);
    }

    /// @dev A wallet that sends a bare transaction carrying only the suffix, with no selector,
    ///      still gets a recorded answer instead of a failed transaction.
    function test_fallback_suffixOnlyCalldataRecordsNegativeCheck() public {
        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(address(0xDEAD), false, 0, false);

        vm.prank(address(0xDEAD));
        (bool ok,) = address(dist).call(BUILDER_SUFFIX);
        assertTrue(ok);
    }

    function test_fallback_emptyCalldataRecordsNegativeCheck() public {
        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.EligibilityChecked(address(0xDEAD), false, 0, false);

        vm.prank(address(0xDEAD));
        (bool ok,) = address(dist).call("");
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------
    // ETH must never be accepted
    // ------------------------------------------------------------------------------------------

    function test_eth_plainTransferReverts() public {
        vm.deal(address(0xDEAD), 1 ether);
        vm.prank(address(0xDEAD));
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertFalse(ok, "contract must not accept ETH");
        assertEq(address(dist).balance, 0);
    }

    function test_eth_checkWithValueReverts() public {
        vm.deal(address(0xDEAD), 1 ether);
        bytes memory data = abi.encodeWithSignature("checkEligibility()");
        vm.prank(address(0xDEAD));
        (bool ok,) = address(dist).call{value: 1 ether}(data);
        assertFalse(ok, "checkEligibility must not be payable");
        assertEq(address(dist).balance, 0);
    }

    function test_eth_claimWithValueReverts() public {
        vm.deal(accounts[0], 1 ether);
        bytes memory data =
            abi.encodeCall(DustSwapRewardDistributor.claim, (indexes[0], accounts[0], amounts[0], _proof(0)));
        vm.prank(accounts[0]);
        (bool ok,) = address(dist).call{value: 1 ether}(data);
        assertFalse(ok, "claim must not be payable");
    }

    // ------------------------------------------------------------------------------------------
    // Sweep
    // ------------------------------------------------------------------------------------------

    function test_sweep_revertsWhileClaimWindowIsOpen() public {
        vm.expectRevert(DustSwapRewardDistributor.ClaimWindowStillOpen.selector);
        vm.prank(owner);
        dist.sweep(treasury);
    }

    function test_sweep_revertsOnTheDeadlineSecond() public {
        vm.warp(deadline);
        vm.expectRevert(DustSwapRewardDistributor.ClaimWindowStillOpen.selector);
        vm.prank(owner);
        dist.sweep(treasury);
    }

    function test_sweep_succeedsOneSecondAfterDeadline() public {
        vm.warp(uint256(deadline) + 1);

        vm.expectEmit(true, false, false, true, address(dist));
        emit DustSwapRewardDistributor.Swept(treasury, totalAllocation);

        vm.prank(owner);
        dist.sweep(treasury);

        assertEq(usdc.balanceOf(treasury), totalAllocation);
        assertEq(usdc.balanceOf(address(dist)), 0);
    }

    function test_sweep_onlyTakesWhatIsLeftAfterClaims() public {
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
        vm.warp(uint256(deadline) + 1);

        vm.prank(owner);
        dist.sweep(treasury);

        assertEq(usdc.balanceOf(treasury), totalAllocation - amounts[0]);
    }

    function test_sweep_revertsForNonOwner() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xDEAD)));
        vm.prank(address(0xDEAD));
        dist.sweep(treasury);
    }

    function test_sweep_revertsOnZeroRecipient() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(DustSwapRewardDistributor.ZeroAddress.selector);
        vm.prank(owner);
        dist.sweep(address(0));
    }

    function test_sweep_revertsWhenNothingLeft() public {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (dist.isClaimed(indexes[i])) continue;
            dist.claim(indexes[i], accounts[i], amounts[i], _proof(i));
        }
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(DustSwapRewardDistributor.NothingToSweep.selector);
        vm.prank(owner);
        dist.sweep(treasury);
    }

    // ------------------------------------------------------------------------------------------
    // Rescue
    // ------------------------------------------------------------------------------------------

    function test_rescue_cannotTouchTheDistributionToken() public {
        vm.expectRevert(DustSwapRewardDistributor.CannotRescueDistributionToken.selector);
        vm.prank(owner);
        dist.rescueToken(address(usdc), treasury);
    }

    function test_rescue_cannotTouchTheDistributionTokenEvenAfterDeadline() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(DustSwapRewardDistributor.CannotRescueDistributionToken.selector);
        vm.prank(owner);
        dist.rescueToken(address(usdc), treasury);
    }

    function test_rescue_recoversAForeignToken() public {
        other.mint(address(dist), 5_000000);
        vm.prank(owner);
        dist.rescueToken(address(other), treasury);
        assertEq(other.balanceOf(treasury), 5_000000);
        assertEq(usdc.balanceOf(address(dist)), totalAllocation, "distribution balance untouched");
    }

    function test_rescue_revertsForNonOwner() public {
        other.mint(address(dist), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xDEAD)));
        vm.prank(address(0xDEAD));
        dist.rescueToken(address(other), treasury);
    }

    // ------------------------------------------------------------------------------------------
    // Funding
    // ------------------------------------------------------------------------------------------

    function test_isFullyFunded_falseWhenUnderfunded() public {
        DustSwapRewardDistributor bare =
            new DustSwapRewardDistributor(address(usdc), root, totalAllocation, deadline, owner);
        assertFalse(bare.isFullyFunded());
        usdc.mint(address(bare), totalAllocation - 1);
        assertFalse(bare.isFullyFunded());
        usdc.mint(address(bare), 1);
        assertTrue(bare.isFullyFunded());
    }

    function test_isFullyFunded_staysTrueAsClaimsDrainTheBalance() public {
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
        assertTrue(dist.isFullyFunded(), "claimed funds still count toward the allocation");
    }

    // ------------------------------------------------------------------------------------------
    // Ownership
    // ------------------------------------------------------------------------------------------

    function test_ownership_isTwoStep() public {
        vm.prank(owner);
        dist.transferOwnership(treasury);
        assertEq(dist.owner(), owner, "ownership must not move until accepted");

        vm.prank(treasury);
        dist.acceptOwnership();
        assertEq(dist.owner(), treasury);
    }

    // ------------------------------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------------------------------

    function testFuzz_verifyRejectsArbitraryTampering(uint256 index, address account, uint256 amount) public view {
        vm.assume(index != indexes[0] || account != accounts[0] || amount != amounts[0]);
        assertFalse(dist.verify(index, account, amount, _proof(0)));
    }

    function testFuzz_claimRejectsArbitraryProof(bytes32 a, bytes32 b) public {
        bytes32[] memory bogus = new bytes32[](2);
        bogus[0] = a;
        bogus[1] = b;
        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        dist.claim(indexes[0], accounts[0], amounts[0], bogus);
    }

    /// @dev Builds a fresh tree of `n` leaves and claims every one of them, to confirm the
    ///      construction and proof generation hold at sizes comparable to the real distribution.
    function testFuzz_wholeTreeClaimsCleanly(uint8 rawCount) public {
        uint256 n = uint256(rawCount) % 60 + 1;

        delete accounts;
        delete indexes;
        delete amounts;

        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            uint256 amt = (i + 1) * 1_000000;
            _push(i, address(uint160(0x2000 + i)), amt);
            total += amt;
        }

        bytes32 freshRoot = _buildRoot();
        DustSwapRewardDistributor d =
            new DustSwapRewardDistributor(address(usdc), freshRoot, total, uint64(block.timestamp + 30 days), owner);
        usdc.mint(address(d), total);

        for (uint256 i = 0; i < n; i++) {
            d.claim(indexes[i], accounts[i], amounts[i], _proof(i));
            assertEq(usdc.balanceOf(accounts[i]), amounts[i]);
        }

        assertEq(d.totalClaimed(), total);
        assertEq(d.claimCount(), n);
        assertEq(usdc.balanceOf(address(d)), 0);
    }

    // ------------------------------------------------------------------------------------------
    // Merkle helpers, mirroring script/buildAllocation.ts
    // ------------------------------------------------------------------------------------------

    function _push(uint256 index, address account, uint256 amount) internal {
        indexes.push(index);
        accounts.push(account);
        amounts.push(amount);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Hashes every entry, sorts ascending, and stores the result in `leaves`.
    function _buildRoot() internal returns (bytes32) {
        uint256 n = accounts.length;
        bytes32[] memory l = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            l[i] = keccak256(bytes.concat(keccak256(abi.encode(indexes[i], accounts[i], amounts[i]))));
        }
        // Insertion sort. n is small in tests and this mirrors the script's ascending order.
        for (uint256 i = 1; i < n; i++) {
            bytes32 key = l[i];
            uint256 j = i;
            while (j > 0 && l[j - 1] > key) {
                l[j] = l[j - 1];
                j--;
            }
            l[j] = key;
        }

        delete leaves;
        for (uint256 i = 0; i < n; i++) {
            leaves.push(l[i]);
        }

        bytes32[] memory level = l;
        while (level.length > 1) {
            uint256 next = (level.length + 1) / 2;
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i = 0; i < next; i++) {
                uint256 li = i * 2;
                // An odd trailing node is promoted unchanged rather than hashed with itself.
                parents[i] = (li + 1 < level.length) ? _hashPair(level[li], level[li + 1]) : level[li];
            }
            level = parents;
        }
        return level[0];
    }

    /// @dev Position of entry `entryIndex` inside the sorted `leaves` array.
    function _sortedPos(uint256 entryIndex) internal view returns (uint256) {
        bytes32 target =
            keccak256(bytes.concat(keccak256(abi.encode(indexes[entryIndex], accounts[entryIndex], amounts[entryIndex]))));
        for (uint256 i = 0; i < leaves.length; i++) {
            if (leaves[i] == target) return i;
        }
        revert("leaf not found");
    }

    function _proof(uint256 entryIndex) internal view returns (bytes32[] memory) {
        uint256 pos = _sortedPos(entryIndex);

        bytes32[] memory level = new bytes32[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            level[i] = leaves[i];
        }

        bytes32[] memory scratch = new bytes32[](64);
        uint256 depth;

        while (level.length > 1) {
            uint256 sibling = pos ^ 1;
            if (sibling < level.length) {
                scratch[depth++] = level[sibling];
            }

            uint256 next = (level.length + 1) / 2;
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i = 0; i < next; i++) {
                uint256 li = i * 2;
                parents[i] = (li + 1 < level.length) ? _hashPair(level[li], level[li + 1]) : level[li];
            }
            level = parents;
            pos = pos / 2;
        }

        bytes32[] memory proof = new bytes32[](depth);
        for (uint256 i = 0; i < depth; i++) {
            proof[i] = scratch[i];
        }
        return proof;
    }
}
