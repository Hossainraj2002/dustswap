// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemeFunLaunchRewards} from "../../src/MemeFunLaunchRewards.sol";
import {DeployLaunchRewardsDryRun} from "../../script/DeployLaunchRewardsDryRun.s.sol";
import {DeployLaunchRewards} from "../../script/DeployLaunchRewards.s.sol";
import {TestToken, StubModule} from "../utils/TestTokens.sol";

contract RewardTestToken is TestToken {
    bool public chargeFee;
    bool public failTransfer;
    bool public noReturn;

    constructor() TestToken("Campaign reward", "REWARD", 6) {}

    function configure(bool fee_, bool fail_, bool noReturn_) external {
        chargeFee = fee_;
        failTransfer = fail_;
        noReturn = noReturn_;
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failTransfer) return false;
        if (chargeFee) {
            _transfer(msg.sender, to, amount - 1);
            _burn(msg.sender, 1);
        } else {
            _transfer(msg.sender, to, amount);
        }
        if (noReturn) assembly ("memory-safe") { return(0, 0) }
        return true;
    }
}

contract CampaignClaimWallet {
    function collect(
        MemeFunLaunchRewards campaign,
        MemeFunLaunchRewards.Claim calldata a,
        bytes calldata signature
    )
        external
    {
        campaign.claim(a.wallet, a.slot, a.coin, a.launchBlock, a.tradeBlock, a.deadline, signature);
    }
}

contract LaunchRewardsDryRunHarness is DeployLaunchRewardsDryRun {
    function check(uint256 chainId, bool broadcasting) external pure {
        _checkRunSafety(chainId, broadcasting);
    }
}

contract LaunchRewardsDeploymentHarness is DeployLaunchRewards {
    function check(
        uint256 chainId,
        bool broadcasting,
        bool confirmed,
        address deployer
    )
        external
        pure
    {
        _checkRunSafety(chainId, broadcasting, confirmed, deployer);
    }

    function initCode(Configuration memory c) external pure returns (bytes memory) {
        return _attributedInitCode(c);
    }

    function deploy(Configuration memory c) external returns (MemeFunLaunchRewards) {
        return _deploy(c);
    }
}

contract LaunchRewardsTest is Test {
    uint256 private constant SIGNER_KEY = 0xC0FFEE;
    uint256 private constant REWARD = 123_456_789;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(address wallet,uint16 slot,address coin,uint256 launchBlock,uint256 tradeBlock,uint256 deadline)"
    );
    address private owner = address(0xA11CE);
    address private alice = address(0xA);
    address private bob = address(0xB);
    address private coin = address(0xC01);
    RewardTestToken private token;
    address private factory;
    MemeFunLaunchRewards private campaign;

    function setUp() public {
        vm.roll(100);
        vm.warp(1_800_000_000);
        token = new RewardTestToken();
        factory = address(new StubModule());
        campaign = _deploy(token, 6, REWARD);
        token.mint(address(campaign), REWARD * 1000);
        vm.prank(owner);
        campaign.activate();
        vm.roll(105);
    }

    function _deploy(
        IERC20 token_,
        uint8 decimals_,
        uint256 reward_
    )
        private
        returns (MemeFunLaunchRewards)
    {
        return
            new MemeFunLaunchRewards(
                owner, token_, decimals_, reward_, vm.addr(SIGNER_KEY), factory
            );
    }

    function _allocation(
        address wallet,
        uint16 slot
    )
        private
        view
        returns (MemeFunLaunchRewards.Claim memory)
    {
        return MemeFunLaunchRewards.Claim(wallet, slot, coin, 101, 0, block.timestamp + 1 hours);
    }

    function _signature(
        MemeFunLaunchRewards.Claim memory a,
        uint256 chainId,
        address verifyingContract
    )
        private
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("MemeFunLaunchRewards"),
                keccak256("1"),
                chainId,
                verifyingContract
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH, a.wallet, a.slot, a.coin, a.launchBlock, a.tradeBlock, a.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _claim(MemeFunLaunchRewards.Claim memory a) private {
        bytes memory signature = _signature(a, block.chainid, address(campaign));
        vm.prank(a.wallet);
        _call(a, signature);
    }

    function _call(MemeFunLaunchRewards.Claim memory a, bytes memory signature) private {
        campaign.claim(a.wallet, a.slot, a.coin, a.launchBlock, a.tradeBlock, a.deadline, signature);
    }

    function test_activationRequiresAll1000RewardsAndOwner() public {
        MemeFunLaunchRewards fresh = _deploy(token, 6, REWARD);
        token.mint(address(fresh), REWARD * 1000 - 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                MemeFunLaunchRewards.InsufficientFunding.selector, REWARD * 1000 - 1, REWARD * 1000
            )
        );
        fresh.activate();
        token.mint(address(fresh), 1);
        vm.prank(bob);
        vm.expectRevert();
        fresh.activate();
        vm.prank(owner);
        fresh.activate();
        assertTrue(fresh.activated());
        assertEq(fresh.startBlock(), block.number);
        vm.prank(owner);
        vm.expectRevert(MemeFunLaunchRewards.AlreadyActivated.selector);
        fresh.activate();
    }

    function test_constructorRejectsZeroOverflowAndWrongDecimals() public {
        vm.expectRevert(MemeFunLaunchRewards.InvalidConfiguration.selector);
        _deploy(token, 6, 0);
        vm.expectRevert(MemeFunLaunchRewards.InvalidConfiguration.selector);
        _deploy(token, 6, type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                MemeFunLaunchRewards.WrongTokenDecimals.selector, uint8(18), uint8(6)
            )
        );
        _deploy(token, 18, REWARD);
        vm.expectRevert(MemeFunLaunchRewards.InvalidConfiguration.selector);
        new MemeFunLaunchRewards(owner, token, 6, REWARD, address(0), factory);
        vm.expectRevert(MemeFunLaunchRewards.InvalidConfiguration.selector);
        new MemeFunLaunchRewards(owner, token, 6, REWARD, vm.addr(SIGNER_KEY), address(0));
    }

    function test_claimPaysExactFixedRewardAndPreservesReserve() public {
        token.mint(alice, 17);
        token.mint(address(campaign), 23);
        _claim(_allocation(alice, 0));
        assertEq(token.balanceOf(alice), REWARD + 17);
        assertEq(token.balanceOf(address(campaign)), REWARD * 999 + 23);
        assertEq(campaign.remainingReserve(), REWARD * 999);
        assertEq(campaign.claimedCount(), 1);
        assertTrue(campaign.claimed(alice));
        assertTrue(campaign.slotClaimed(0));
    }

    function test_frontRunnerCannotConsumeAnotherWalletTicket() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        bytes memory signature = _signature(a, block.chainid, address(campaign));
        vm.prank(bob);
        vm.expectRevert(MemeFunLaunchRewards.WrongWallet.selector);
        _call(a, signature);
        assertFalse(campaign.slotClaimed(0));
        assertFalse(campaign.claimed(alice));
        vm.prank(alice);
        _call(a, signature);
    }

    function test_oneClaimPerWalletAcrossDifferentCoinsAndSlots() public {
        _claim(_allocation(alice, 0));
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 1);
        a.coin = address(0xC02);
        vm.expectRevert(MemeFunLaunchRewards.WalletAlreadyClaimed.selector);
        _claim(a);
        assertEq(campaign.claimedCount(), 1);
    }

    function test_slotCannotBeReusedByAnotherWallet() public {
        _claim(_allocation(alice, 0));
        vm.expectRevert(MemeFunLaunchRewards.SlotAlreadyClaimed.selector);
        _claim(_allocation(bob, 0));
    }

    function test_replayAcrossCampaignsAndChainsFails() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        bytes memory wrongContract = _signature(a, block.chainid, address(0xBAD));
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, wrongContract);
        bytes memory wrongChain = _signature(a, block.chainid + 1, address(campaign));
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, wrongChain);
        bytes memory valid = _signature(a, block.chainid, address(campaign));
        vm.chainId(block.chainid + 1);
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, valid);
    }

    function test_everySignedFieldIsBound() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        bytes memory signature = _signature(a, block.chainid, address(campaign));
        a.wallet = bob;
        vm.prank(bob);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, signature);
        a.wallet = alice;
        a.slot = 1;
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, signature);
        a.slot = 0;
        a.coin = address(0xC02);
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, signature);
        a.coin = coin;
        a.launchBlock = 102;
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, signature);
        a.launchBlock = 101;
        a.tradeBlock = 103;
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, signature);
        a.tradeBlock = 0;
        a.deadline += 1;
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, signature);
    }

    function test_expiredTicketDoesNotConsumeSlotAndCanBeReissued() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        a.deadline = block.timestamp - 1;
        vm.expectRevert(MemeFunLaunchRewards.Expired.selector);
        _claim(a);
        assertFalse(campaign.claimed(alice));
        assertFalse(campaign.slotClaimed(0));
        _claim(_allocation(alice, 0));
    }

    function test_deadlineBoundaryIsInclusive() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        a.deadline = block.timestamp;
        _claim(a);
    }

    function test_onlyLaunchesStrictlyAfterActivationAndNoFutureEvidence() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        a.launchBlock = 100;
        vm.expectRevert(MemeFunLaunchRewards.InvalidLaunchBlock.selector);
        _claim(a);
        a.launchBlock = 106;
        vm.expectRevert(MemeFunLaunchRewards.InvalidLaunchBlock.selector);
        _claim(a);
        a.launchBlock = 101;
        a.tradeBlock = 106;
        vm.expectRevert(MemeFunLaunchRewards.InvalidTradeBlock.selector);
        _claim(a);
    }

    function test_tradeRuleIsOneWayAndPreservesEarlierLaunchAllocations() public {
        vm.prank(owner);
        campaign.enableTradeRequirement();
        assertEq(campaign.tradeRequiredFromBlock(), 106);
        _claim(_allocation(alice, 0));
        vm.roll(108);
        MemeFunLaunchRewards.Claim memory a = _allocation(bob, 1);
        a.launchBlock = 106;
        vm.expectRevert(MemeFunLaunchRewards.TradeRequired.selector);
        _claim(a);
        a.tradeBlock = 106;
        vm.expectRevert(MemeFunLaunchRewards.TradeRequired.selector);
        _claim(a);
        a.tradeBlock = 107;
        _claim(a);
        vm.prank(owner);
        vm.expectRevert(MemeFunLaunchRewards.TradeRequirementAlreadyEnabled.selector);
        campaign.enableTradeRequirement();
    }

    function test_tradeRuleOwnerAndActivationGates() public {
        vm.prank(bob);
        vm.expectRevert();
        campaign.enableTradeRequirement();
        MemeFunLaunchRewards fresh = _deploy(token, 6, REWARD);
        vm.prank(owner);
        vm.expectRevert(MemeFunLaunchRewards.NotActivated.selector);
        fresh.enableTradeRequirement();
    }

    function test_rejectsUnderfundedReserveBeforeAnyPayout() public {
        token.burn(address(campaign), 1);
        assertFalse(campaign.isEnabled());
        vm.expectRevert(
            abi.encodeWithSelector(
                MemeFunLaunchRewards.InsufficientFunding.selector, REWARD * 1000 - 1, REWARD * 1000
            )
        );
        _claim(_allocation(alice, 0));
        assertEq(token.balanceOf(alice), 0);
        assertEq(campaign.claimedCount(), 0);
    }

    function test_taxedOrFailedTokenTransferCannotConsumeAllocation() public {
        token.configure(true, false, false);
        vm.expectRevert(MemeFunLaunchRewards.InexactTokenTransfer.selector);
        _claim(_allocation(alice, 0));
        assertEq(campaign.claimedCount(), 0);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(address(campaign)), REWARD * 1000);
        token.configure(false, true, false);
        vm.expectRevert();
        _claim(_allocation(alice, 0));
        assertFalse(campaign.claimed(alice));
        assertFalse(campaign.slotClaimed(0));
    }

    function test_standardTokenWithoutReturnValueIsSupported() public {
        token.configure(false, false, true);
        _claim(_allocation(alice, 0));
        assertEq(token.balanceOf(alice), REWARD);
    }

    function test_contractWalletReceivesItsOwnReward() public {
        CampaignClaimWallet wallet = new CampaignClaimWallet();
        MemeFunLaunchRewards.Claim memory a = _allocation(address(wallet), 0);
        wallet.collect(campaign, a, _signature(a, block.chainid, address(campaign)));
        assertEq(token.balanceOf(address(wallet)), REWARD);
    }

    function test_exact1000WalletLimitEvenWithSurplusFunding() public {
        token.mint(address(campaign), REWARD);
        for (uint16 slot; slot < 1000; ++slot) {
            _claim(_allocation(address(uint160(slot) + 1000), slot));
        }
        assertEq(campaign.claimedCount(), 1000);
        assertEq(campaign.remainingReserve(), 0);
        assertEq(token.balanceOf(address(campaign)), REWARD);
        assertFalse(campaign.isEnabled());
        vm.expectRevert(MemeFunLaunchRewards.InvalidAllocation.selector);
        _claim(_allocation(alice, 1000));
    }

    function test_builderSuffixDoesNotChangeClaimOrRecipient() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        bytes memory signature = _signature(a, block.chainid, address(campaign));
        bytes memory callData = abi.encodeCall(
            campaign.claim,
            (a.wallet, a.slot, a.coin, a.launchBlock, a.tradeBlock, a.deadline, signature)
        );
        vm.prank(alice);
        (bool ok,) = address(campaign)
            .call(
                bytes.concat(
                    callData, hex"62635f74706f6c666a686f0b0080218021802180218021802180218021"
                )
            );
        assertTrue(ok);
        assertEq(token.balanceOf(alice), REWARD);
    }

    function test_signatureFormatAndMalleabilityRejected() public {
        MemeFunLaunchRewards.Claim memory a = _allocation(alice, 0);
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, hex"1234");
        bytes memory signature = _signature(a, block.chainid, address(campaign));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        uint256 order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory highS =
            abi.encodePacked(r, bytes32(order - uint256(s)), uint8(v == 27 ? 28 : 27));
        vm.prank(alice);
        vm.expectRevert(MemeFunLaunchRewards.InvalidSignature.selector);
        _call(a, highS);
    }

    function test_dryRunRefusesBroadcastAndUnsupportedChain() public {
        LaunchRewardsDryRunHarness script = new LaunchRewardsDryRunHarness();
        script.check(8453, false);
        script.check(84_532, false);
        script.check(31_337, false);
        vm.expectRevert(bytes("LaunchRewards dry run cannot broadcast"));
        script.check(8453, true);
        vm.expectRevert(bytes("unsupported chain"));
        script.check(1, false);
    }

    function test_futureDeploymentRequiresBaseChainPublicDeployerAndBroadcastOptIn() public {
        LaunchRewardsDeploymentHarness script = new LaunchRewardsDeploymentHarness();
        script.check(8453, false, false, owner);
        script.check(84_532, false, false, owner);
        script.check(8453, true, true, owner);
        script.check(84_532, true, true, owner);
        vm.expectRevert(bytes("launch reward deployment not confirmed"));
        script.check(8453, true, false, owner);
        vm.expectRevert(bytes("invalid deployer"));
        script.check(8453, false, false, address(0));
        vm.expectRevert(bytes("unsupported chain"));
        script.check(31_337, false, false, owner);
        vm.expectRevert(bytes("unsupported chain"));
        script.check(1, true, true, owner);
    }

    function test_attributedCampaignCreationPreservesStaticConstructorAndDeployerNonce() public {
        LaunchRewardsDeploymentHarness script = new LaunchRewardsDeploymentHarness();
        address deployer = makeAddr("campaignPublicDeployer");
        vm.setNonce(deployer, 17);
        DeployLaunchRewards.Configuration memory c = DeployLaunchRewards.Configuration({
            deployer: deployer,
            owner: owner,
            token: token,
            tokenDecimals: 6,
            rewardAmountRaw: REWARD,
            signer: vm.addr(SIGNER_KEY),
            factory: factory
        });
        bytes memory code = script.initCode(c);
        assertEq(
            code,
            bytes.concat(
                type(MemeFunLaunchRewards).creationCode,
                abi.encode(owner, token, uint8(6), REWARD, vm.addr(SIGNER_KEY), factory),
                hex"62635f74706f6c666a686f0b0080218021802180218021802180218021"
            )
        );
        MemeFunLaunchRewards deployed = script.deploy(c);
        assertEq(address(deployed), vm.computeCreateAddress(deployer, 17));
        assertEq(vm.getNonce(deployer), 18);
        assertEq(deployed.owner(), owner);
        assertEq(deployed.pendingOwner(), address(0));
        assertEq(address(deployed.rewardToken()), address(token));
        assertEq(deployed.tokenDecimals(), 6);
        assertEq(deployed.rewardAmountRaw(), REWARD);
        assertEq(deployed.totalAllocation(), REWARD * 1000);
        assertEq(deployed.campaignSigner(), vm.addr(SIGNER_KEY));
        assertEq(deployed.launchFactory(), factory);
        assertEq(deployed.startBlock(), 0);
        assertEq(deployed.tradeRequiredFromBlock(), 0);
        assertEq(deployed.claimedCount(), 0);
        assertEq(deployed.remainingReserve(), REWARD * 1000);
        assertEq(token.balanceOf(address(deployed)), 0);
        assertFalse(deployed.activated());
        assertFalse(deployed.isEnabled());
    }

    function test_futureDeploymentDefaultSimulationReadsOnlyPublicConstructorConfig() public {
        DeployLaunchRewards script = new DeployLaunchRewards();
        address deployer = makeAddr("campaignRunPublicDeployer");
        vm.chainId(8453);
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_DEPLOYER", vm.toString(deployer));
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_OWNER", vm.toString(owner));
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_TOKEN", vm.toString(address(token)));
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_TOKEN_DECIMALS", "6");
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_AMOUNT_RAW", vm.toString(REWARD));
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_SIGNER", vm.toString(vm.addr(SIGNER_KEY)));
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_FACTORY", vm.toString(factory));
        vm.setEnv("MEMEFUN_LAUNCH_REWARD_DEPLOY_CONFIRMED", "false");
        uint64 nonce = vm.getNonce(deployer);
        MemeFunLaunchRewards deployed = script.run();
        assertEq(address(deployed), vm.computeCreateAddress(deployer, nonce));
        assertEq(vm.getNonce(deployer), nonce + 1);
        assertFalse(deployed.activated());
        assertEq(token.balanceOf(address(deployed)), 0);
        assertEq(deployed.owner(), owner);
        assertEq(deployed.rewardAmountRaw(), REWARD);
    }

    function test_futureDeploymentPreservesPreexistingCounterfactualTokenFunding() public {
        LaunchRewardsDeploymentHarness script = new LaunchRewardsDeploymentHarness();
        address deployer = makeAddr("campaignPrefundedPublicDeployer");
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        token.mint(predicted, 7);
        DeployLaunchRewards.Configuration memory c = DeployLaunchRewards.Configuration({
            deployer: deployer,
            owner: owner,
            token: token,
            tokenDecimals: 6,
            rewardAmountRaw: REWARD,
            signer: vm.addr(SIGNER_KEY),
            factory: factory
        });
        MemeFunLaunchRewards deployed = script.deploy(c);
        assertEq(address(deployed), predicted);
        assertEq(token.balanceOf(predicted), 7);
        assertFalse(deployed.activated());
        assertFalse(deployed.isEnabled());
    }

    function testFuzz_equalPayoutAndReserveInvariant(uint16 slot, address wallet) public {
        slot = uint16(bound(slot, 0, 999));
        vm.assume(wallet != address(0) && wallet != address(campaign) && wallet != address(token));
        uint256 before = token.balanceOf(wallet);
        _claim(_allocation(wallet, slot));
        assertEq(token.balanceOf(wallet) - before, REWARD);
        assertEq(token.balanceOf(address(campaign)), campaign.remainingReserve());
        assertEq(campaign.claimedCount(), 1);
    }
}
