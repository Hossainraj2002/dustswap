// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HookDataLib
/// @notice The hookData MemeFunRouter attaches to every swap: who traded and who referred them.
/// @dev The hook only reads it when the swap comes from MemeFunRouter. Any other caller can put
///      anything in hookData, so for them it is ignored and the trade pays the full fee with no
///      referral.
library HookDataLib {
    uint8 internal constant VERSION = 1;
    uint256 private constant ENCODED_LENGTH = 96;

    function encode(address trader, address referrer) internal pure returns (bytes memory) {
        return abi.encode(VERSION, trader, referrer);
    }

    /// @return ok False for any payload that is not exactly a version-1 encoding.
    function decode(bytes calldata data) internal pure returns (bool ok, address trader, address referrer) {
        if (data.length != ENCODED_LENGTH) return (false, address(0), address(0));
        uint256 version;
        uint256 rawTrader;
        uint256 rawReferrer;
        assembly ("memory-safe") {
            version := calldataload(data.offset)
            rawTrader := calldataload(add(data.offset, 0x20))
            rawReferrer := calldataload(add(data.offset, 0x40))
        }
        // Reject dirty upper bits instead of truncating them into a different address.
        if (version != VERSION || rawTrader >> 160 != 0 || rawReferrer >> 160 != 0) {
            return (false, address(0), address(0));
        }
        return (true, address(uint160(rawTrader)), address(uint160(rawReferrer)));
    }
}
