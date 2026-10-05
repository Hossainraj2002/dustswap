// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";
import {TestToken} from "../utils/TestTokens.sol";
import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

contract TweetAuthorWallet {
    address public immutable controller;

    constructor(address controller_) {
        controller = controller_;
    }

    function verify(
        FeeVault vault,
        address coin,
        uint256 deadline,
        bytes calldata signature
    )
        external
    {
        require(msg.sender == controller, "controller only");
        vault.verifyAuthor(coin, address(this), deadline, signature);
    }

    function claim(FeeVault vault, address coin, address quote, address to) external {
        require(msg.sender == controller, "controller only");
        vault.claimAuthorFor(coin, quote, to);
    }
}

contract TweetRejectEth {
    function reclaim(FeeVault vault, address coin, address quote) external {
        vault.reclaimExpiredAuthorFor(coin, quote);
    }

    receive() external payable {
        revert("no ETH");
    }
}

contract TweetLaunchTest is MemeFunFixture {
    // Public test-only signer; production keys never appear in this suite.
    uint256 internal constant ATTESTOR_KEY = 0xA77E570;
    uint256 internal constant POST_ID = 2_000_000_000_000_000_001;
    uint256 internal constant AUTHOR_ID = 123_456_789;
    bytes32 internal constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant LAUNCH_TYPE = keccak256(
        "TweetLaunch(address launcher,bytes32 salt,uint256 postId,uint256 authorXUserId,uint16 authorShareBps,uint256 deadline)"
    );
    bytes32 internal constant VERIFY_TYPE = keccak256(
        "AuthorVerification(address coin,uint256 authorXUserId,address wallet,uint256 deadline)"
    );
    address[3] internal quotes;

    function setUp() public override {
        super.setUp();
        quotes = [ETH, USDC_ADDRESS, STOCK_ADDRESS];
        vm.prank(owner);
        config.setTweetAttestor(vm.addr(ATTESTOR_KEY));
    }

    function _paramsTweet(
        uint256 count,
        uint16 share
    )
        internal
        returns (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        )
    {
        base = _params(ETH, Mode.CREATOR, 300);
        pairs = new MemeFunFactory.PairParams[](count);
        for (uint256 i; i < count; ++i) {
            uint256 amount = i == 0 ? 0.05 ether : 10 ** config.quote(quotes[i]).decimals;
            pairs[i] = MemeFunFactory.PairParams(
                quotes[i], amount, 1, _expectedStartTick(quotes[i], base.salt, creator), 0
            );
        }
        base.firstBuyAmount = pairs[0].firstBuyAmount;
        base.firstBuyMinCoins = pairs[0].firstBuyMinCoins;
        base.expectedStartTick = pairs[0].expectedStartTick;
        base.maxTickDrift = pairs[0].maxTickDrift;
        tweet = MemeFunFactory.TweetParams(POST_ID, AUTHOR_ID, share);
    }

    function _sign(
        bytes32 structHash,
        string memory name,
        uint256 chainId,
        address verifier
    )
        internal
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPE, keccak256(bytes(name)), keccak256("1"), chainId, verifier)
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signLaunch(
        MemeFunFactory.LaunchParams memory base,
        MemeFunFactory.TweetParams memory tweet,
        address launcher,
        uint256 deadline,
        uint256 chainId,
        address verifier
    )
        internal
        returns (bytes memory)
    {
        return _sign(
            keccak256(
                abi.encode(
                    LAUNCH_TYPE,
                    launcher,
                    base.salt,
                    tweet.postId,
                    tweet.authorXUserId,
                    tweet.authorShareBps,
                    deadline
                )
            ),
            "MemeFunFactory",
            chainId,
            verifier
        );
    }

    function _signVerify(
        address coin,
        uint256 authorId,
        address wallet,
        uint256 deadline,
        uint256 chainId,
        address verifier
    )
        internal
        returns (bytes memory)
    {
        return _sign(
            keccak256(abi.encode(VERIFY_TYPE, coin, authorId, wallet, deadline)),
            "MemeFunFeeVault",
            chainId,
            verifier
        );
    }

    function _submit(
        MemeFunFactory.LaunchParams memory base,
        MemeFunFactory.PairParams[] memory pairs,
        MemeFunFactory.TweetParams memory tweet,
        uint256 deadline,
        bytes memory signature
    )
        internal
        returns (address coin, PoolId[] memory ids)
    {
        uint256 value = config.launchTerms().creationFee;
        for (uint256 i; i < pairs.length; ++i) {
            if (pairs[i].quote == ETH) value += pairs[i].firstBuyAmount;
        }
        vm.startPrank(creator);
        for (uint256 i; i < pairs.length; ++i) {
            if (pairs[i].quote != ETH) {
                TestToken(pairs[i].quote).approve(address(factory), pairs[i].firstBuyAmount);
            }
        }
        (coin, ids,) =
            factory.launchTweetMulti{value: value}(base, pairs, tweet, deadline, signature);
        vm.stopPrank();
    }

    function _launchTweet(
        uint256 count,
        uint16 share
    )
        internal
        returns (address coin, PoolId[] memory ids)
    {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(count, share);
        uint256 deadline = _now() + 60;
        return _submit(
            base,
            pairs,
            tweet,
            deadline,
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory))
        );
    }

    function _attribution(address coin) internal view returns (FeeVault.TweetAttribution memory a) {
        (a.postId, a.authorXUserId, a.authorShareBps, a.verifyBy, a.verifiedWallet) =
            vault.tweetAttribution(coin);
    }

    function _verify(address coin, address wallet) internal {
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signVerify(coin, AUTHOR_ID, wallet, deadline, block.chainid, address(vault));
        vm.prank(wallet);
        vault.verifyAuthor(coin, wallet, deadline, signature);
    }

    function _rejectLaunch(
        MemeFunFactory.LaunchParams memory base,
        MemeFunFactory.PairParams[] memory pairs,
        MemeFunFactory.TweetParams memory tweet,
        address caller,
        uint256 deadline,
        bytes memory signature,
        bytes memory reason
    )
        internal
    {
        vm.prank(caller);
        vm.expectRevert(reason);
        factory.launchTweetMulti{value: base.firstBuyAmount}(
            base, pairs, tweet, deadline, signature
        );
    }

    function _buyFor(address coin, uint256 index, uint256 amount, address ref) internal {
        MemeFunRouter.TradeParams memory p =
            MemeFunRouter.TradeParams(coin, amount, 1, alice, ref, _now() + 60);
        vm.startPrank(alice);
        if (quotes[index] != ETH) TestToken(quotes[index]).approve(address(router), amount);
        router.buyFor{value: quotes[index] == ETH ? amount : 0}(p, quotes[index]);
        vm.stopPrank();
    }

    function _assertSolvent(address coin, uint256 count) internal view {
        for (uint256 i; i < count; ++i) {
            Currency currency = Currency.wrap(quotes[i]);
            uint256 book = vault.platformPending(currency)
                + vault.referralPending(referrer, currency)
                + vault.creatorPendingFor(coin, quotes[i])
                + vault.destinationPendingFor(coin, quotes[i])
                + vault.authorPendingFor(coin, quotes[i]);
            assertEq(
                manager.balanceOf(address(vault), currency.toId()),
                book,
                "every quote claim matches its ledger"
            );
        }
    }

    function test_attributionAndFirstBuyReservesAreAtomicAcrossQuotes() public {
        (address coin, PoolId[] memory ids) = _launchTweet(3, 5000);
        FeeVault.TweetAttribution memory a = _attribution(coin);
        assertEq(a.postId, POST_ID);
        assertEq(a.authorXUserId, AUTHOR_ID);
        assertEq(a.authorShareBps, 5000);
        assertEq(a.verifyBy, _now() + 180 days);
        assertEq(a.verifiedWallet, address(0));
        assertEq(ids.length, 3);
        assertEq(factory.launchCount(), 1);
        assertEq(IB20(coin).totalSupply(), LaunchMath.SUPPLY);
        for (uint256 i; i < 3; ++i) {
            uint256 input = i == 0 ? 0.05 ether : 10 ** config.quote(quotes[i]).decimals;
            uint256 fee = (input * 300 + 9999) / 10_000;
            uint256 platform = fee * 2000 / 10_000;
            uint256 author = (fee - platform) / 2;
            assertEq(vault.platformPending(Currency.wrap(quotes[i])), platform);
            assertEq(
                vault.authorPendingFor(coin, quotes[i]), author, "first buy already credits author"
            );
            assertEq(vault.creatorPendingFor(coin, quotes[i]), fee - platform - author);
            assertEq(vault.destinationPendingFor(coin, quotes[i]), 0);
        }
        assertEq(address(factory).balance, 0);
        assertEq(IB20(coin).balanceOf(address(factory)), 0);
        _assertSolvent(coin, 3);
    }

    function testFuzz_authorSplitConservesEveryQuoteWei(uint16 shareRaw, uint96 amountRaw) public {
        uint16 share = uint16(bound(shareRaw, 2000, 10_000));
        uint256 amount = bound(amountRaw, 1e10, 1 ether);
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(1, share);
        base.firstBuyAmount = amount;
        pairs[0].firstBuyAmount = amount;
        uint256 deadline = _now() + 60;
        (address coin,) = _submit(
            base,
            pairs,
            tweet,
            deadline,
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory))
        );
        uint256 fee = (amount * 300 + 9999) / 10_000;
        uint256 platform = fee * 2000 / 10_000;
        uint256 author = (fee - platform) * share / 10_000;
        assertEq(vault.authorPending(coin), author);
        assertEq(vault.creatorPending(coin), fee - platform - author);
        _assertSolvent(coin, 1);
    }

    function test_platformAndCreatorCannotSpendTheUnverifiedAuthorReserve() public {
        (address coin,) = _launchTweet(1, 10_000);
        uint256 reserved = vault.authorPending(coin);
        assertEq(vault.creatorPending(coin), 0, "100 percent of creator allocation goes to author");
        vault.claimPlatform(Currency.wrap(ETH));
        assertEq(manager.balanceOf(address(vault), Currency.wrap(ETH).toId()), reserved);
        vm.prank(creator);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claimCreator(coin, creator);
        vm.prank(creator);
        vm.expectRevert(FeeVault.NotAuthorWallet.selector);
        vault.claimAuthor(coin, creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeVault.AuthorReserveNotExpired.selector, _attribution(coin).verifyBy
            )
        );
        vm.prank(treasury);
        vault.reclaimExpiredAuthor(coin);
        assertEq(vault.authorPending(coin), reserved);
    }

    function test_shareIdentityAndModeBounds() public {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(1, 1999);
        uint256 deadline = _now() + 60;
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            "",
            abi.encodeWithSelector(MemeFunFactory.InvalidAuthorShare.selector, 1999)
        );
        tweet.authorShareBps = 10_001;
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            "",
            abi.encodeWithSelector(MemeFunFactory.InvalidAuthorShare.selector, 10_001)
        );
        tweet.authorShareBps = 5000;
        tweet.postId = 0;
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            "",
            abi.encodeWithSelector(MemeFunFactory.InvalidTweetIdentity.selector)
        );
        tweet.postId = POST_ID;
        tweet.authorXUserId = 0;
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            "",
            abi.encodeWithSelector(MemeFunFactory.InvalidTweetIdentity.selector)
        );
        tweet.authorXUserId = AUTHOR_ID;
        base.mode = Mode.BURN;
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            "",
            abi.encodeWithSelector(MemeFunFactory.TweetRequiresCreatorMode.selector)
        );
        assertEq(factory.launchCount(), 0);
    }

    function test_launchProofBindsLauncherSaltPostAuthorAndShare() public {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(1, 5000);
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory));
        bytes memory reason =
            abi.encodeWithSelector(MemeFunFactory.InvalidTweetAttestation.selector);
        _rejectLaunch(base, pairs, tweet, alice, deadline, signature, reason);
        bytes32 originalSalt = base.salt;
        base.salt = keccak256("another salt");
        _rejectLaunch(base, pairs, tweet, creator, deadline, signature, reason);
        base.salt = originalSalt;
        tweet.postId++;
        _rejectLaunch(base, pairs, tweet, creator, deadline, signature, reason);
        tweet.postId = POST_ID;
        tweet.authorXUserId++;
        _rejectLaunch(base, pairs, tweet, creator, deadline, signature, reason);
        tweet.authorXUserId = AUTHOR_ID;
        tweet.authorShareBps++;
        _rejectLaunch(base, pairs, tweet, creator, deadline, signature, reason);
        assertEq(factory.launchCount(), 0);
    }

    function test_launchProofDomainChainAndExpiration() public {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(1, 5000);
        uint256 deadline = _now() + 60;
        bytes memory reason =
            abi.encodeWithSelector(MemeFunFactory.InvalidTweetAttestation.selector);
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            _signLaunch(base, tweet, creator, deadline, block.chainid + 1, address(factory)),
            reason
        );
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(vault)),
            reason
        );
        _rejectLaunch(base, pairs, tweet, creator, deadline, hex"1234", reason);
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline - 1,
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory)),
            reason
        );
        deadline = _now() - 1;
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory)),
            abi.encodeWithSelector(MemeFunFactory.Expired.selector)
        );
        assertEq(factory.launchCount(), 0);
    }

    function test_zeroAttestorFailsClosedAndRegistrarIsFactoryOnly() public {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(1, 5000);
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory));
        vm.prank(owner);
        config.setTweetAttestor(address(0));
        _rejectLaunch(
            base,
            pairs,
            tweet,
            creator,
            deadline,
            signature,
            abi.encodeWithSelector(MemeFunFactory.TweetAttestorDisabled.selector)
        );
        vm.prank(alice);
        vm.expectRevert(FeeVault.NotFactory.selector);
        vault.registerTweetAttribution(address(1), POST_ID, AUTHOR_ID, 5000);
    }

    function test_successfulScopedSaltCannotReplayAnAttestation() public {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(1, 5000);
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory));
        (address coin,) = _submit(base, pairs, tweet, deadline, signature);
        uint256 before = creator.balance;
        uint256 pending = vault.authorPending(coin);
        vm.prank(creator);
        vm.expectRevert();
        factory.launchTweetMulti{value: base.firstBuyAmount}(
            base, pairs, tweet, deadline, signature
        );
        assertEq(factory.launchCount(), 1);
        assertEq(creator.balance, before);
        assertEq(vault.authorPending(coin), pending);
        assertEq(hook.poolIdsOf(coin).length, 1);
        vm.prank(address(factory));
        vm.expectRevert(FeeVault.TweetAlreadyAttributed.selector);
        vault.registerTweetAttribution(coin, POST_ID + 1, AUTHOR_ID + 1, 2000);
    }

    function test_failedSecondaryFirstBuyRollsBackAttributionAndAllReserves() public {
        (
            MemeFunFactory.LaunchParams memory base,
            MemeFunFactory.PairParams[] memory pairs,
            MemeFunFactory.TweetParams memory tweet
        ) = _paramsTweet(3, 5000);
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signLaunch(base, tweet, creator, deadline, block.chainid, address(factory));
        address coin = factory.predictCoin(creator, base.salt);
        uint256 before = creator.balance;
        // No USDC/stock allowance, so native first-buy accounting must roll back too.
        vm.prank(creator);
        vm.expectRevert();
        factory.launchTweetMulti{value: base.firstBuyAmount}(
            base, pairs, tweet, deadline, signature
        );
        assertEq(factory.launchCount(), 0);
        assertEq(hook.creatorOf(coin), address(0));
        assertEq(_attribution(coin).authorXUserId, 0);
        assertEq(creator.balance, before);
        for (uint256 i; i < 3; ++i) {
            assertEq(vault.platformPending(Currency.wrap(quotes[i])), 0);
            assertEq(manager.balanceOf(address(vault), Currency.wrap(quotes[i]).toId()), 0);
        }
        (address retried,) = _submit(base, pairs, tweet, deadline, signature);
        assertEq(retried, coin, "failed atomic attempt leaves salt reusable");
    }

    function test_verificationOwnsPastAndFutureAfterCreatorTransferAndFeeCut() public {
        (address coin,) = _launchTweet(3, 5000);
        _verify(coin, alice);
        vm.prank(creator);
        hook.proposeCreator(coin, bob);
        vm.prank(bob);
        hook.acceptCreator(coin);
        vm.prank(bob);
        hook.lowerFee(coin, 100);
        for (uint256 i; i < 3; ++i) {
            uint256 author = vault.authorPendingFor(coin, quotes[i]);
            uint256 before = _balance(Currency.wrap(quotes[i]), alice);
            vm.prank(alice);
            vault.claimAuthorFor(coin, quotes[i], alice);
            assertEq(_balance(Currency.wrap(quotes[i]), alice) - before, author);
            vm.prank(bob);
            vault.claimCreatorFor(coin, quotes[i], bob);
        }
        _skip(181 days);
        vm.prank(owner);
        config.setTweetAttestor(address(0));
        for (uint256 i; i < 3; ++i) {
            uint256 amount = i == 0 ? 0.05 ether : 10 ** config.quote(quotes[i]).decimals;
            _buyFor(coin, i, amount, address(0));
            assertGt(
                vault.authorPendingFor(coin, quotes[i]),
                0,
                "author fees keep accruing after treasury unlock"
            );
            vm.prank(alice);
            vault.claimAuthorFor(coin, quotes[i], alice);
        }
        assertEq(_attribution(coin).verifiedWallet, alice);
        assertEq(_attribution(coin).authorShareBps, 5000);
        assertEq(hook.creatorOf(coin), bob, "author binding is separate from creator role");
        vm.prank(bob);
        vm.expectRevert(FeeVault.AuthorAlreadyVerified.selector);
        vault.verifyAuthor(coin, bob, _now() + 60, "");
        _assertSolvent(coin, 3);
    }

    function test_authorVerificationBindsCoinIdentityWalletDomainAndDeadline() public {
        (address coin,) = _launchTweet(1, 5000);
        (address other,) = _launchTweet(1, 5000);
        uint256 deadline = _now() + 60;
        bytes memory valid =
            _signVerify(coin, AUTHOR_ID, alice, deadline, block.chainid, address(vault));
        vm.prank(bob);
        vm.expectRevert(FeeVault.NotAuthorWallet.selector);
        vault.verifyAuthor(coin, alice, deadline, valid);
        bytes memory reason = abi.encodeWithSelector(FeeVault.InvalidAuthorAttestation.selector);
        vm.startPrank(alice);
        vm.expectRevert(reason);
        vault.verifyAuthor(other, alice, deadline, valid);
        vm.expectRevert(reason);
        vault.verifyAuthor(
            coin,
            alice,
            deadline,
            _signVerify(coin, AUTHOR_ID + 1, alice, deadline, block.chainid, address(vault))
        );
        vm.expectRevert(reason);
        vault.verifyAuthor(
            coin,
            alice,
            deadline,
            _signVerify(coin, AUTHOR_ID, bob, deadline, block.chainid, address(vault))
        );
        vm.expectRevert(reason);
        vault.verifyAuthor(
            coin,
            alice,
            deadline,
            _signVerify(coin, AUTHOR_ID, alice, deadline, block.chainid + 1, address(vault))
        );
        vm.expectRevert(reason);
        vault.verifyAuthor(
            coin,
            alice,
            deadline,
            _signVerify(coin, AUTHOR_ID, alice, deadline, block.chainid, address(factory))
        );
        vm.expectRevert(reason);
        vault.verifyAuthor(coin, alice, deadline, hex"12");
        vm.expectRevert(FeeVault.AttestationExpired.selector);
        vault.verifyAuthor(coin, alice, _now() - 1, valid);
        vm.stopPrank();
        assertEq(_attribution(coin).verifiedWallet, address(0));
        _verify(coin, alice);
    }

    function test_authorVerificationFailsClosedWhenAttestorDisabled() public {
        (address coin,) = _launchTweet(1, 5000);
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signVerify(coin, AUTHOR_ID, alice, deadline, block.chainid, address(vault));
        vm.prank(owner);
        config.setTweetAttestor(address(0));
        vm.prank(alice);
        vm.expectRevert(FeeVault.TweetAttestorDisabled.selector);
        vault.verifyAuthor(coin, alice, deadline, signature);
        assertEq(_attribution(coin).verifiedWallet, address(0));
    }

    function test_lateVerificationCanClaimAfterEarlierTreasurySweep() public {
        (address coin,) = _launchTweet(3, 5000);
        vm.warp(_attribution(coin).verifyBy + 365 days);
        vm.prank(treasury);
        vault.reclaimExpiredAuthorFor(coin, USDC_ADDRESS);
        _verify(coin, alice);
        vm.prank(alice);
        vault.claimAuthor(coin, alice);
        vm.prank(alice);
        vault.claimAuthorFor(coin, STOCK_ADDRESS, alice);
        _buyFor(coin, 1, 1e6, address(0));
        assertGt(vault.authorPendingFor(coin, USDC_ADDRESS), 0);
        vm.prank(alice);
        vault.claimAuthorFor(coin, USDC_ADDRESS, alice);
        assertEq(_attribution(coin).verifiedWallet, alice);
        _assertSolvent(coin, 3);
    }

    function test_treasuryUnlockAllowsLateVerificationAndEitherWalletClaim() public {
        (address coin,) = _launchTweet(3, 5000);
        uint256 verifyBy = _attribution(coin).verifyBy;
        vm.warp(verifyBy - 1);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.AuthorReserveNotExpired.selector, verifyBy));
        vm.prank(treasury);
        vault.reclaimExpiredAuthor(coin);
        vm.warp(verifyBy);
        _verify(coin, alice);
        vm.prank(owner);
        config.setTreasury(bob);
        vm.prank(alice);
        vm.expectRevert(FeeVault.NotTreasury.selector);
        vault.reclaimExpiredAuthor(coin);
        vm.prank(treasury);
        vm.expectRevert(FeeVault.NotTreasury.selector);
        vault.reclaimExpiredAuthor(coin);
        for (uint256 i; i < 3; ++i) {
            uint256 reserved = vault.authorPendingFor(coin, quotes[i]);
            uint256 launcher = vault.creatorPendingFor(coin, quotes[i]);
            uint256 platform = vault.platformPending(Currency.wrap(quotes[i]));
            uint256 before = _balance(Currency.wrap(quotes[i]), bob);
            vm.prank(bob);
            vault.reclaimExpiredAuthorFor(coin, quotes[i]);
            assertEq(
                _balance(Currency.wrap(quotes[i]), bob) - before,
                reserved,
                "only treasury receives reclaim"
            );
            assertEq(vault.authorPendingFor(coin, quotes[i]), 0);
            assertEq(vault.creatorPendingFor(coin, quotes[i]), launcher);
            assertEq(vault.platformPending(Currency.wrap(quotes[i])), platform);
            vm.prank(bob);
            vm.expectRevert(FeeVault.NothingToClaim.selector);
            vault.reclaimExpiredAuthorFor(coin, quotes[i]);
            vm.prank(alice);
            vm.expectRevert(FeeVault.NothingToClaim.selector);
            vault.claimAuthorFor(coin, quotes[i], alice);
            uint256 amount = i == 0 ? 0.05 ether : 10 ** config.quote(quotes[i]).decimals;
            _buyFor(coin, i, amount, address(0));
            uint256 fee = (amount * 300 + 9999) / 10_000;
            uint256 originalPlatform = fee * 2000 / 10_000;
            uint256 author = (fee - originalPlatform) / 2;
            assertEq(
                vault.authorPendingFor(coin, quotes[i]),
                author,
                "new fees replenish the same shared author reserve"
            );
            assertEq(
                vault.creatorPendingFor(coin, quotes[i]), launcher + fee - originalPlatform - author
            );
            assertEq(vault.platformPending(Currency.wrap(quotes[i])), platform + originalPlatform);
            uint256 beforeAuthor = _balance(Currency.wrap(quotes[i]), alice);
            vm.prank(alice);
            vault.claimAuthorFor(coin, quotes[i], alice);
            assertEq(_balance(Currency.wrap(quotes[i]), alice) - beforeAuthor, author);
            vm.prank(bob);
            vm.expectRevert(FeeVault.NothingToClaim.selector);
            vault.reclaimExpiredAuthorFor(coin, quotes[i]);
        }
        assertEq(_attribution(coin).verifiedWallet, alice);
        _assertSolvent(coin, 3);
    }

    function test_earlierAuthorClaimDoesNotExemptLaterBalanceFromTreasury() public {
        (address coin,) = _launchTweet(3, 5000);
        _verify(coin, alice);
        vm.prank(alice);
        vault.claimAuthorFor(coin, USDC_ADDRESS, alice);
        _skip(15);
        _buyFor(coin, 1, 1e6, address(0));
        uint256 outstanding = vault.authorPendingFor(coin, USDC_ADDRESS);
        uint256 nativePending = vault.authorPending(coin);
        uint256 stockPending = vault.authorPendingFor(coin, STOCK_ADDRESS);
        vm.warp(_attribution(coin).verifyBy);
        uint256 before = usdc.balanceOf(treasury);
        vm.prank(treasury);
        vault.reclaimExpiredAuthorFor(coin, USDC_ADDRESS);
        assertEq(usdc.balanceOf(treasury) - before, outstanding);
        assertEq(vault.authorPendingFor(coin, USDC_ADDRESS), 0);
        assertEq(vault.authorPending(coin), nativePending);
        assertEq(vault.authorPendingFor(coin, STOCK_ADDRESS), stockPending);
        vm.prank(alice);
        vault.claimAuthor(coin, alice);
        vm.prank(treasury);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.reclaimExpiredAuthor(coin);
        vm.prank(treasury);
        vault.reclaimExpiredAuthorFor(coin, STOCK_ADDRESS);
        vm.prank(alice);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claimAuthorFor(coin, STOCK_ADDRESS, alice);
        _buyFor(coin, 1, 1e6, address(0));
        vm.prank(treasury);
        vault.reclaimExpiredAuthorFor(coin, USDC_ADDRESS);
        _buyFor(coin, 1, 1e6, address(0));
        vm.prank(alice);
        vault.claimAuthorFor(coin, USDC_ADDRESS, alice);
        assertEq(_attribution(coin).verifiedWallet, alice);
        _assertSolvent(coin, 3);
    }

    function test_rejectedTreasuryPayoutPreservesAuthorBalanceAndOtherQuotes() public {
        (address coin,) = _launchTweet(3, 5000);
        _verify(coin, alice);
        TweetRejectEth reject = new TweetRejectEth();
        vm.prank(owner);
        config.setTreasury(address(reject));
        vm.warp(_attribution(coin).verifyBy);
        uint256 nativePending = vault.authorPending(coin);
        uint256 usdcPending = vault.authorPendingFor(coin, USDC_ADDRESS);
        uint256 stockPending = vault.authorPendingFor(coin, STOCK_ADDRESS);
        vm.expectRevert();
        reject.reclaim(vault, coin, ETH);
        assertEq(vault.authorPending(coin), nativePending);
        assertEq(vault.authorPendingFor(coin, USDC_ADDRESS), usdcPending);
        assertEq(vault.authorPendingFor(coin, STOCK_ADDRESS), stockPending);
        reject.reclaim(vault, coin, USDC_ADDRESS);
        assertEq(usdc.balanceOf(address(reject)), usdcPending);
        assertEq(vault.authorPendingFor(coin, USDC_ADDRESS), 0);
        vm.prank(alice);
        vault.claimAuthor(coin, alice);
        assertEq(vault.authorPending(coin), 0);
        assertEq(vault.authorPendingFor(coin, STOCK_ADDRESS), stockPending);
        _assertSolvent(coin, 3);
    }

    function test_verifiedContractWalletCanClaimWithoutItsOwnECDSASignature() public {
        (address coin,) = _launchTweet(3, 5000);
        TweetAuthorWallet wallet = new TweetAuthorWallet(alice);
        uint256 deadline = _now() + 60;
        bytes memory signature =
            _signVerify(coin, AUTHOR_ID, address(wallet), deadline, block.chainid, address(vault));
        vm.prank(alice);
        wallet.verify(vault, coin, deadline, signature);
        uint256 amount = vault.authorPendingFor(coin, USDC_ADDRESS);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(alice);
        wallet.claim(vault, coin, USDC_ADDRESS, bob);
        assertEq(usdc.balanceOf(bob) - before, amount);
        assertEq(_attribution(coin).verifiedWallet, address(wallet));
        _assertSolvent(coin, 3);
    }

    function test_rejectedAuthorEthPayoutCannotSpendOtherLedgers() public {
        (address coin,) = _launchTweet(3, 5000);
        _verify(coin, alice);
        TweetRejectEth reject = new TweetRejectEth();
        uint256 reserved = vault.authorPending(coin);
        vm.prank(alice);
        vm.expectRevert();
        vault.claimAuthor(coin, address(reject));
        assertEq(vault.authorPending(coin), reserved);
        vm.prank(alice);
        vault.claimAuthorFor(coin, USDC_ADDRESS, bob);
        vm.prank(creator);
        vault.claimCreator(coin, creator);
        vault.claimPlatform(Currency.wrap(ETH));
        assertEq(manager.balanceOf(address(vault), Currency.wrap(ETH).toId()), reserved);
        _assertSolvent(coin, 3);
    }

    function test_referralRoundingLeavesAuthorAndLauncherSharesExact() public {
        (address coin,) = _launchTweet(3, 2001);
        _skip(15);
        uint256 author = vault.authorPendingFor(coin, USDC_ADDRESS);
        uint256 launcher = vault.creatorPendingFor(coin, USDC_ADDRESS);
        uint256 platform = vault.platformPending(Currency.wrap(USDC_ADDRESS));
        _buyFor(coin, 1, 1001, referrer);
        // ceil(1001*3%)=31; platform gross6; referral1; remaining creator allocation25.
        // floor(25*20.01%)=5 author,20 launcher; platform keeps5.
        assertEq(vault.authorPendingFor(coin, USDC_ADDRESS) - author, 5);
        assertEq(vault.creatorPendingFor(coin, USDC_ADDRESS) - launcher, 20);
        assertEq(vault.platformPending(Currency.wrap(USDC_ADDRESS)) - platform, 5);
        assertEq(vault.referralPending(referrer, Currency.wrap(USDC_ADDRESS)), 1);
        _assertSolvent(coin, 3);
    }

    function test_onlyOwnerCanConfigureTheAttestor() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        config.setTweetAttestor(alice);
        vm.prank(owner);
        config.setTweetAttestor(address(0));
        assertEq(config.tweetAttestor(), address(0));
    }
}
