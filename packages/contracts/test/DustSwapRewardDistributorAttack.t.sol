// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DustSwapRewardDistributor} from "../src/DustSwapRewardDistributor.sol";

/// @dev Token whose transfer re-enters the distributor, to prove checks-effects-interactions
///      holds without a reentrancy guard.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    DustSwapRewardDistributor public target;

    uint256 public reentryIndex;
    address public reentryAccount;
    uint256 public reentryAmount;
    bytes32[] public reentryProof;

    bool public reentered;
    bool public reentryReverted;

    function setTarget(DustSwapRewardDistributor t) external {
        target = t;
    }

    function arm(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        reentryIndex = index;
        reentryAccount = account;
        reentryAmount = amount;
        reentryProof = proof;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        if (address(target) != address(0) && !reentered && reentryProof.length > 0) {
            reentered = true;
            try target.claim(reentryIndex, reentryAccount, reentryAmount, reentryProof) {
                reentryReverted = false;
            } catch {
                reentryReverted = true;
            }
        }
        return true;
    }
}

/// @dev Takes a fee on every transfer. USDC does not, but the distributor should be understood
///      against one so nobody later swaps the token for something exotic.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    uint256 public feeBps = 100;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Force-feeds ETH. A contract cannot refuse this, payable or not.
contract EthForcer {
    constructor() payable {}

    function boom(address payable victim) external {
        selfdestruct(victim);
    }
}

contract DustSwapRewardDistributorAttackTest is Test {
    MockUSDC internal usdc;
    DustSwapRewardDistributor internal dist;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0x7EA5);
    address internal attacker = address(0xBAD);

    address[] internal accounts;
    uint256[] internal indexes;
    uint256[] internal amounts;
    bytes32[] internal leaves;
    bytes32 internal root;
    uint64 internal deadline;
    uint256 internal total;

    function setUp() public {
        usdc = new MockUSDC();

        _push(0, address(0x1001), 100_000000);
        _push(1, address(0x1002), 50_000000);
        _push(2, address(0x1003), 25_000000);
        _push(2, address(0x1004), 25_000000); // same account, second linked wallet
        _push(3, address(0x1005), 10_000000);

        total = 100_000000 + 50_000000 + 25_000000 + 10_000000;
        root = _buildRoot();
        deadline = uint64(block.timestamp + 90 days);

        dist = new DustSwapRewardDistributor(address(usdc), root, total, deadline, owner);
        usdc.mint(address(dist), total);
    }

    // ------------------------------------------------------------------------------------------
    // Double claim
    // ------------------------------------------------------------------------------------------

    function test_attack_reentrantTokenCannotDoubleClaim() public {
        ReentrantToken evil = new ReentrantToken();
        DustSwapRewardDistributor d =
            new DustSwapRewardDistributor(address(evil), root, total, deadline, owner);
        evil.setTarget(d);
        evil.mint(address(d), total);

        bytes32[] memory proof = _proof(0);
        evil.arm(indexes[0], accounts[0], amounts[0], proof);

        d.claim(indexes[0], accounts[0], amounts[0], proof);

        assertTrue(evil.reentered(), "the token did re-enter");
        assertTrue(evil.reentryReverted(), "re-entrant claim must revert");
        assertEq(evil.balanceOf(accounts[0]), amounts[0], "paid exactly once");
        assertEq(d.totalClaimed(), amounts[0]);
        assertEq(d.claimCount(), 1);
    }

    function test_attack_secondWalletOfSameAccountCannotClaimAgain() public {
        vm.prank(accounts[2]);
        dist.claim(indexes[2], accounts[2], amounts[2], _proof(2));

        vm.expectRevert(DustSwapRewardDistributor.AlreadyClaimed.selector);
        vm.prank(accounts[3]);
        dist.claim(indexes[3], accounts[3], amounts[3], _proof(3));

        assertEq(usdc.balanceOf(accounts[3]), 0);
        assertEq(dist.totalClaimed(), amounts[2], "one account, one payout");
    }

    function test_attack_cannotClaimTwiceInOneTransaction() public {
        bytes32[] memory p = _proof(0);
        dist.claim(indexes[0], accounts[0], amounts[0], p);
        vm.expectRevert(DustSwapRewardDistributor.AlreadyClaimed.selector);
        dist.claim(indexes[0], accounts[0], amounts[0], p);
    }

    // ------------------------------------------------------------------------------------------
    // Proof forgery
    // ------------------------------------------------------------------------------------------

    function test_attack_proofFromAnotherTreeIsRejected() public {
        // A second, attacker-controlled tree that pays them the whole pot.
        delete accounts;
        delete indexes;
        delete amounts;
        _push(0, attacker, total);
        bytes32 evilRoot = _buildRoot();
        assertTrue(evilRoot != root, "distinct trees");

        bytes32[] memory evilProof = _proof(0);

        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        vm.prank(attacker);
        dist.claim(0, attacker, total, evilProof);

        assertEq(usdc.balanceOf(address(dist)), total, "nothing left the contract");
    }

    function test_attack_cannotSwapAmountBetweenValidLeaves() public {
        // Valid proof for leaf 1, but asking for leaf 0's larger amount.
        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        dist.claim(indexes[1], accounts[1], amounts[0], _proof(1));
    }

    function test_attack_cannotReuseAnotherAccountsProofForYourself() public {
        vm.expectRevert(DustSwapRewardDistributor.InvalidProof.selector);
        vm.prank(attacker);
        dist.claim(indexes[0], attacker, amounts[0], _proof(0));
    }

    /// @dev The tree promotes an odd trailing node unchanged, so the same hash appears at two
    ///      levels. Double-hashed leaves are what stop that node being replayed as a leaf.
    function test_attack_promotedInternalNodeCannotBeReplayedAsLeaf() public view {
        bytes32[] memory p0 = _proof(0);
        bytes32 parent = _hashPair(leaves[_sortedPos(0)], p0[0]);

        bytes32[] memory empty = new bytes32[](0);
        assertFalse(dist.verify(uint256(parent), address(0), 0, empty));

        bytes32[] memory one = new bytes32[](1);
        one[0] = p0.length > 1 ? p0[1] : bytes32(0);
        assertFalse(dist.verify(uint256(parent), attacker, total, one));
    }

    function testFuzz_attack_randomProofNeverPays(
        uint256 index,
        address account,
        uint256 amount,
        bytes32 a,
        bytes32 b,
        bytes32 c
    ) public {
        bytes32[] memory bogus = new bytes32[](3);
        bogus[0] = a;
        bogus[1] = b;
        bogus[2] = c;

        uint256 before = usdc.balanceOf(address(dist));
        try dist.claim(index, account, amount, bogus) {
            // Only acceptable if the fuzzer stumbled onto a genuine leaf, which it will not.
            assertTrue(false, "forged proof paid out");
        } catch {
            assertEq(usdc.balanceOf(address(dist)), before);
        }
    }

    // ------------------------------------------------------------------------------------------
    // Owner and custody
    // ------------------------------------------------------------------------------------------

    function test_attack_ownerCannotTakeFundsBeforeDeadline() public {
        vm.startPrank(owner);

        vm.expectRevert(DustSwapRewardDistributor.ClaimWindowStillOpen.selector);
        dist.sweep(owner);

        vm.expectRevert(DustSwapRewardDistributor.CannotRescueDistributionToken.selector);
        dist.rescueToken(address(usdc), owner);

        vm.stopPrank();
        assertEq(usdc.balanceOf(address(dist)), total, "balance untouched");
    }

    function test_attack_ownerCannotTakeFundsOneSecondBeforeDeadline() public {
        vm.warp(uint256(deadline));
        vm.expectRevert(DustSwapRewardDistributor.ClaimWindowStillOpen.selector);
        vm.prank(owner);
        dist.sweep(owner);
    }

    function test_attack_nonOwnerCannotSweepEverAfterDeadline() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        dist.sweep(attacker);
    }

    function test_custody_ownerSweepsExactlyTheRemainderAfterThreeMonths() public {
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));

        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        dist.sweep(treasury);

        assertEq(usdc.balanceOf(treasury), total - amounts[0]);
        assertEq(usdc.balanceOf(address(dist)), 0);
    }

    function test_attack_claimIsDeadAfterTheWindowEvenForValidProofs() public {
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(DustSwapRewardDistributor.ClaimWindowClosed.selector);
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
    }

    /// @notice Regression for the fix: renouncing ownership would have frozen every unclaimed
    ///         dollar, because only the owner can sweep. It is now disabled outright.
    function test_fixed_renounceOwnershipIsDisabled() public {
        vm.expectRevert(DustSwapRewardDistributor.OwnershipCannotBeRenounced.selector);
        vm.prank(owner);
        dist.renounceOwnership();

        assertEq(dist.owner(), owner, "owner unchanged");

        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        dist.sweep(treasury);
        assertEq(usdc.balanceOf(treasury), total, "sweep still reachable");
    }

    function test_fixed_renounceOwnershipRejectsNonOwnerToo() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        dist.renounceOwnership();
    }

    // ------------------------------------------------------------------------------------------
    // ETH handling
    // ------------------------------------------------------------------------------------------

    function test_eth_directSendReverts() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(dist).balance, 0);
    }

    /// @notice Regression for the fix: force-fed ETH used to be unrecoverable. `rescueEth` now
    ///         gets it out, and is not gated on the deadline because ETH is never claim funds.
    function test_fixed_forceFedEthCanBeRescued() public {
        EthForcer forcer = new EthForcer{value: 1 ether}();
        forcer.boom(payable(address(dist)));

        assertEq(address(dist).balance, 1 ether, "ETH arrives despite no payable function");

        uint256 before = treasury.balance;
        vm.prank(owner);
        dist.rescueEth(treasury);

        assertEq(address(dist).balance, 0, "recovered");
        assertEq(treasury.balance - before, 1 ether);
        assertEq(usdc.balanceOf(address(dist)), total, "distribution balance untouched");
    }

    function test_fixed_rescueEthIsOwnerOnlyAndRejectsZeroCases() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        dist.rescueEth(attacker);

        vm.expectRevert(DustSwapRewardDistributor.NothingToSweep.selector);
        vm.prank(owner);
        dist.rescueEth(treasury);

        vm.expectRevert(DustSwapRewardDistributor.ZeroAddress.selector);
        vm.prank(owner);
        dist.rescueEth(address(0));
    }

    function test_eth_forceFedEthDoesNotBreakClaiming() public {
        EthForcer forcer = new EthForcer{value: 1 ether}();
        forcer.boom(payable(address(dist)));

        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
        assertEq(usdc.balanceOf(accounts[0]), amounts[0], "claims still work");
    }

    // ------------------------------------------------------------------------------------------
    // Token assumptions
    // ------------------------------------------------------------------------------------------

    /// @notice A fee-on-transfer token would under-deliver and eventually strand the last claim.
    ///         USDC is not one; this documents why the token choice is load-bearing.
    function test_finding_feeOnTransferTokenWouldUnderpayClaimants() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        DustSwapRewardDistributor d =
            new DustSwapRewardDistributor(address(fot), root, total, deadline, owner);
        fot.mint(address(d), total);

        d.claim(indexes[0], accounts[0], amounts[0], _proof(0));

        assertLt(fot.balanceOf(accounts[0]), amounts[0], "claimant received less than the leaf");
        assertEq(d.totalClaimed(), amounts[0], "accounting still says full amount");
    }

    // ------------------------------------------------------------------------------------------
    // Griefing
    // ------------------------------------------------------------------------------------------

    function test_griefing_thirdPartyClaimStillPaysTheRightAddress() public {
        vm.prank(attacker);
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));

        assertEq(usdc.balanceOf(accounts[0]), amounts[0], "funds go to the leaf address");
        assertEq(usdc.balanceOf(attacker), 0, "attacker gains nothing");
    }

    function test_griefing_checkEligibilityCannotBeUsedToBlockAnyone() public {
        vm.prank(attacker);
        dist.checkEligibility(indexes[0], amounts[0], _proof(0));

        assertFalse(dist.isClaimed(indexes[0]), "checking writes no storage");

        vm.prank(accounts[0]);
        dist.claim(indexes[0], accounts[0], amounts[0], _proof(0));
        assertEq(usdc.balanceOf(accounts[0]), amounts[0]);
    }

    // ------------------------------------------------------------------------------------------
    // Funding
    // ------------------------------------------------------------------------------------------

    /// @notice The constructor cannot check that totalAllocation equals the sum of the tree. If it
    ///         is understated, isFullyFunded lies and the last claimants revert on transfer.
    function test_finding_understatedTotalAllocationMakesIsFullyFundedLie() public {
        DustSwapRewardDistributor d =
            new DustSwapRewardDistributor(address(usdc), root, 1, deadline, owner);
        usdc.mint(address(d), 1);

        assertTrue(d.isFullyFunded(), "claims to be funded on 1 base unit");

        vm.expectRevert(); // arithmetic underflow inside the token
        d.claim(indexes[0], accounts[0], amounts[0], _proof(0));
    }

    // ------------------------------------------------------------------------------------------
    // Merkle helpers, mirroring script/buildClaimAllocation.ts
    // ------------------------------------------------------------------------------------------

    function _push(uint256 index, address account, uint256 amount) internal {
        indexes.push(index);
        accounts.push(account);
        amounts.push(amount);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _buildRoot() internal returns (bytes32) {
        uint256 n = accounts.length;
        bytes32[] memory l = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            l[i] = keccak256(bytes.concat(keccak256(abi.encode(indexes[i], accounts[i], amounts[i]))));
        }
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
                parents[i] = (li + 1 < level.length) ? _hashPair(level[li], level[li + 1]) : level[li];
            }
            level = parents;
        }
        return level[0];
    }

    function _sortedPos(uint256 entryIndex) internal view returns (uint256) {
        bytes32 target = keccak256(
            bytes.concat(keccak256(abi.encode(indexes[entryIndex], accounts[entryIndex], amounts[entryIndex])))
        );
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
            if (sibling < level.length) scratch[depth++] = level[sibling];

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
