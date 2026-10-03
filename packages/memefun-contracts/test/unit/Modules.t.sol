// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {BuybackBurnVault} from "../../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {TestToken} from "../utils/TestTokens.sol";

contract ModulesTest is MemeFunFixture {
    using StateLibrary for IPoolManager;

    // -------------------------------------------------------------------------------------------
    // Buyback and burn
    // -------------------------------------------------------------------------------------------

    function test_buyback_burnsCoinsWithTheCoinsOwnFees() public {
        address coin = _tradedCoin(ETH, Mode.BURN, 500, 5 ether);
        uint256 accrued = vault.destinationPending(coin);
        assertGt(accrued, 0);
        uint256 vaultClaimsBefore = _vaultClaims(Currency.wrap(ETH));
        uint256 deadBefore = IB20(coin).balanceOf(DEAD);

        _nextBlock();
        vm.prank(bob); // anyone can trigger it
        (uint256 spent, uint256 burned) = burnVault.executeBuyback(coin);

        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(IB20(coin).balanceOf(DEAD) - deadBefore, burned, "every coin bought is burned");
        assertEq(IB20(coin).balanceOf(address(burnVault)), 0, "vault never holds the coin");
        assertEq(vaultClaimsBefore - _vaultClaims(Currency.wrap(ETH)), accrued, "no fee charged on the buyback");
        assertEq(burnVault.balanceOf(coin), accrued - spent, "unspent stays for next time");
        assertEq(manager.balanceOf(address(burnVault), Currency.wrap(ETH).toId()), accrued - spent, "claims match");
    }

    function test_buyback_cooldown() public {
        address coin = _tradedCoin(ETH, Mode.BURN, 500, 5 ether);
        _nextBlock();
        burnVault.executeBuyback(coin);
        _buy(alice, coin, 1 ether);
        _nextBlock();
        vm.expectPartialRevert(BuybackBurnVault.CoolingDown.selector);
        burnVault.executeBuyback(coin);
        _skip(10 minutes);
        burnVault.executeBuyback(coin);
    }

    function test_buyback_refusesAfterASameBlockPump() public {
        address coin = _tradedCoin(ETH, Mode.BURN, 500, 5 ether);
        _nextBlock();
        _buy(alice, coin, 20 ether); // pump in this block
        vm.expectPartialRevert(BuybackBurnVault.PricePumped.selector);
        burnVault.executeBuyback(coin);
        // Next block, the pumped price is simply the price: the buyback runs.
        _nextBlock();
        burnVault.executeBuyback(coin);
    }

    function test_buyback_impactIsCappedPerRun() public {
        address coin = _tradedCoin(ETH, Mode.BURN, 500, 400 ether); // a lot of fees, a thin pool
        _nextBlock();
        uint160 before = _sqrtPrice(coin);
        (uint256 spent,) = burnVault.executeBuyback(coin);
        uint160 afterRun = _sqrtPrice(coin);
        // ETH is currency0: buying the coin lowers the sqrt price, by at most 1% (about 2% of price).
        assertGe(uint256(afterRun) * 10_000, uint256(before) * 9_899, "sqrt price moved at most ~1%");
        assertGt(burnVault.balanceOf(coin), 0, "the rest waits for the next run");
        assertGt(spent, 0);
    }

    function test_buyback_onlyBurnCoins() public {
        address coin = _tradedCoin(ETH, Mode.CREATOR, 500, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(BuybackBurnVault.NotBurnCoin.selector, coin));
        burnVault.executeBuyback(coin);
    }

    // -------------------------------------------------------------------------------------------
    // Liquidity floor
    // -------------------------------------------------------------------------------------------

    function test_floor_placesQuoteOnlyBandUnderThePrice_coinIsCurrency1() public {
        address coin = _tradedCoin(ETH, Mode.FLOOR, 500, 5 ether);
        _assertFloorBand(coin);
    }

    function test_floor_placesQuoteOnlyBandUnderThePrice_coinIsCurrency0() public {
        address coin = _tradedCoin(STOCK_ADDRESS, Mode.FLOOR, 500, 50e8);
        _assertFloorBand(coin);
    }

    function _assertFloorBand(address coin) internal {
        uint256 accrued = vault.destinationPending(coin);
        bool quoteIsCurrency0 = hook.configOf(coin).quoteIsCurrency0;
        (, int24 tick,,) = manager.getSlot0(hook.poolIdOf(coin));
        _nextBlock();
        (int24 lower, int24 upper, uint128 liquidity, uint256 used) = floorVault.addFloor(coin);

        assertGt(liquidity, 0);
        assertLe(used, accrued);
        if (quoteIsCurrency0) {
            assertGt(lower, tick, "ETH-only band above the tick: the coin is cheaper there");
            assertGe(lower - tick, 6_932, "at least 2x cheaper");
            assertLe(upper - tick, 23_027, "at most 10x cheaper");
        } else {
            assertLe(upper, tick, "quote-only band below the tick");
            assertGe(tick - upper, 6_932);
            assertLe(tick - lower, 23_027);
        }
        assertEq(lower % 200, 0);
        assertEq(upper % 200, 0);
        uint128 owned = manager.getPositionLiquidity(
            hook.poolIdOf(coin), keccak256(abi.encodePacked(address(floorVault), lower, upper, bytes32(0)))
        );
        assertEq(owned, liquidity, "the vault owns the floor position");
        assertTrue(floorVault.hasFloor(coin));
    }

    function test_floor_aSameBlockPumpCannotLiftIt() public {
        address coin = _tradedCoin(ETH, Mode.FLOOR, 500, 5 ether);
        _nextBlock();
        (, int24 tickBefore,,) = manager.getSlot0(hook.poolIdOf(coin));
        _buy(alice, coin, 50 ether); // pump in the same block
        (int24 lower,,,) = floorVault.addFloor(coin);
        // Band is measured from the block-start (cheaper) price, not the pumped one.
        int24 expectedLower = _ceil200(tickBefore + 6_932);
        assertEq(lower, expectedLower, "floor placed from the pre-pump price");
    }

    function test_floor_ratchetsUpAsTheCoinGrows() public {
        address coin = _tradedCoin(ETH, Mode.FLOOR, 500, 5 ether);
        _nextBlock();
        floorVault.addFloor(coin);
        int24 first = floorVault.floorNearTick(coin);

        _buy(alice, coin, 30 ether); // the coin grows
        _skip(1 hours);
        _nextBlock();
        floorVault.addFloor(coin);
        int24 second = floorVault.floorNearTick(coin);
        assertLt(second, first, "coin is currency1: a lower tick is a higher floor price");
    }

    function test_floor_cooldownAndOnlyFloorCoins() public {
        address coin = _tradedCoin(ETH, Mode.FLOOR, 500, 5 ether);
        _nextBlock();
        floorVault.addFloor(coin);
        _buy(alice, coin, 1 ether);
        vm.expectPartialRevert(FloorVault.CoolingDown.selector);
        floorVault.addFloor(coin);

        address other = _tradedCoin(ETH, Mode.BURN, 500, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(FloorVault.NotFloorCoin.selector, other));
        floorVault.addFloor(other);
    }

    // -------------------------------------------------------------------------------------------
    // Holder rewards
    // -------------------------------------------------------------------------------------------

    function test_holders_publishVetoWindowThenClaim() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        (bytes32 root, bytes32[] memory proofAlice, bytes32[] memory proofBob) =
            _tree2(1, coin, 0, alice, pot / 3, 1, bob, pot / 2);

        _publish(1, root, coin, pot);
        assertEq(holders.available(coin), 0, "reserved");

        HolderRewardDistributor.Claim memory c = _claim(1, coin, 0, alice, pot / 3, proofAlice);
        vm.expectRevert(HolderRewardDistributor.ClaimsNotOpen.selector);
        holders.claim(c);

        _skip(12 hours);
        uint256 before = alice.balance;
        vm.prank(bob); // anyone may submit; funds go to the leaf's account
        holders.claim(c);
        assertEq(alice.balance - before, pot / 3, "paid in ETH");

        vm.expectRevert(HolderRewardDistributor.AlreadyClaimed.selector);
        holders.claim(c);

        c = _claim(1, coin, 1, bob, pot / 2 + 1, proofBob); // inflated amount
        vm.expectRevert(HolderRewardDistributor.InvalidProof.selector);
        holders.claim(c);
    }

    function test_holders_aBadRootCannotOverspendTheCoin() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        // The root over-allocates: two leaves of 60% each.
        (bytes32 root, bytes32[] memory p0, bytes32[] memory p1) = _tree2(1, coin, 0, alice, pot * 6 / 10, 1, bob, pot * 6 / 10);
        _publish(1, root, coin, pot);
        _skip(12 hours);
        holders.claim(_claim(1, coin, 0, alice, pot * 6 / 10, p0));
        vm.expectRevert(HolderRewardDistributor.ExceedsEpochTotal.selector);
        holders.claim(_claim(1, coin, 1, bob, pot * 6 / 10, p1));
    }

    function test_holders_vetoReturnsTheRewards() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        (bytes32 root, bytes32[] memory p0,) = _tree2(1, coin, 0, alice, pot, 1, bob, 0);
        _publish(1, root, coin, pot);

        vm.expectRevert(HolderRewardDistributor.NotOwner.selector);
        holders.vetoEpoch(1);
        vm.prank(owner);
        holders.vetoEpoch(1);

        _skip(12 hours);
        vm.expectRevert(HolderRewardDistributor.EpochUnavailable.selector);
        holders.claim(_claim(1, coin, 0, alice, pot, p0));

        address[] memory coins = new address[](1);
        coins[0] = coin;
        holders.releaseEpoch(1, coins);
        assertEq(holders.available(coin), pot, "back in the pot");
        holders.releaseEpoch(1, coins); // idempotent
        assertEq(holders.available(coin), pot);
    }

    function test_holders_vetoOnlyInsideTheWindow() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        (bytes32 root,,) = _tree2(1, coin, 0, alice, pot, 1, bob, 0);
        _publish(1, root, coin, pot);
        _skip(12 hours);
        vm.prank(owner);
        vm.expectRevert(HolderRewardDistributor.VetoWindowClosed.selector);
        holders.vetoEpoch(1);
    }

    function test_holders_unclaimedReturnAfterNinetyDays() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        (bytes32 root, bytes32[] memory p0,) = _tree2(1, coin, 0, alice, pot / 4, 1, bob, pot / 4);
        _publish(1, root, coin, pot);
        _skip(12 hours);
        holders.claim(_claim(1, coin, 0, alice, pot / 4, p0));

        address[] memory coins = new address[](1);
        coins[0] = coin;
        vm.expectRevert(HolderRewardDistributor.NotReleasable.selector);
        holders.releaseEpoch(1, coins);
        _skip(90 days);
        holders.releaseEpoch(1, coins);
        assertEq(holders.available(coin), pot - pot / 4, "unclaimed back in the pot");
    }

    function test_holders_proofsCannotBeReplayedAcrossEpochs() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        (bytes32 root, bytes32[] memory p0,) = _tree2(1, coin, 0, alice, pot / 4, 1, bob, pot / 4);
        _publish(1, root, coin, pot / 2);
        _buy(alice, coin, 5 ether);
        // Epoch 2 reuses the same root bytes; the leaf includes the epoch, so the proof fails.
        _publish(2, root, coin, vault.destinationPending(coin) + holders.available(coin));
        _skip(12 hours);
        vm.expectRevert(HolderRewardDistributor.InvalidProof.selector);
        holders.claim(_claim(2, coin, 0, alice, pot / 4, p0));
    }

    function test_holders_publishingRules() public {
        address coin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        uint256 pot = vault.destinationPending(coin);
        address[] memory coins = new address[](1);
        coins[0] = coin;
        uint256[] memory totals = new uint256[](1);
        totals[0] = pot;

        vm.expectRevert(HolderRewardDistributor.NotPublisher.selector);
        holders.publishEpoch(1, bytes32(uint256(1)), coins, totals);

        vm.startPrank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderRewardDistributor.WrongEpoch.selector, 1, 2));
        holders.publishEpoch(2, bytes32(uint256(1)), coins, totals);

        totals[0] = pot + 1;
        vm.expectPartialRevert(HolderRewardDistributor.InsufficientRewards.selector);
        holders.publishEpoch(1, bytes32(uint256(1)), coins, totals);

        address burnCoin = _tradedCoinNoPrank(ETH, Mode.BURN);
        coins[0] = burnCoin;
        totals[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(HolderRewardDistributor.NotHolderCoin.selector, burnCoin));
        holders.publishEpoch(1, bytes32(uint256(1)), coins, totals);
        vm.stopPrank();
    }

    function test_holders_claimManyAcrossCoinsAndAssets() public {
        address ethCoin = _tradedCoin(ETH, Mode.HOLDERS, 500, 10 ether);
        address usdcCoin = _tradedCoin(USDC_ADDRESS, Mode.HOLDERS, 500, 20_000e6);
        uint256 ethPot = vault.destinationPending(ethCoin);
        uint256 usdcPot = vault.destinationPending(usdcCoin);

        bytes32 l0 = holders.leaf(1, ethCoin, 0, alice, ethPot);
        bytes32 l1 = holders.leaf(1, usdcCoin, 0, alice, usdcPot);
        bytes32 root = Hashes.commutativeKeccak256(l0, l1);
        address[] memory coins = new address[](2);
        coins[0] = ethCoin;
        coins[1] = usdcCoin;
        uint256[] memory totals = new uint256[](2);
        totals[0] = ethPot;
        totals[1] = usdcPot;
        vm.prank(publisher);
        holders.publishEpoch(1, root, coins, totals);
        _skip(12 hours);

        HolderRewardDistributor.Claim[] memory claims = new HolderRewardDistributor.Claim[](2);
        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = l1;
        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = l0;
        claims[0] = _claim(1, ethCoin, 0, alice, ethPot, proof0);
        claims[1] = _claim(1, usdcCoin, 0, alice, usdcPot, proof1);
        uint256 ethBefore = alice.balance;
        uint256 usdcBefore = usdc.balanceOf(alice);
        holders.claimMany(claims);
        assertEq(alice.balance - ethBefore, ethPot);
        assertEq(usdc.balanceOf(alice) - usdcBefore, usdcPot);
    }

    // -------------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------------

    function _tradedCoin(address quote, Mode mode, uint16 feeBps, uint256 volume) internal returns (address coin) {
        coin = _launch(_params(quote, mode, feeBps));
        _skip(15);
        if (volume != 0) _buy(alice, coin, volume);
    }

    /// @dev Launches and trades a coin from inside a publisher prank, then resumes the prank.
    function _tradedCoinNoPrank(address quote, Mode mode) internal returns (address coin) {
        vm.stopPrank();
        coin = _tradedCoin(quote, mode, 500, 1 ether);
        vm.startPrank(publisher);
    }

    function _buy(address who, address coin, uint256 amount) internal {
        Currency quote = hook.quoteCurrencyOf(coin);
        MemeFunRouter.TradeParams memory p = MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: amount,
            minAmountOut: 0,
            recipient: address(0),
            referrer: address(0),
            deadline: _now() + 60
        });
        vm.startPrank(who);
        if (quote.isAddressZero()) {
            router.buy{value: amount}(p);
        } else {
            TestToken(Currency.unwrap(quote)).approve(address(router), amount);
            router.buy(p);
        }
        vm.stopPrank();
    }

    function _publish(uint64 epoch, bytes32 root, address coin, uint256 total) internal {
        address[] memory coins = new address[](1);
        coins[0] = coin;
        uint256[] memory totals = new uint256[](1);
        totals[0] = total;
        vm.prank(publisher);
        holders.publishEpoch(epoch, root, coins, totals);
    }

    function _tree2(
        uint64 epoch,
        address coin,
        uint256 i0,
        address a0,
        uint256 v0,
        uint256 i1,
        address a1,
        uint256 v1
    ) internal view returns (bytes32 root, bytes32[] memory proof0, bytes32[] memory proof1) {
        bytes32 l0 = holders.leaf(epoch, coin, i0, a0, v0);
        bytes32 l1 = holders.leaf(epoch, coin, i1, a1, v1);
        root = Hashes.commutativeKeccak256(l0, l1);
        proof0 = new bytes32[](1);
        proof0[0] = l1;
        proof1 = new bytes32[](1);
        proof1[0] = l0;
    }

    function _claim(uint64 epoch, address coin, uint256 index, address account, uint256 amount, bytes32[] memory proof)
        internal
        pure
        returns (HolderRewardDistributor.Claim memory)
    {
        return HolderRewardDistributor.Claim({
            epoch: epoch,
            coin: coin,
            index: index,
            account: account,
            amount: amount,
            proof: proof
        });
    }

    function _ceil200(int24 tick) internal pure returns (int24) {
        int24 c = tick / 200;
        if (tick > 0 && tick % 200 != 0) c++;
        return c * 200;
    }
}
