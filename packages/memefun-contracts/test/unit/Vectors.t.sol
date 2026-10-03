// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";

/// @notice Replays the golden vectors written by apps/memefun/scripts/vectors.ts. The UI's
///         TypeScript math is the spec; every case must match the contracts to the wei, so the
///         price a user is shown is the price they get. Regenerate with `pnpm vectors`.
contract VectorsTest is Test {
    function test_feeVectors() public view {
        string memory json = vm.readFile("test/vectors/fees.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGt(count, 100, "vectors present");
        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            uint256 amount = vm.parseJsonUint(json, string.concat(at, ".amount"));
            uint256 bps = vm.parseJsonUint(json, string.concat(at, ".bps"));
            assertEq(FeeMath.onGross(amount, bps), vm.parseJsonUint(json, string.concat(at, ".gross")), at);
            assertEq(FeeMath.onNet(amount, bps), vm.parseJsonUint(json, string.concat(at, ".net")), at);
        }
    }

    function test_splitVectors() public view {
        string memory json = vm.readFile("test/vectors/splits.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGt(count, 100, "vectors present");
        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            FeeMath.Split memory s = FeeMath.split(
                vm.parseJsonUint(json, string.concat(at, ".fee")),
                vm.parseJsonUint(json, string.concat(at, ".mode")) == 0,
                vm.parseJsonUint(json, string.concat(at, ".platformShareBps")),
                vm.parseJsonUint(json, string.concat(at, ".referralShareBps")),
                vm.parseJsonUint(json, string.concat(at, ".creatorKeepBps")),
                vm.parseJsonBool(json, string.concat(at, ".hasReferrer"))
            );
            assertEq(s.platform, vm.parseJsonUint(json, string.concat(at, ".platform")), string.concat(at, " platform"));
            assertEq(s.referral, vm.parseJsonUint(json, string.concat(at, ".referral")), string.concat(at, " referral"));
            assertEq(s.creator, vm.parseJsonUint(json, string.concat(at, ".creator")), string.concat(at, " creator"));
            assertEq(
                s.destination, vm.parseJsonUint(json, string.concat(at, ".destination")), string.concat(at, " destination")
            );
        }
    }

    function test_protectionVectors() public view {
        string memory json = vm.readFile("test/vectors/protection.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGt(count, 100, "vectors present");
        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            assertEq(
                FeeMath.launchFeeBps(
                    vm.parseJsonUint(json, string.concat(at, ".base")),
                    vm.parseJsonUint(json, string.concat(at, ".start")),
                    vm.parseJsonUint(json, string.concat(at, ".duration")),
                    vm.parseJsonUint(json, string.concat(at, ".elapsed"))
                ),
                vm.parseJsonUint(json, string.concat(at, ".bps")),
                at
            );
        }
    }

    function test_launchVectors() public view {
        string memory json = vm.readFile("test/vectors/launches.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertGt(count, 100, "vectors present");
        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            bool coinIsCurrency0 = vm.parseJsonBool(json, string.concat(at, ".coinIsCurrency0"));
            uint8 quoteDecimals = uint8(vm.parseJsonUint(json, string.concat(at, ".quoteDecimals")));
            uint256 quoteUsdE8 = vm.parseJsonUint(json, string.concat(at, ".quoteUsdE8"));
            uint256 fdvUsdE8 = vm.parseJsonUint(json, string.concat(at, ".fdvUsdE8"));

            assertEq(
                LaunchMath.openingSqrtPriceX96(quoteUsdE8, quoteDecimals, coinIsCurrency0, fdvUsdE8),
                vm.parseJsonUint(json, string.concat(at, ".sqrtPriceX96")),
                string.concat(at, " sqrtPrice")
            );
            int24 start = LaunchMath.startTick(quoteUsdE8, quoteDecimals, coinIsCurrency0, fdvUsdE8);
            assertEq(start, vm.parseJsonInt(json, string.concat(at, ".startTick")), string.concat(at, " startTick"));
            (int24 lower, int24 upper) = LaunchMath.launchRange(start, coinIsCurrency0);
            assertEq(lower, vm.parseJsonInt(json, string.concat(at, ".tickLower")), string.concat(at, " tickLower"));
            assertEq(upper, vm.parseJsonInt(json, string.concat(at, ".tickUpper")), string.concat(at, " tickUpper"));
            assertEq(
                LaunchMath.liquidityForSupply(start, coinIsCurrency0),
                vm.parseJsonUint(json, string.concat(at, ".liquidity")),
                string.concat(at, " liquidity")
            );
        }
    }

    /// @dev The vectors must actually exercise the reduced-precision branch (raw price >= 2^64).
    function test_launchVectorsCoverTheReducedPrecisionBranch() public view {
        string memory json = vm.readFile("test/vectors/launches.json");
        uint256 count = vm.parseJsonUint(json, ".count");
        uint256 reduced;
        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            uint256 sqrtPrice = vm.parseJsonUint(json, string.concat(at, ".sqrtPriceX96"));
            // sqrtPrice >= 2^128 means price >= 2^64.
            if (sqrtPrice >= (1 << 128)) ++reduced;
        }
        assertGt(reduced, 0, "no case in the reduced-precision branch");
        assertLt(reduced, count, "every case in the reduced-precision branch");
        // Sanity: the branch cases still sit inside the representable range.
        assertTrue(TickMath.MAX_SQRT_PRICE > (1 << 128));
    }
}
