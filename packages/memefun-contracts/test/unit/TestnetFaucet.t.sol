// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";

import {TestStockFaucet} from "../../script/testnet/TestStockFaucet.sol";
import {MemeFunTestBase} from "../utils/MemeFunTestBase.sol";

/// @notice The testnet stock faucet and the way TestnetExtras.s.sol wires it: the faucet is
///         deployed for the stock's predicted address and receives MINT_ROLE in the B20 creation
///         call itself, so no admin transaction is ever needed afterwards.
contract TestnetFaucetTest is MemeFunTestBase {
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function _deploy() internal returns (IB20 stock, TestStockFaucet faucet) {
        bytes32 salt = keccak256("memefun testnet stock tAAPL");
        address predicted = B20_FACTORY.getB20Address(IB20Factory.B20Variant.ASSET, owner, salt);
        faucet = new TestStockFaucet(IB20(predicted), 10e8);
        bytes[] memory initCalls = new bytes[](2);
        initCalls[0] = B20FactoryLib.encodeGrantRole(B20Constants.MINT_ROLE, address(faucet));
        initCalls[1] = abi.encodeCall(IB20.mint, (owner, 100_000e8));
        vm.prank(owner);
        stock = IB20(
            B20_FACTORY.createB20(
                IB20Factory.B20Variant.ASSET,
                salt,
                B20FactoryLib.encodeAssetCreateParams("Test stock AAPL (testnet, no value)", "tAAPL", owner, 8),
                initCalls
            )
        );
        assertEq(address(stock), predicted, "created where predicted");
    }

    function test_faucetHoldsMintRoleFromCreation() public {
        (IB20 stock, TestStockFaucet faucet) = _deploy();
        assertTrue(stock.hasRole(B20Constants.MINT_ROLE, address(faucet)));
        assertEq(stock.decimals(), 8);
        assertEq(stock.balanceOf(owner), 100_000e8);
    }

    function test_dripsOncePerDayPerAddress() public {
        (IB20 stock, TestStockFaucet faucet) = _deploy();
        vm.prank(alice);
        faucet.drip();
        assertEq(stock.balanceOf(alice), 10e8);
        assertEq(faucet.nextDripAt(alice), vm.getBlockTimestamp() + 1 days);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestStockFaucet.TooSoon.selector, vm.getBlockTimestamp() + 1 days));
        faucet.drip();

        // Another address is not limited by alice's cooldown.
        vm.prank(owner);
        faucet.drip();

        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(faucet.nextDripAt(alice), 0);
        vm.prank(alice);
        faucet.drip();
        assertEq(stock.balanceOf(alice), 20e8);
    }
}
