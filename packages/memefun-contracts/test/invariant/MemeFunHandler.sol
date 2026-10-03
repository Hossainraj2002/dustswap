// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {MemeFunFactory} from "../../src/MemeFunFactory.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {BuybackBurnVault} from "../../src/modules/BuybackBurnVault.sol";
import {FloorVault} from "../../src/modules/FloorVault.sol";
import {HolderRewardDistributor} from "../../src/modules/HolderRewardDistributor.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MockAggregator, TestToken} from "../utils/TestTokens.sol";

/// @notice Drives random but valid sequences of everything users, keepers and the owner can do.
///         Each action bounds its inputs to what a real caller could send; actions that may
///         legitimately revert (cooldowns, nothing to claim) are attempted and counted.
contract MemeFunHandler is Test {
    using StateLibrary for IPoolManager;

    struct System {
        IPoolManager manager;
        PoolSwapTest swapRouter;
        MemeFunConfig config;
        MemeFunFactory factory;
        MemeFunHook hook;
        FeeVault vault;
        MemeFunRouter router;
        BuybackBurnVault burnVault;
        FloorVault floorVault;
        HolderRewardDistributor holders;
        address owner;
        address publisher;
        address usdc;
        address stock;
        MockAggregator ethUsd;
        int256 ethUsdE8;
        uint64 stockUsdE8;
    }

    System internal s;
    address[] public actors;
    address[] public coins;
    address[3] public quotes;

    mapping(address coin => bytes) public initialConfig;
    mapping(address coin => uint256) public lastFeeBps;
    mapping(address coin => uint128) public launchLiquidity;
    mapping(address coin => bytes32) public launchPositionKey;

    uint64 public epochCount;
    uint64[] public epochs;
    mapping(uint64 epoch => address) public epochCoin;
    mapping(uint64 epoch => address) public epochAccount;
    mapping(uint64 epoch => uint256) public epochAmount;

    mapping(bytes32 action => uint256) public calls;

    constructor(System memory system, address[] memory actors_) {
        s = system;
        actors = actors_;
        quotes = [address(0), system.usdc, system.stock];
    }

    function coinCount() external view returns (uint256) {
        return coins.length;
    }

    function epochList() external view returns (uint64[] memory) {
        return epochs;
    }

    // -------------------------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------------------------

    function launch(uint256 seed, uint8 quoteIndex, uint8 modeIndex, uint16 feeRaw, uint16 keepRaw, uint96 firstBuy)
        external
    {
        if (coins.length >= 12) return;
        address creator = _actor(seed);
        address quote = quotes[quoteIndex % 3];
        Mode mode = Mode(modeIndex % 4);
        MemeFunConfig.LaunchTerms memory terms = s.config.launchTerms();
        if (terms.launchesPaused || terms.feeMaxBps < terms.feeMinBps) return;

        MemeFunFactory.LaunchParams memory p;
        p.name = "Fuzz Coin";
        p.symbol = "FUZZ";
        p.contractURI = "ipfs://fuzz";
        p.quote = quote;
        p.mode = mode;
        p.feeBps = uint16(bound(feeRaw, terms.feeMinBps, terms.feeMaxBps));
        p.creatorKeepBps = mode == Mode.CREATOR ? 0 : uint16(bound(keepRaw, 0, terms.creatorKeepMaxBps));
        p.salt = keccak256(abi.encode(seed, coins.length, vm.getBlockTimestamp()));
        p.deadline = vm.getBlockTimestamp() + 1 hours;
        p.maxTickDrift = type(uint24).max;
        p.firstBuyAmount = _boundBuy(quote, firstBuy);

        // Live feeds keep updating in production: Chainlink for ETH, the price keeper for stocks.
        s.ethUsd.set(s.ethUsdE8, vm.getBlockTimestamp());
        vm.prank(s.owner);
        s.config.setManualPrice(s.stock, s.stockUsdE8);

        uint256 value = terms.creationFee + (quote == address(0) ? p.firstBuyAmount : 0);
        vm.deal(creator, creator.balance + value);
        if (quote != address(0) && p.firstBuyAmount != 0) TestToken(quote).mint(creator, p.firstBuyAmount);
        vm.startPrank(creator);
        if (quote != address(0) && p.firstBuyAmount != 0) TestToken(quote).approve(address(s.factory), p.firstBuyAmount);
        (address coin,,) = s.factory.launch{value: value}(p);
        vm.stopPrank();

        coins.push(coin);
        initialConfig[coin] = abi.encode(s.hook.configOf(coin));
        lastFeeBps[coin] = p.feeBps;
        // Same block, same price and FDV: the factory computed exactly this tick.
        bool coinIsCurrency0 = uint160(coin) < uint160(quote);
        int24 start = LaunchMath.startTick(
            s.config.quotePriceUsdE8(quote), s.config.quote(quote).decimals, coinIsCurrency0, s.config.openingFdvUsdE8()
        );
        (int24 lower, int24 upper) = LaunchMath.launchRange(start, coinIsCurrency0);
        bytes32 positionKey = keccak256(abi.encodePacked(address(s.factory), lower, upper, bytes32(0)));
        launchPositionKey[coin] = positionKey;
        launchLiquidity[coin] = s.manager.getPositionLiquidity(s.hook.poolIdOf(coin), positionKey);
        calls["launch"]++;
    }

    function buy(uint256 seed, uint256 coinSeed, uint96 amountRaw, uint8 refSeed) external {
        address coin = _coin(coinSeed);
        if (coin == address(0)) return;
        address trader = _actor(seed);
        address quote = Currency.unwrap(s.hook.quoteCurrencyOf(coin));
        uint256 amount = _boundBuy(quote, amountRaw);
        if (amount == 0) return;
        MemeFunRouter.TradeParams memory p = _trade(coin, amount, _referrer(refSeed, trader));
        vm.startPrank(trader);
        if (quote == address(0)) {
            vm.deal(trader, trader.balance + amount);
            s.router.buy{value: amount}(p);
        } else {
            TestToken(quote).mint(trader, amount);
            TestToken(quote).approve(address(s.router), amount);
            s.router.buy(p);
        }
        vm.stopPrank();
        calls["buy"]++;
    }

    function sell(uint256 seed, uint256 coinSeed, uint256 fractionRaw, uint8 refSeed) external {
        address coin = _coin(coinSeed);
        if (coin == address(0)) return;
        address trader = _actor(seed);
        uint256 balance = IB20(coin).balanceOf(trader);
        if (balance == 0) return;
        uint256 amount = bound(fractionRaw, 1, balance);
        vm.startPrank(trader);
        IB20(coin).approve(address(s.router), amount);
        s.router.sell(_trade(coin, amount, _referrer(refSeed, trader)));
        vm.stopPrank();
        calls["sell"]++;
    }

    /// @dev Exact-output swaps and any other caller go through v4-core's test router.
    function directSwap(uint256 seed, uint256 coinSeed, uint8 kind, uint96 amountRaw) external {
        address coin = _coin(coinSeed);
        if (coin == address(0)) return;
        address trader = _actor(seed);
        PoolKey memory key = s.hook.poolKeyOf(coin);
        Currency quote = s.hook.quoteCurrencyOf(coin);
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(quote);
        bool isBuy = kind % 2 == 0;
        bool exactIn = kind % 4 < 2;
        uint256 amount;
        if (isBuy && exactIn) amount = _boundBuy(Currency.unwrap(quote), amountRaw);
        else if (isBuy) amount = bound(amountRaw, 1, 10_000_000e18);
        else if (exactIn) {
            uint256 bal = IB20(coin).balanceOf(trader);
            if (bal == 0) return;
            amount = bound(amountRaw, 1, bal);
        } else {
            amount = bound(amountRaw, 1, quote.isAddressZero() ? 0.05 ether : (Currency.unwrap(quote) == s.usdc ? 50e6 : 1e7));
        }
        if (amount == 0) return;
        bool zeroForOne = isBuy == quoteIsCurrency0;

        uint256 value = quote.isAddressZero() && isBuy ? (exactIn ? amount : 1_000 ether) : 0;
        vm.deal(trader, trader.balance + value);
        if (!quote.isAddressZero()) TestToken(Currency.unwrap(quote)).mint(trader, 1_000_000e8);
        vm.startPrank(trader);
        if (!quote.isAddressZero()) TestToken(Currency.unwrap(quote)).approve(address(s.swapRouter), type(uint256).max);
        IB20(coin).approve(address(s.swapRouter), type(uint256).max);
        try s.swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: exactIn ? -int256(amount) : int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            calls["directSwap"]++;
        } catch {
            // An exact-output sell larger than the trader's coins reverts in settlement.
            calls["directSwapReverted"]++;
        }
        vm.stopPrank();
    }

    function buyback(uint256 coinSeed) external {
        address coin = _coinOfMode(coinSeed, Mode.BURN);
        if (coin == address(0)) return;
        try s.burnVault.executeBuyback(coin) {
            calls["buyback"]++;
        } catch {
            calls["buybackSkipped"]++;
        }
    }

    function addFloor(uint256 coinSeed) external {
        address coin = _coinOfMode(coinSeed, Mode.FLOOR);
        if (coin == address(0)) return;
        try s.floorVault.addFloor(coin) {
            calls["floor"]++;
        } catch {
            calls["floorSkipped"]++;
        }
    }

    /// @dev Publishes a one-leaf epoch (the root is the leaf) paying `actor` a slice of the pot.
    function publishEpoch(uint256 coinSeed, uint256 actorSeed, uint256 shareRaw) external {
        address coin = _coinOfMode(coinSeed, Mode.HOLDERS);
        if (coin == address(0)) return;
        uint256 pot = s.holders.available(coin) + s.vault.destinationPending(coin);
        if (pot == 0) return;
        uint256 total = bound(shareRaw, 1, pot);
        uint64 epoch = s.holders.lastEpoch() + 1;
        address account = _actor(actorSeed);
        bytes32 root = s.holders.leaf(epoch, coin, 0, account, total);
        address[] memory list = new address[](1);
        list[0] = coin;
        uint256[] memory totals = new uint256[](1);
        totals[0] = total;
        vm.prank(s.publisher);
        s.holders.publishEpoch(epoch, root, list, totals);
        epochs.push(epoch);
        epochCoin[epoch] = coin;
        epochAccount[epoch] = account;
        epochAmount[epoch] = total;
        calls["publish"]++;
    }

    function claimEpoch(uint256 epochSeed) external {
        if (epochs.length == 0) return;
        uint64 epoch = epochs[epochSeed % epochs.length];
        HolderRewardDistributor.Claim memory c = HolderRewardDistributor.Claim({
            epoch: epoch,
            coin: epochCoin[epoch],
            index: 0,
            account: epochAccount[epoch],
            amount: epochAmount[epoch],
            proof: new bytes32[](0)
        });
        try s.holders.claim(c) {
            calls["claimEpoch"]++;
        } catch {
            calls["claimEpochSkipped"]++;
        }
    }

    function claimCreator(uint256 coinSeed) external {
        address coin = _coin(coinSeed);
        if (coin == address(0)) return;
        address creator = s.hook.creatorOf(coin);
        vm.prank(creator);
        try s.vault.claimCreator(coin, creator) {
            calls["claimCreator"]++;
        } catch {}
    }

    function claimPlatform(uint8 quoteIndex) external {
        try s.vault.claimPlatform(Currency.wrap(quotes[quoteIndex % 3])) {
            calls["claimPlatform"]++;
        } catch {}
    }

    function claimReferral(uint256 seed, uint8 quoteIndex) external {
        address who = _actor(seed);
        vm.prank(who);
        try s.vault.claimReferral(Currency.wrap(quotes[quoteIndex % 3]), who) {
            calls["claimReferral"]++;
        } catch {}
    }

    function lowerFee(uint256 coinSeed, uint16 newRaw) external {
        address coin = _coin(coinSeed);
        if (coin == address(0)) return;
        uint256 current = s.hook.configOf(coin).feeBps;
        if (current == 0) return;
        uint256 next = bound(newRaw, 0, current - 1);
        vm.prank(s.hook.creatorOf(coin));
        s.hook.lowerFee(coin, next);
        lastFeeBps[coin] = next;
        calls["lowerFee"]++;
    }

    /// @dev The owner changes launch settings at random, within the caps.
    function ownerSettings(uint16 a, uint16 b, uint16 c, uint16 d) external {
        vm.startPrank(s.owner);
        uint256 maxFee = bound(a, 0, 1_000);
        uint256 minFee = bound(b, 0, maxFee);
        s.config.setFeeBounds(minFee, maxFee, minFee);
        s.config.setPlatformShareBps(bound(c, 0, 5_000));
        s.config.setReferralShareBps(bound(d, 0, 5_000));
        s.config.setLaunchProtection(bound(a, 0, 9_900), bound(b, 0, 300));
        vm.stopPrank();
        calls["ownerSettings"]++;
    }

    function passTime(uint32 secondsRaw, uint8 blocksRaw) external {
        vm.warp(vm.getBlockTimestamp() + bound(secondsRaw, 1, 2 days));
        vm.roll(vm.getBlockNumber() + bound(blocksRaw, 1, 50));
        calls["passTime"]++;
    }

    // -------------------------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------------------------

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _referrer(uint8 seed, address trader) internal view returns (address) {
        if (seed % 3 == 0) return address(0);
        if (seed % 3 == 1) return trader; // self-referral: must be dropped
        return actors[seed % actors.length];
    }

    function _coin(uint256 seed) internal view returns (address) {
        if (coins.length == 0) return address(0);
        return coins[seed % coins.length];
    }

    function _coinOfMode(uint256 seed, Mode mode) internal view returns (address) {
        for (uint256 i; i < coins.length; ++i) {
            address coin = coins[(seed % coins.length + i) % coins.length];
            if (s.hook.configOf(coin).mode == mode) return coin;
        }
        return address(0);
    }

    function _boundBuy(address quote, uint256 raw) internal view returns (uint256) {
        if (quote == address(0)) return bound(raw, 0, 20 ether);
        if (quote == s.usdc) return bound(raw, 0, 50_000e6);
        return bound(raw, 0, 150e8);
    }

    function _trade(address coin, uint256 amount, address ref) internal view returns (MemeFunRouter.TradeParams memory) {
        return MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: amount,
            minAmountOut: 0,
            recipient: address(0),
            referrer: ref,
            deadline: vm.getBlockTimestamp() + 60
        });
    }
}
