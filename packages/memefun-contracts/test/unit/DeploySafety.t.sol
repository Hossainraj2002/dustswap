// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {TestnetExtras} from "../../script/TestnetExtras.s.sol";

/// @dev Exercises the output path without deploying anything or writing a deployment manifest.
contract DeploymentSafetyHarness is Deploy {
    bool public wroteRecord;

    function check(bool dryRun, bool broadcasting, address owner, address treasury) external pure {
        _checkRunSafety(dryRun, broadcasting, owner, treasury);
    }

    function output(string memory json) external {
        _outputRecord(json);
    }

    function _write(string memory) internal override {
        wroteRecord = true;
    }
}

contract TestnetSafetyHarness is TestnetExtras {
    function check(uint256 chainId, bool dryRun, bool broadcasting) external pure {
        _checkTestnetRun(chainId, dryRun, broadcasting);
    }
}

contract TestnetDeploySafetyTest is Test {
    TestnetSafetyHarness internal script;

    function setUp() public {
        script = new TestnetSafetyHarness();
    }

    function test_baseMainnetRefused() public {
        vm.expectRevert(bytes("TestnetExtras: testnet only"));
        script.check(8453, false, true);
    }

    function test_otherProductionChainsRefused() public {
        vm.expectRevert(bytes("TestnetExtras: testnet only"));
        script.check(1, false, true);
    }

    function test_sepoliaRehearsalAllowed() public view {
        script.check(84_532, true, false);
    }

    function test_sepoliaBroadcastAllowed() public view {
        script.check(84_532, false, true);
    }

    function test_localBroadcastAllowed() public view {
        script.check(31_337, false, true);
    }

    function test_dryRunCannotBeBroadcast() public {
        vm.expectRevert(bytes("DRY_RUN cannot be broadcast"));
        script.check(84_532, true, true);
    }
}

contract DeploySafetyTest is Test {
    DeploymentSafetyHarness internal script;
    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0xB0B);

    function setUp() public {
        script = new DeploymentSafetyHarness();
    }

    function test_simulationCannotWriteDeploymentRecord() public {
        script.check(false, false, OWNER, TREASURY);
        script.output('{"chainId":84532,"factory":"simulated"}');
        assertFalse(script.wroteRecord());
    }

    function test_dryRunCannotBeBroadcast() public {
        vm.expectRevert(bytes("DRY_RUN cannot be broadcast"));
        script.check(true, true, OWNER, TREASURY);
    }

    function test_dryRunWithoutBroadcastAllowed() public view {
        script.check(true, false, OWNER, TREASURY);
    }

    function test_realBroadcastWithoutDryRunAllowed() public view {
        script.check(false, true, OWNER, TREASURY);
    }

    function test_zeroOwnerRejected() public {
        vm.expectRevert(bytes("OWNER is zero"));
        script.check(false, true, address(0), TREASURY);
    }

    function test_zeroTreasuryRejected() public {
        vm.expectRevert(bytes("TREASURY is zero"));
        script.check(false, true, OWNER, address(0));
    }
}
