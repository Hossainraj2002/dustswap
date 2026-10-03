// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {MemeFunHook} from "../../src/MemeFunHook.sol";
import {MemeFunRouter} from "../../src/MemeFunRouter.sol";
import {IMemeFunHook} from "../../src/interfaces/IMemeFunHook.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {Mode} from "../../src/types/MemeFunTypes.sol";

import {MemeFunFixture} from "../utils/MemeFunFixture.sol";

contract VaultAndLocksTest is MemeFunFixture {
    using StateLibrary for IPoolManager;

    // -------------------------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------------------------

    function test_creatorClaim_paysOnlyTheCreatorInThePairAsset() public {
        address coin = _tradedCoin(ETH, Mode.CREATOR, 300, 5 ether);
        uint256 owed = vault.creatorPending(coin);
        assertGt(owed, 0);

        vm.prank(alice);
        vm.expectRevert(FeeVault.NotCreator.selector);
        vault.claimCreator(coin, alice);

        uint256 before = bob.balance;
        vm.prank(creator);
        vault.claimCreator(coin, bob); // creator may send it anywhere
        assertEq(bob.balance - before, owed);
        assertEq(vault.creatorPending(coin), 0);

        vm.prank(creator);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claimCreator(coin, creator);
    }

    function test_creatorClaim_followsTheCreatorRole() public {
        address coin = _tradedCoin(ETH, Mode.CREATOR, 300, 5 ether);
        vm.prank(creator);
        hook.proposeCreator(coin, bob);
        vm.prank(bob);
        hook.acceptCreator(coin);

        vm.prank(creator);
        vm.expectRevert(FeeVault.NotCreator.selector);
        vault.claimCreator(coin, creator);
        vm.prank(bob);
        vault.claimCreator(coin, bob);
    }

    function test_claimCreatorMany_paysEachCoinInItsOwnAsset() public {
        address ethCoin = _tradedCoin(ETH, Mode.CREATOR, 300, 2 ether);
        address usdcCoin = _tradedCoin(USDC_ADDRESS, Mode.CREATOR, 300, 5_000e6);
        uint256 ethOwed = vault.creatorPending(ethCoin);
        uint256 usdcOwed = vault.creatorPending(usdcCoin);
        address[] memory coins = new address[](2);
        coins[0] = ethCoin;
        coins[1] = usdcCoin;

        uint256 ethBefore = bob.balance;
        vm.prank(creator);
        vault.claimCreatorMany(coins, bob);
        assertEq(bob.balance - ethBefore, ethOwed);
        assertEq(usdc.balanceOf(bob), usdcOwed);
    }

    function test_platformClaim_alwaysGoesToTreasury() public {
        _tradedCoin(ETH, Mode.CREATOR, 300, 5 ether);
        uint256 owed = vault.platformPending(Currency.wrap(ETH));
        vm.prank(alice); // anyone may trigger it
        vault.claimPlatform(Currency.wrap(ETH));
        assertEq(treasury.balance, owed);

        address newTreasury = makeAddr("newTreasury");
        vm.prank(owner);
        config.setTreasury(newTreasury);
        _skip(1);
        vm.prank(alice);
        router.buy{value: 1 ether}(_trade(_coinFor(ETH), 1 ether, address(0)));
        vault.claimPlatform(Currency.wrap(ETH));
        assertGt(newTreasury.balance, 0, "the current treasury");
    }

    function test_referralClaim() public {
        address coin = _tradedCoin(ETH, Mode.CREATOR, 300, 0);
        vm.prank(alice);
        router.buy{value: 4 ether}(_trade(coin, 4 ether, referrer));
        uint256 owed = vault.referralPending(referrer, Currency.wrap(ETH));
        assertGt(owed, 0);
        vm.prank(referrer);
        vault.claimReferral(Currency.wrap(ETH), referrer);
        assertEq(referrer.balance, owed);
    }

    function test_pullDestination_onlyTheCoinsModule() public {
        address creatorCoin = _tradedCoin(ETH, Mode.CREATOR, 300, 1 ether);
        vm.expectRevert(FeeVault.NotModule.selector);
        vault.pullDestination(creatorCoin); // creator mode has no module

        address burnCoin = _tradedCoin(ETH, Mode.BURN, 300, 1 ether);
        address module = hook.moduleOf(burnCoin);
        uint256 owed = vault.destinationPending(burnCoin);
        assertGt(owed, 0);
        vm.prank(alice);
        vm.expectRevert(FeeVault.NotModule.selector);
        vault.pullDestination(burnCoin);

        vm.prank(module);
        assertEq(vault.pullDestination(burnCoin), owed);
        assertEq(manager.balanceOf(module, Currency.wrap(ETH).toId()), owed, "module received the claims");
        vm.prank(module);
        assertEq(vault.pullDestination(burnCoin), 0, "nothing left, no revert");
    }

    function test_claimBalanceAlwaysEqualsWhatIsOwed() public {
        address a = _tradedCoin(ETH, Mode.CREATOR, 300, 3 ether);
        address b = _tradedCoin(ETH, Mode.HOLDERS, 500, 2 ether);
        vm.prank(alice);
        router.buy{value: 1 ether}(_trade(a, 1 ether, referrer));
        uint256 owed = vault.platformPending(Currency.wrap(ETH)) + vault.referralPending(referrer, Currency.wrap(ETH))
            + vault.creatorPending(a) + vault.creatorPending(b) + vault.destinationPending(b);
        assertEq(_vaultClaims(Currency.wrap(ETH)), owed, "claims held == sum of ledgers");

        vm.prank(creator);
        vault.claimCreator(a, creator);
        owed -= vault.creatorPending(a) == 0 ? 0 : 1; // claimed: ledger zeroed
        assertEq(
            _vaultClaims(Currency.wrap(ETH)),
            vault.platformPending(Currency.wrap(ETH)) + vault.referralPending(referrer, Currency.wrap(ETH))
                + vault.creatorPending(b) + vault.destinationPending(b),
            "still equal after a claim"
        );
    }

    function test_reentrantRecipientCannotDoubleClaim() public {
        address coin = _tradedCoin(ETH, Mode.CREATOR, 300, 5 ether);
        ReentrantCreator attacker = new ReentrantCreator(vault, coin);
        vm.prank(creator);
        hook.proposeCreator(coin, address(attacker));
        attacker.accept(hook);

        uint256 owed = vault.creatorPending(coin);
        vm.expectRevert(); // the re-entry is rejected, so the whole claim reverts
        attacker.claim();
        assertEq(vault.creatorPending(coin), owed, "nothing lost");
    }

    function test_recipientRejectingEthOnlyBlocksItself() public {
        address coin = _tradedCoin(ETH, Mode.CREATOR, 300, 5 ether);
        uint256 owed = vault.creatorPending(coin);
        RejectEth rejecter = new RejectEth();
        vm.prank(creator);
        vm.expectRevert();
        vault.claimCreator(coin, address(rejecter));
        assertEq(vault.creatorPending(coin), owed, "kept");
        vm.prank(creator);
        vault.claimCreator(coin, creator);
        // Trading was never affected.
        vm.prank(alice);
        router.buy{value: 0.1 ether}(_trade(coin, 0.1 ether, address(0)));
    }

    function test_onlyTheHookCanCredit() public {
        vm.expectRevert(FeeVault.NotHook.selector);
        vault.credit(address(1), Currency.wrap(ETH), 1, address(0), 0, 0, 0);
    }

    // -------------------------------------------------------------------------------------------
    // Liquidity is locked
    // -------------------------------------------------------------------------------------------

    function test_nobodyCanRemoveLiquidity() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        PoolKey memory key = hook.poolKeyOf(coin);
        (int24 lower, int24 upper) = LaunchMath.launchRange(hook.configOf(coin).quoteIsCurrency0 ? _start(coin) : _start(coin), false);
        vm.expectRevert(_wrapped(IHooks.beforeRemoveLiquidity.selector, MemeFunHook.LiquidityLocked.selector));
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: -1, salt: 0}), ""
        );
    }

    function test_nobodyCanAddForeignLiquidity() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        PoolKey memory key = hook.poolKeyOf(coin);
        vm.expectRevert(_wrapped(IHooks.beforeAddLiquidity.selector, MemeFunHook.LiquidityLocked.selector));
        modifyLiquidityRouter.modifyLiquidity{value: 1 ether}(
            key, ModifyLiquidityParams({tickLower: -887_200, tickUpper: 887_200, liquidityDelta: 1e18, salt: 0}), ""
        );
    }

    function test_donationsAreDisabled() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        DonateHelper helper = new DonateHelper(manager);
        PoolKey memory key = hook.poolKeyOf(coin); // outside expectRevert, which watches the next call
        vm.expectRevert(_wrapped(IHooks.beforeDonate.selector, MemeFunHook.DonationsDisabled.selector));
        helper.donate{value: 1 ether}(key, 1 ether);
    }

    function test_nobodyElseCanCreateAPoolWithTheHook() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        PoolKey memory key = hook.poolKeyOf(coin);
        key.tickSpacing = 60; // a different pool, same hook
        vm.expectRevert(_wrapped(IHooks.beforeInitialize.selector, MemeFunHook.NotFactory.selector));
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    function test_onlyTheFactoryRegistersAndOnlyOnce() public {
        address coin = _launchSimple(ETH, Mode.CREATOR, 100);
        PoolKey memory key = hook.poolKeyOf(coin);
        IMemeFunHook.PoolConfig memory c = hook.configOf(coin);
        vm.expectRevert(MemeFunHook.NotFactory.selector);
        hook.registerPool(key, c, alice);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(MemeFunHook.AlreadyRegistered.selector, coin));
        hook.registerPool(key, c, alice);
    }

    function test_floorModule_mayOnlyAddQuoteSidedLiquidity() public {
        // Point the floor mode at a test module that tries both sides.
        FloorProbe probe = new FloorProbe(manager);
        vm.startPrank(owner);
        config.setModeModule(uint256(Mode.FLOOR), address(probe));
        vm.stopPrank();
        address coin = _launchSimple(ETH, Mode.FLOOR, 100);
        PoolKey memory key = hook.poolKeyOf(coin);
        (, int24 tick,,) = manager.getSlot0(key.toId());

        // ETH is currency0: an ETH-only range sits above the price.
        deal(address(probe), 10 ether);
        probe.add(key, _floorTickAbove(tick, 7_000), _floorTickAbove(tick, 23_000), 1e15);
        assertGt(address(manager).balance, 0, "floor liquidity added");

        // A range at or below the price would be coin-sided: rejected.
        vm.expectRevert(_wrapped(IHooks.beforeAddLiquidity.selector, MemeFunHook.FloorNotQuoteSided.selector));
        probe.add(key, tick - 2_000 - (tick % 200), tick - (tick % 200), 1e15);
    }

    // -------------------------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------------------------

    mapping(address quote => address) internal _lastCoin;

    function _tradedCoin(address quote, Mode mode, uint16 feeBps, uint256 volume) internal returns (address coin) {
        coin = _launch(_params(quote, mode, feeBps));
        _lastCoin[quote] = coin;
        _skip(15);
        if (volume == 0) return coin;
        if (quote == ETH) {
            vm.prank(alice);
            router.buy{value: volume}(_trade(coin, volume, address(0)));
        } else {
            vm.startPrank(alice);
            usdc.approve(address(router), volume);
            router.buy(_trade(coin, volume, address(0)));
            vm.stopPrank();
        }
    }

    function _coinFor(address quote) internal view returns (address) {
        return _lastCoin[quote];
    }

    function _trade(address coin, uint256 amountIn, address ref) internal view returns (MemeFunRouter.TradeParams memory) {
        return MemeFunRouter.TradeParams({
            coin: coin,
            amountIn: amountIn,
            minAmountOut: 0,
            recipient: address(0),
            referrer: ref,
            deadline: _now() + 60
        });
    }

    function _start(address coin) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(hook.poolIdOf(coin));
    }

    function _floorTickAbove(int24 tick, int24 offset) internal pure returns (int24) {
        int24 t = tick + offset;
        return t - (t % 200) + 200;
    }

    /// @dev The exact error v4 raises when our hook reverts with `selector`.
    function _wrapped(bytes4 hookFunction, bytes4 selector) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookFunction,
            abi.encodeWithSelector(selector),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }
}

/// @dev A creator contract that re-enters the vault from its ETH receive hook.
contract ReentrantCreator {
    FeeVault internal immutable vault;
    address internal immutable coin;

    constructor(FeeVault vault_, address coin_) {
        vault = vault_;
        coin = coin_;
    }

    function accept(MemeFunHook hook) external {
        hook.acceptCreator(coin);
    }

    function claim() external {
        vault.claimCreator(coin, address(this));
    }

    receive() external payable {
        vault.claimCreator(coin, address(this));
    }
}

contract RejectEth {
    receive() external payable {
        revert("no ETH");
    }
}

/// @dev Donates through its own unlock, the only way to reach beforeDonate.
contract DonateHelper is IUnlockCallback {
    IPoolManager internal immutable manager;
    PoolKey internal _key;
    uint256 internal _amount;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function donate(PoolKey memory key, uint256 amount) external payable {
        _key = key;
        _amount = amount;
        manager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        manager.donate(_key, _amount, 0, "");
        manager.settle{value: _amount}();
        return "";
    }
}

/// @dev Stands in for FloorVault: adds ETH-only liquidity through its own unlock.
contract FloorProbe is IUnlockCallback {
    IPoolManager internal immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    receive() external payable {}

    function add(PoolKey memory key, int24 lower, int24 upper, uint128 liquidity) external {
        manager.unlock(abi.encode(key, lower, upper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, int24 lower, int24 upper, uint128 liquidity) = abi.decode(data, (PoolKey, int24, int24, uint128));
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0}), ""
        );
        uint256 owed = uint256(-int256(delta.amount0()));
        manager.settle{value: owed}();
        return "";
    }
}
