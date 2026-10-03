// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {MemeFunConfig} from "../../src/MemeFunConfig.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";
import {TestToken} from "../utils/TestTokens.sol";
import {MemeFunHandler} from "./MemeFunHandler.sol";

/// @notice System-wide properties that must hold after ANY sequence of launches, trades of every
///         type, buybacks, floors, holder epochs, claims, fee cuts, settings changes and time.
contract MemeFunInvariantTest is MemeFunFixture {
    using StateLibrary for IPoolManager;

    MemeFunHandler internal handler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        actors.push(alice);
        actors.push(bob);
        actors.push(creator);
        actors.push(referrer);
        actors.push(makeAddr("carol"));
        actors.push(makeAddr("dave"));

        handler = new MemeFunHandler(
            MemeFunHandler.System({
                manager: manager,
                swapRouter: swapRouter,
                config: config,
                factory: factory,
                hook: hook,
                vault: vault,
                router: router,
                burnVault: burnVault,
                floorVault: floorVault,
                holders: holders,
                owner: owner,
                publisher: publisher,
                usdc: USDC_ADDRESS,
                stock: STOCK_ADDRESS,
                ethUsd: ethUsd,
                ethUsdE8: ETH_USD_E8,
                stockUsdE8: STOCK_USD_E8
            }),
            actors
        );
        targetContract(address(handler));
        excludeSender(address(manager));
    }

    // -------------------------------------------------------------------------------------------
    // Coins
    // -------------------------------------------------------------------------------------------

    function invariant_supplyIsFixedAndNoRoleExists() public view {
        bytes32[4] memory roles =
            [B20Constants.DEFAULT_ADMIN_ROLE, B20Constants.MINT_ROLE, B20Constants.SEIZE_ROLE, B20Constants.PAUSE_ROLE];
        address[4] memory who = [address(factory), address(hook), owner, creator];
        for (uint256 i; i < handler.coinCount(); ++i) {
            IB20 coin = IB20(handler.coins(i));
            assertEq(coin.totalSupply(), LaunchMath.SUPPLY, "supply never changes");
            for (uint256 r; r < roles.length; ++r) {
                for (uint256 w; w < who.length; ++w) assertFalse(coin.hasRole(roles[r], who[w]), "no role, ever");
            }
        }
    }

    function invariant_launchLiquidityIsUntouched() public view {
        for (uint256 i; i < handler.coinCount(); ++i) {
            address coin = handler.coins(i);
            uint128 liquidity = manager.getPositionLiquidity(hook.poolIdOf(coin), handler.launchPositionKey(coin));
            assertEq(liquidity, handler.launchLiquidity(coin), "the launch position never changes");
            assertGt(liquidity, 0);
        }
    }

    function invariant_termsAreFrozenExceptAFallingFee() public view {
        for (uint256 i; i < handler.coinCount(); ++i) {
            address coin = handler.coins(i);
            IMemeFunHook.PoolConfig memory initial = abi.decode(handler.initialConfig(coin), (IMemeFunHook.PoolConfig));
            IMemeFunHook.PoolConfig memory current = hook.configOf(coin);
            assertEq(current.feeBps, handler.lastFeeBps(coin), "fee only changes through lowerFee");
            assertLe(current.feeBps, initial.feeBps, "fee never rises");
            current.feeBps = initial.feeBps;
            assertEq(keccak256(abi.encode(current)), keccak256(abi.encode(initial)), "everything else is frozen");
        }
    }

    // -------------------------------------------------------------------------------------------
    // Money
    // -------------------------------------------------------------------------------------------

    /// The vault's claims always equal exactly what it owes, per currency.
    function invariant_vaultIsExactlySolvent() public view {
        address[3] memory quotes = [ETH, USDC_ADDRESS, STOCK_ADDRESS];
        for (uint256 q; q < 3; ++q) {
            Currency currency = Currency.wrap(quotes[q]);
            uint256 owed = vault.platformPending(currency);
            for (uint256 a; a < actors.length; ++a) owed += vault.referralPending(actors[a], currency);
            for (uint256 i; i < handler.coinCount(); ++i) {
                address coin = handler.coins(i);
                if (Currency.unwrap(hook.quoteCurrencyOf(coin)) != quotes[q]) continue;
                owed += vault.creatorPending(coin) + vault.destinationPending(coin);
            }
            assertEq(_vaultClaims(currency), owed, "claims == ledgers");
        }
    }

    /// Each module holds exactly what its own books say, per currency.
    function invariant_modulesHoldExactlyTheirBooks() public view {
        address[3] memory quotes = [ETH, USDC_ADDRESS, STOCK_ADDRESS];
        uint64[] memory epochs = handler.epochList();
        for (uint256 q; q < 3; ++q) {
            Currency currency = Currency.wrap(quotes[q]);
            uint256 burnBook;
            uint256 floorBook;
            uint256 holderBook;
            for (uint256 i; i < handler.coinCount(); ++i) {
                address coin = handler.coins(i);
                if (Currency.unwrap(hook.quoteCurrencyOf(coin)) != quotes[q]) continue;
                burnBook += burnVault.balanceOf(coin);
                floorBook += floorVault.balanceOf(coin);
                holderBook += holders.available(coin);
            }
            for (uint256 e; e < epochs.length; ++e) {
                address coin = handler.epochCoin(epochs[e]);
                if (Currency.unwrap(hook.quoteCurrencyOf(coin)) != quotes[q]) continue;
                if (holders.epochReleased(epochs[e], coin)) continue;
                holderBook += holders.epochTotal(epochs[e], coin) - holders.epochClaimed(epochs[e], coin);
            }
            assertEq(manager.balanceOf(address(burnVault), currency.toId()), burnBook, "burn vault books");
            assertEq(manager.balanceOf(address(floorVault), currency.toId()), floorBook, "floor vault books");
            assertEq(manager.balanceOf(address(holders), currency.toId()), holderBook, "holder books");
        }
    }

    function invariant_noStrayFundsAnywhere() public view {
        address[3] memory quotes = [ETH, USDC_ADDRESS, STOCK_ADDRESS];
        for (uint256 q; q < 3; ++q) {
            assertEq(manager.balanceOf(address(hook), Currency.wrap(quotes[q]).toId()), 0, "hook holds no claims");
        }
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(address(factory).balance, 0, "factory holds no ETH");
        assertEq(address(hook).balance, 0, "hook holds no ETH");
        assertEq(TestToken(USDC_ADDRESS).balanceOf(address(router)), 0);
        assertEq(TestToken(STOCK_ADDRESS).balanceOf(address(router)), 0);
        for (uint256 i; i < handler.coinCount(); ++i) {
            IB20 coin = IB20(handler.coins(i));
            assertEq(coin.balanceOf(address(factory)), 0, "factory holds no coins");
            assertEq(coin.balanceOf(address(router)), 0, "router holds no coins");
            assertEq(coin.balanceOf(address(burnVault)), 0, "buybacks never hold coins");
        }
    }

    function invariant_settingsStayWithinCaps() public view {
        MemeFunConfig.LaunchTerms memory t = config.launchTerms();
        assertLe(t.feeMaxBps, config.MAX_FEE_BPS());
        assertLe(t.feeMinBps, t.feeMaxBps);
        assertLe(t.platformShareBps, config.MAX_PLATFORM_SHARE_BPS());
        assertLe(t.referralShareBps, config.MAX_REFERRAL_SHARE_BPS());
        assertLe(t.creatorKeepMaxBps, config.MAX_CREATOR_KEEP_BPS());
        assertLe(t.protectionStartBps, config.MAX_PROTECTION_START_BPS());
        assertLe(t.protectionDurationSec, config.MAX_PROTECTION_DURATION_SEC());
    }

    /// @dev Prints how often each action ran, so a run that never exercised something is visible.
    function invariant_callSummary() public view {
        handler.calls("launch");
    }
}
