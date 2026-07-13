// SPDX-License-Identifier: MIT
// ─────────────────────────────────────────────────────────────────────────────
// DustSwapSweepRouterBSC (DustSweep V3 — BNB Smart Chain) — flattened single-file build for Remix.
// BSC adaptation of DustSwapSweepRouter_Remix.sol (which is kept unchanged). Identical logic and
// external ABI; only naming differs: contract → DustSwapSweepRouterBSC, the weth/IWETH9 symbols are
// now wbnb/IWBNB, and ETH → BNB in docs.
//
// REMIX / BscScan VERIFY SETTINGS (use these EXACTLY for first-try verification):
//   Compiler:    0.8.24+commit.e11b9ed9   (Remix: "0.8.24")
//   Language:    Solidity
//   EVM version: cancun                   (set explicitly; do NOT leave "default")
//   Optimizer:   Enabled, 200 runs
//   License:     MIT
// ─────────────────────────────────────────────────────────────────────────────
pragma solidity 0.8.24;

// lib/openzeppelin-contracts/contracts/utils/Context.sol

// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 0;
    }
}

// lib/openzeppelin-contracts/contracts/utils/introspection/IERC165.sol

// OpenZeppelin Contracts (last updated v5.4.0) (utils/introspection/IERC165.sol)

/**
 * @dev Interface of the ERC-165 standard, as defined in the
 * https://eips.ethereum.org/EIPS/eip-165[ERC].
 *
 * Implementers can declare support of contract interfaces, which can then be
 * queried by others ({ERC165Checker}).
 *
 * For an implementation, see {ERC165}.
 */
interface IERC165 {
    /**
     * @dev Returns true if this contract implements the interface defined by
     * `interfaceId`. See the corresponding
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[ERC section]
     * to learn more about how these ids are created.
     *
     * This function call must use less than 30 000 gas.
     */
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

// lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol

// OpenZeppelin Contracts (last updated v5.4.0) (token/ERC20/IERC20.sol)

/**
 * @dev Interface of the ERC-20 standard as defined in the ERC.
 */
interface IERC20 {
    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @dev Returns the value of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the value of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address to, uint256 value) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(address owner, address spender) external view returns (uint256);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the
     * allowance mechanism. `value` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// lib/openzeppelin-contracts/contracts/utils/StorageSlot.sol

// OpenZeppelin Contracts (last updated v5.1.0) (utils/StorageSlot.sol)
// This file was procedurally generated from scripts/generate/templates/StorageSlot.js.

/**
 * @dev Library for reading and writing primitive types to specific storage slots.
 *
 * Storage slots are often used to avoid storage conflict when dealing with upgradeable contracts.
 * This library helps with reading and writing to such slots without the need for inline assembly.
 *
 * The functions in this library return Slot structs that contain a `value` member that can be used to read or write.
 *
 * Example usage to set ERC-1967 implementation slot:
 * ```solidity
 * contract ERC1967 {
 *     // Define the slot. Alternatively, use the SlotDerivation library to derive the slot.
 *     bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
 *
 *     function _getImplementation() internal view returns (address) {
 *         return StorageSlot.getAddressSlot(_IMPLEMENTATION_SLOT).value;
 *     }
 *
 *     function _setImplementation(address newImplementation) internal {
 *         require(newImplementation.code.length > 0);
 *         StorageSlot.getAddressSlot(_IMPLEMENTATION_SLOT).value = newImplementation;
 *     }
 * }
 * ```
 *
 * TIP: Consider using this library along with {SlotDerivation}.
 */
library StorageSlot {
    struct AddressSlot {
        address value;
    }

    struct BooleanSlot {
        bool value;
    }

    struct Bytes32Slot {
        bytes32 value;
    }

    struct Uint256Slot {
        uint256 value;
    }

    struct Int256Slot {
        int256 value;
    }

    struct StringSlot {
        string value;
    }

    struct BytesSlot {
        bytes value;
    }

    /**
     * @dev Returns an `AddressSlot` with member `value` located at `slot`.
     */
    function getAddressSlot(bytes32 slot) internal pure returns (AddressSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `BooleanSlot` with member `value` located at `slot`.
     */
    function getBooleanSlot(bytes32 slot) internal pure returns (BooleanSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `Bytes32Slot` with member `value` located at `slot`.
     */
    function getBytes32Slot(bytes32 slot) internal pure returns (Bytes32Slot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `Uint256Slot` with member `value` located at `slot`.
     */
    function getUint256Slot(bytes32 slot) internal pure returns (Uint256Slot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `Int256Slot` with member `value` located at `slot`.
     */
    function getInt256Slot(bytes32 slot) internal pure returns (Int256Slot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns a `StringSlot` with member `value` located at `slot`.
     */
    function getStringSlot(bytes32 slot) internal pure returns (StringSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns an `StringSlot` representation of the string storage pointer `store`.
     */
    function getStringSlot(string storage store) internal pure returns (StringSlot storage r) {
        assembly ("memory-safe") {
            r.slot := store.slot
        }
    }

    /**
     * @dev Returns a `BytesSlot` with member `value` located at `slot`.
     */
    function getBytesSlot(bytes32 slot) internal pure returns (BytesSlot storage r) {
        assembly ("memory-safe") {
            r.slot := slot
        }
    }

    /**
     * @dev Returns an `BytesSlot` representation of the bytes storage pointer `store`.
     */
    function getBytesSlot(bytes storage store) internal pure returns (BytesSlot storage r) {
        assembly ("memory-safe") {
            r.slot := store.slot
        }
    }
}

// lib/openzeppelin-contracts/contracts/interfaces/IERC165.sol

// OpenZeppelin Contracts (last updated v5.4.0) (interfaces/IERC165.sol)

// lib/openzeppelin-contracts/contracts/interfaces/IERC20.sol

// OpenZeppelin Contracts (last updated v5.4.0) (interfaces/IERC20.sol)

// lib/openzeppelin-contracts/contracts/access/Ownable.sol

// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

/**
 * @dev Contract module which provides a basic access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is set to the address provided by the deployer. This can
 * later be changed with {transferOwnership}.
 *
 * This module is used through inheritance. It will make available the modifier
 * `onlyOwner`, which can be applied to your functions to restrict their use to
 * the owner.
 */
abstract contract Ownable is Context {
    address private _owner;

    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error OwnableUnauthorizedAccount(address account);

    /**
     * @dev The owner is not a valid owner account. (eg. `address(0)`)
     */
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Initializes the contract setting the address provided by the deployer as the initial owner.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /**
     * @dev Returns the address of the current owner.
     */
    function owner() public view virtual returns (address) {
        return _owner;
    }

    /**
     * @dev Throws if the sender is not the owner.
     */
    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    /**
     * @dev Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

// lib/openzeppelin-contracts/contracts/utils/Pausable.sol

// OpenZeppelin Contracts (last updated v5.3.0) (utils/Pausable.sol)

/**
 * @dev Contract module which allows children to implement an emergency stop
 * mechanism that can be triggered by an authorized account.
 *
 * This module is used through inheritance. It will make available the
 * modifiers `whenNotPaused` and `whenPaused`, which can be applied to
 * the functions of your contract. Note that they will not be pausable by
 * simply including this module, only once the modifiers are put in place.
 */
abstract contract Pausable is Context {
    bool private _paused;

    /**
     * @dev Emitted when the pause is triggered by `account`.
     */
    event Paused(address account);

    /**
     * @dev Emitted when the pause is lifted by `account`.
     */
    event Unpaused(address account);

    /**
     * @dev The operation failed because the contract is paused.
     */
    error EnforcedPause();

    /**
     * @dev The operation failed because the contract is not paused.
     */
    error ExpectedPause();

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     */
    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is paused.
     *
     * Requirements:
     *
     * - The contract must be paused.
     */
    modifier whenPaused() {
        _requirePaused();
        _;
    }

    /**
     * @dev Returns true if the contract is paused, and false otherwise.
     */
    function paused() public view virtual returns (bool) {
        return _paused;
    }

    /**
     * @dev Throws if the contract is paused.
     */
    function _requireNotPaused() internal view virtual {
        if (paused()) {
            revert EnforcedPause();
        }
    }

    /**
     * @dev Throws if the contract is not paused.
     */
    function _requirePaused() internal view virtual {
        if (!paused()) {
            revert ExpectedPause();
        }
    }

    /**
     * @dev Triggers stopped state.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     */
    function _pause() internal virtual whenNotPaused {
        _paused = true;
        emit Paused(_msgSender());
    }

    /**
     * @dev Returns to normal state.
     *
     * Requirements:
     *
     * - The contract must be paused.
     */
    function _unpause() internal virtual whenPaused {
        _paused = false;
        emit Unpaused(_msgSender());
    }
}

// lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol

// OpenZeppelin Contracts (last updated v5.5.0) (utils/ReentrancyGuard.sol)

/**
 * @dev Contract module that helps prevent reentrant calls to a function.
 *
 * Inheriting from `ReentrancyGuard` will make the {nonReentrant} modifier
 * available, which can be applied to functions to make sure there are no nested
 * (reentrant) calls to them.
 *
 * Note that because there is a single `nonReentrant` guard, functions marked as
 * `nonReentrant` may not call one another. This can be worked around by making
 * those functions `private`, and then adding `external` `nonReentrant` entry
 * points to them.
 *
 * TIP: If EIP-1153 (transient storage) is available on the chain you're deploying at,
 * consider using {ReentrancyGuardTransient} instead.
 *
 * TIP: If you would like to learn more about reentrancy and alternative ways
 * to protect against it, check out our blog post
 * https://blog.openzeppelin.com/reentrancy-after-istanbul/[Reentrancy After Istanbul].
 *
 * IMPORTANT: Deprecated. This storage-based reentrancy guard will be removed and replaced
 * by the {ReentrancyGuardTransient} variant in v6.0.
 *
 * @custom:stateless
 */
abstract contract ReentrancyGuard {
    using StorageSlot for bytes32;

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REENTRANCY_GUARD_STORAGE =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;

    // Booleans are more expensive than uint256 or any type that takes up a full
    // word because each write operation emits an extra SLOAD to first read the
    // slot's contents, replace the bits taken up by the boolean, and then write
    // back. This is the compiler's defense against contract upgrades and
    // pointer aliasing, and it cannot be disabled.

    // The values being non-zero value makes deployment a bit more expensive,
    // but in exchange the refund on every call to nonReentrant will be lower in
    // amount. Since refunds are capped to a percentage of the total
    // transaction's gas, it is best to keep them low in cases like this one, to
    // increase the likelihood of the full refund coming into effect.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /**
     * @dev Unauthorized reentrant call.
     */
    error ReentrancyGuardReentrantCall();

    constructor() {
        _reentrancyGuardStorageSlot().getUint256Slot().value = NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     * Calling a `nonReentrant` function from another `nonReentrant`
     * function is not supported. It is possible to prevent this from happening
     * by making the `nonReentrant` function external, and making it call a
     * `private` function that does the actual work.
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    /**
     * @dev A `view` only version of {nonReentrant}. Use to block view functions
     * from being called, preventing reading from inconsistent contract state.
     *
     * CAUTION: This is a "view" modifier and does not change the reentrancy
     * status. Use it only on view functions. For payable or non-payable functions,
     * use the standard {nonReentrant} modifier instead.
     */
    modifier nonReentrantView() {
        _nonReentrantBeforeView();
        _;
    }

    function _nonReentrantBeforeView() private view {
        if (_reentrancyGuardEntered()) {
            revert ReentrancyGuardReentrantCall();
        }
    }

    function _nonReentrantBefore() private {
        // On the first call to nonReentrant, _status will be NOT_ENTERED
        _nonReentrantBeforeView();

        // Any calls to nonReentrant after this point will fail
        _reentrancyGuardStorageSlot().getUint256Slot().value = ENTERED;
    }

    function _nonReentrantAfter() private {
        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _reentrancyGuardStorageSlot().getUint256Slot().value = NOT_ENTERED;
    }

    /**
     * @dev Returns true if the reentrancy guard is currently set to "entered", which indicates there is a
     * `nonReentrant` function in the call stack.
     */
    function _reentrancyGuardEntered() internal view returns (bool) {
        return _reentrancyGuardStorageSlot().getUint256Slot().value == ENTERED;
    }

    function _reentrancyGuardStorageSlot() internal pure virtual returns (bytes32) {
        return REENTRANCY_GUARD_STORAGE;
    }
}

// lib/openzeppelin-contracts/contracts/interfaces/IERC1363.sol

// OpenZeppelin Contracts (last updated v5.4.0) (interfaces/IERC1363.sol)

/**
 * @title IERC1363
 * @dev Interface of the ERC-1363 standard as defined in the https://eips.ethereum.org/EIPS/eip-1363[ERC-1363].
 *
 * Defines an extension interface for ERC-20 tokens that supports executing code on a recipient contract
 * after `transfer` or `transferFrom`, or code on a spender contract after `approve`, in a single transaction.
 */
interface IERC1363 is IERC20, IERC165 {
    /*
     * Note: the ERC-165 identifier for this interface is 0xb0202a11.
     * 0xb0202a11 ===
     *   bytes4(keccak256('transferAndCall(address,uint256)')) ^
     *   bytes4(keccak256('transferAndCall(address,uint256,bytes)')) ^
     *   bytes4(keccak256('transferFromAndCall(address,address,uint256)')) ^
     *   bytes4(keccak256('transferFromAndCall(address,address,uint256,bytes)')) ^
     *   bytes4(keccak256('approveAndCall(address,uint256)')) ^
     *   bytes4(keccak256('approveAndCall(address,uint256,bytes)'))
     */

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferAndCall(address to, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @param data Additional data with no specified format, sent in call to `to`.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the allowance mechanism
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param from The address which you want to send tokens from.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferFromAndCall(address from, address to, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the allowance mechanism
     * and then calls {IERC1363Receiver-onTransferReceived} on `to`.
     * @param from The address which you want to send tokens from.
     * @param to The address which you want to transfer to.
     * @param value The amount of tokens to be transferred.
     * @param data Additional data with no specified format, sent in call to `to`.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function transferFromAndCall(address from, address to, uint256 value, bytes calldata data) external returns (bool);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens and then calls {IERC1363Spender-onApprovalReceived} on `spender`.
     * @param spender The address which will spend the funds.
     * @param value The amount of tokens to be spent.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function approveAndCall(address spender, uint256 value) external returns (bool);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens and then calls {IERC1363Spender-onApprovalReceived} on `spender`.
     * @param spender The address which will spend the funds.
     * @param value The amount of tokens to be spent.
     * @param data Additional data with no specified format, sent in call to `spender`.
     * @return A boolean value indicating whether the operation succeeded unless throwing.
     */
    function approveAndCall(address spender, uint256 value, bytes calldata data) external returns (bool);
}

// lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol

// OpenZeppelin Contracts (last updated v5.5.0) (token/ERC20/utils/SafeERC20.sol)

/**
 * @title SafeERC20
 * @dev Wrappers around ERC-20 operations that throw on failure (when the token
 * contract returns false). Tokens that return no value (and instead revert or
 * throw on failure) are also supported, non-reverting calls are assumed to be
 * successful.
 * To use this library you can add a `using SafeERC20 for IERC20;` statement to your contract,
 * which allows you to call the safe operations as `token.safeTransfer(...)`, etc.
 */
library SafeERC20 {
    /**
     * @dev An operation with an ERC-20 token failed.
     */
    error SafeERC20FailedOperation(address token);

    /**
     * @dev Indicates a failed `decreaseAllowance` request.
     */
    error SafeERC20FailedDecreaseAllowance(address spender, uint256 currentAllowance, uint256 requestedDecrease);

    /**
     * @dev Transfer `value` amount of `token` from the calling contract to `to`. If `token` returns no value,
     * non-reverting calls are assumed to be successful.
     */
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        if (!_safeTransfer(token, to, value, true)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Transfer `value` amount of `token` from `from` to `to`, spending the approval given by `from` to the
     * calling contract. If `token` returns no value, non-reverting calls are assumed to be successful.
     */
    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        if (!_safeTransferFrom(token, from, to, value, true)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Variant of {safeTransfer} that returns a bool instead of reverting if the operation is not successful.
     */
    function trySafeTransfer(IERC20 token, address to, uint256 value) internal returns (bool) {
        return _safeTransfer(token, to, value, false);
    }

    /**
     * @dev Variant of {safeTransferFrom} that returns a bool instead of reverting if the operation is not successful.
     */
    function trySafeTransferFrom(IERC20 token, address from, address to, uint256 value) internal returns (bool) {
        return _safeTransferFrom(token, from, to, value, false);
    }

    /**
     * @dev Increase the calling contract's allowance toward `spender` by `value`. If `token` returns no value,
     * non-reverting calls are assumed to be successful.
     *
     * IMPORTANT: If the token implements ERC-7674 (ERC-20 with temporary allowance), and if the "client"
     * smart contract uses ERC-7674 to set temporary allowances, then the "client" smart contract should avoid using
     * this function. Performing a {safeIncreaseAllowance} or {safeDecreaseAllowance} operation on a token contract
     * that has a non-zero temporary allowance (for that particular owner-spender) will result in unexpected behavior.
     */
    function safeIncreaseAllowance(IERC20 token, address spender, uint256 value) internal {
        uint256 oldAllowance = token.allowance(address(this), spender);
        forceApprove(token, spender, oldAllowance + value);
    }

    /**
     * @dev Decrease the calling contract's allowance toward `spender` by `requestedDecrease`. If `token` returns no
     * value, non-reverting calls are assumed to be successful.
     *
     * IMPORTANT: If the token implements ERC-7674 (ERC-20 with temporary allowance), and if the "client"
     * smart contract uses ERC-7674 to set temporary allowances, then the "client" smart contract should avoid using
     * this function. Performing a {safeIncreaseAllowance} or {safeDecreaseAllowance} operation on a token contract
     * that has a non-zero temporary allowance (for that particular owner-spender) will result in unexpected behavior.
     */
    function safeDecreaseAllowance(IERC20 token, address spender, uint256 requestedDecrease) internal {
        unchecked {
            uint256 currentAllowance = token.allowance(address(this), spender);
            if (currentAllowance < requestedDecrease) {
                revert SafeERC20FailedDecreaseAllowance(spender, currentAllowance, requestedDecrease);
            }
            forceApprove(token, spender, currentAllowance - requestedDecrease);
        }
    }

    /**
     * @dev Set the calling contract's allowance toward `spender` to `value`. If `token` returns no value,
     * non-reverting calls are assumed to be successful. Meant to be used with tokens that require the approval
     * to be set to zero before setting it to a non-zero value, such as USDT.
     *
     * NOTE: If the token implements ERC-7674, this function will not modify any temporary allowance. This function
     * only sets the "standard" allowance. Any temporary allowance will remain active, in addition to the value being
     * set here.
     */
    function forceApprove(IERC20 token, address spender, uint256 value) internal {
        if (!_safeApprove(token, spender, value, false)) {
            if (!_safeApprove(token, spender, 0, true)) revert SafeERC20FailedOperation(address(token));
            if (!_safeApprove(token, spender, value, true)) revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Performs an {ERC1363} transferAndCall, with a fallback to the simple {ERC20} transfer if the target has no
     * code. This can be used to implement an {ERC721}-like safe transfer that relies on {ERC1363} checks when
     * targeting contracts.
     *
     * Reverts if the returned value is other than `true`.
     */
    function transferAndCallRelaxed(IERC1363 token, address to, uint256 value, bytes memory data) internal {
        if (to.code.length == 0) {
            safeTransfer(token, to, value);
        } else if (!token.transferAndCall(to, value, data)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Performs an {ERC1363} transferFromAndCall, with a fallback to the simple {ERC20} transferFrom if the target
     * has no code. This can be used to implement an {ERC721}-like safe transfer that relies on {ERC1363} checks when
     * targeting contracts.
     *
     * Reverts if the returned value is other than `true`.
     */
    function transferFromAndCallRelaxed(
        IERC1363 token,
        address from,
        address to,
        uint256 value,
        bytes memory data
    ) internal {
        if (to.code.length == 0) {
            safeTransferFrom(token, from, to, value);
        } else if (!token.transferFromAndCall(from, to, value, data)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Performs an {ERC1363} approveAndCall, with a fallback to the simple {ERC20} approve if the target has no
     * code. This can be used to implement an {ERC721}-like safe transfer that rely on {ERC1363} checks when
     * targeting contracts.
     *
     * NOTE: When the recipient address (`to`) has no code (i.e. is an EOA), this function behaves as {forceApprove}.
     * Oppositely, when the recipient address (`to`) has code, this function only attempts to call {ERC1363-approveAndCall}
     * once without retrying, and relies on the returned value to be true.
     *
     * Reverts if the returned value is other than `true`.
     */
    function approveAndCallRelaxed(IERC1363 token, address to, uint256 value, bytes memory data) internal {
        if (to.code.length == 0) {
            forceApprove(token, to, value);
        } else if (!token.approveAndCall(to, value, data)) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Imitates a Solidity `token.transfer(to, value)` call, relaxing the requirement on the return value: the
     * return value is optional (but if data is returned, it must not be false).
     *
     * @param token The token targeted by the call.
     * @param to The recipient of the tokens
     * @param value The amount of token to transfer
     * @param bubble Behavior switch if the transfer call reverts: bubble the revert reason or return a false boolean.
     */
    function _safeTransfer(IERC20 token, address to, uint256 value, bool bubble) private returns (bool success) {
        bytes4 selector = IERC20.transfer.selector;

        assembly ("memory-safe") {
            let fmp := mload(0x40)
            mstore(0x00, selector)
            mstore(0x04, and(to, shr(96, not(0))))
            mstore(0x24, value)
            success := call(gas(), token, 0, 0x00, 0x44, 0x00, 0x20)
            // if call success and return is true, all is good.
            // otherwise (not success or return is not true), we need to perform further checks
            if iszero(and(success, eq(mload(0x00), 1))) {
                // if the call was a failure and bubble is enabled, bubble the error
                if and(iszero(success), bubble) {
                    returndatacopy(fmp, 0x00, returndatasize())
                    revert(fmp, returndatasize())
                }
                // if the return value is not true, then the call is only successful if:
                // - the token address has code
                // - the returndata is empty
                success := and(success, and(iszero(returndatasize()), gt(extcodesize(token), 0)))
            }
            mstore(0x40, fmp)
        }
    }

    /**
     * @dev Imitates a Solidity `token.transferFrom(from, to, value)` call, relaxing the requirement on the return
     * value: the return value is optional (but if data is returned, it must not be false).
     *
     * @param token The token targeted by the call.
     * @param from The sender of the tokens
     * @param to The recipient of the tokens
     * @param value The amount of token to transfer
     * @param bubble Behavior switch if the transfer call reverts: bubble the revert reason or return a false boolean.
     */
    function _safeTransferFrom(
        IERC20 token,
        address from,
        address to,
        uint256 value,
        bool bubble
    ) private returns (bool success) {
        bytes4 selector = IERC20.transferFrom.selector;

        assembly ("memory-safe") {
            let fmp := mload(0x40)
            mstore(0x00, selector)
            mstore(0x04, and(from, shr(96, not(0))))
            mstore(0x24, and(to, shr(96, not(0))))
            mstore(0x44, value)
            success := call(gas(), token, 0, 0x00, 0x64, 0x00, 0x20)
            // if call success and return is true, all is good.
            // otherwise (not success or return is not true), we need to perform further checks
            if iszero(and(success, eq(mload(0x00), 1))) {
                // if the call was a failure and bubble is enabled, bubble the error
                if and(iszero(success), bubble) {
                    returndatacopy(fmp, 0x00, returndatasize())
                    revert(fmp, returndatasize())
                }
                // if the return value is not true, then the call is only successful if:
                // - the token address has code
                // - the returndata is empty
                success := and(success, and(iszero(returndatasize()), gt(extcodesize(token), 0)))
            }
            mstore(0x40, fmp)
            mstore(0x60, 0)
        }
    }

    /**
     * @dev Imitates a Solidity `token.approve(spender, value)` call, relaxing the requirement on the return value:
     * the return value is optional (but if data is returned, it must not be false).
     *
     * @param token The token targeted by the call.
     * @param spender The spender of the tokens
     * @param value The amount of token to transfer
     * @param bubble Behavior switch if the transfer call reverts: bubble the revert reason or return a false boolean.
     */
    function _safeApprove(IERC20 token, address spender, uint256 value, bool bubble) private returns (bool success) {
        bytes4 selector = IERC20.approve.selector;

        assembly ("memory-safe") {
            let fmp := mload(0x40)
            mstore(0x00, selector)
            mstore(0x04, and(spender, shr(96, not(0))))
            mstore(0x24, value)
            success := call(gas(), token, 0, 0x00, 0x44, 0x00, 0x20)
            // if call success and return is true, all is good.
            // otherwise (not success or return is not true), we need to perform further checks
            if iszero(and(success, eq(mload(0x00), 1))) {
                // if the call was a failure and bubble is enabled, bubble the error
                if and(iszero(success), bubble) {
                    returndatacopy(fmp, 0x00, returndatasize())
                    revert(fmp, returndatasize())
                }
                // if the return value is not true, then the call is only successful if:
                // - the token address has code
                // - the returndata is empty
                success := and(success, and(iszero(returndatasize()), gt(extcodesize(token), 0)))
            }
            mstore(0x40, fmp)
        }
    }
}

// src/DustSwapSweepRouter.sol (BSC adaptation — WBNB/BNB naming)

/// @notice Permit2 one-shot SignatureTransfer interface (exact, per-sweep, no standing allowance).
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

/// @notice Permit2 AllowanceTransfer interface, used only for the Uniswap Universal Router / V4
///         special case where the router pulls tokens through Permit2 (spender == Permit2).
interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice Minimal WBNB interface for unwrapping to native BNB on native-output sweeps.
interface IWBNB {
    function withdraw(uint256 amount) external;
}

/// @title DustSwapSweepRouterBSC (DustSweep V3 — BNB Smart Chain)
/// @author DustSwap
/// @notice Best-effort, multi-DEX dust sweep router for BNB Smart Chain (chainId 56). Sweeps many small
///         ERC-20 balances into a single output token (ERC-20 or native BNB) using allowlisted
///         swap targets, with hard, per-sweep, exact-amount approvals only.
/// @dev    BSC deployment of the V3 contract — same logic and external ABI as the Base/Ethereum builds;
///         the app targets it via DUST_SWEEP_ROUTER_V3_ADDRESS_56.
///
///         SECURITY MODEL — APPROVALS (non-negotiable):
///         `route.amountIn` is the single source of truth. The user permits/approves EXACTLY
///         `route.amountIn` per token, the router pulls EXACTLY that, and approves the DEX EXACTLY
///         that amount, resetting to 0 immediately after. No infinite/standing allowance path
///         exists. Fee-on-transfer tokens (where the router would hold < `amountIn`) are skipped
///         and refunded rather than over-approved or failing the whole batch.
contract DustSwapSweepRouterBSC is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ──────────────────────────── Types ────────────────────────────

    /// @notice How user inputs are pulled into the router for this sweep.
    /// @dev Permit2Signature = one-shot Permit2 SignatureTransfer with a witness (plain EOAs and
    ///      EIP-1271 smart accounts). Allowance = ERC-20 transferFrom, used by EIP-7702/EIP-5792
    ///      wallets that batch an exact-amount approve + sweep atomically.
    enum SweepMode {
        Permit2Signature,
        Allowance
    }

    /// @notice One swap leg. Same field shape as V2 so existing route builders stay compatible.
    /// @dev `value` MUST be 0 (ERC-20 inputs only; the entrypoint is non-payable).
    struct SweepRoute {
        address tokenIn;
        uint256 amountIn;
        address target;
        address spender;
        uint256 value;
        bytes data;
    }

    /// @notice Output / settlement parameters for the whole sweep.
    /// @dev `outputToken` may be a normal ERC-20 or NATIVE_TOKEN_SENTINEL for native BNB.
    ///      `feeBpsOverride` is the per-sweep fee in bps; use FEE_OVERRIDE_SENTINEL to fall back
    ///      to the contract default `feeBps`. Any explicit override must be <= MAX_FEE_BPS.
    struct SweepParams {
        address outputToken;
        address recipient;
        uint256 minAmountOut;
        uint256 deadline;
        uint16 feeBpsOverride;
    }

    /// @dev Internal settlement scratch space, threaded as one stack slot to avoid stack-too-deep.
    struct SweepState {
        address actualOutput;
        uint256 initialOutputBalance;
        uint16 effectiveFeeBps;
        uint256 routeCount;
    }

    // ──────────────────────────── Constants ────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint16 public constant MAX_FEE_BPS = 300; // 3% hard cap, can never be exceeded in any mode
    uint16 public constant FEE_OVERRIDE_SENTINEL = type(uint16).max; // "use default feeBps"
    address public constant NATIVE_TOKEN_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    bytes32 public constant SWEEP_ROUTE_TYPEHASH = keccak256(
        "SweepRoute(address tokenIn,uint256 amountIn,address target,address spender,uint256 value,bytes32 dataHash)"
    );
    bytes32 public constant DUST_SWEEP_WITNESS_TYPEHASH = keccak256(
        "DustSweepWitness(bytes32 routeHash,address outputToken,address recipient,uint256 minAmountOut,uint256 deadline,uint16 feeBps)"
    );
    string public constant PERMIT2_WITNESS_TYPE_STRING =
        "DustSweepWitness witness)DustSweepWitness(bytes32 routeHash,address outputToken,address recipient,uint256 minAmountOut,uint256 deadline,uint16 feeBps)TokenPermissions(address token,uint256 amount)";

    // ──────────────────────────── Immutables ───────────────────────

    ISignatureTransfer public immutable permit2;
    IWBNB public immutable wbnb;

    // ──────────────────────────── State ────────────────────────────

    uint16 public feeBps;
    address public feeCollector;

    mapping(address => bool) public allowedTargets;
    mapping(address => bool) public allowedSpenders;

    // ──────────────────────────── Events ───────────────────────────

    event DustSwept(
        address indexed user,
        address indexed recipient,
        address indexed outputToken,
        uint256 routeCount,
        uint256 grossAmountOut,
        uint256 feeAmount,
        uint256 netAmountOut
    );
    event RouteExecuted(address indexed tokenIn, address indexed target, address indexed spender, uint256 amountIn);
    event RouteSkipped(address indexed tokenIn, uint256 amountIn, bytes reason);
    event InputRefunded(address indexed token, address indexed to, uint256 amount);
    event RefundFailed(address indexed token, address indexed to, uint256 amount);
    event ProtocolFeePaid(address indexed token, address indexed payer, address indexed collector, uint256 amount);
    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeeCollectorUpdated(address oldCollector, address newCollector);
    event AllowedTargetUpdated(address indexed target, bool allowed);
    event AllowedSpenderUpdated(address indexed spender, bool allowed);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    // ──────────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error EmptyRoutes();
    error BatchTooLarge();
    error DeadlineExpired();
    error FeeTooHigh();
    error FeeCollectorRequired();
    error PermitLengthMismatch();
    error PermitTokenMismatch(uint256 index);
    error PermitAmountMismatch(uint256 index);
    error PermitDeadlineMismatch();
    error TargetNotAllowed(address target);
    error SpenderNotAllowed(address spender);
    error MalformedRouteData(uint256 index);
    error NonZeroValue(uint256 index);
    error NativeInputUnsupported();
    error InsufficientOutput();
    error SwapCallFailed(address target);
    error AmountTooLargeForPermit2Allowance();
    error Permit2AllowanceExpirationTooLarge();
    error NativeTransferFailed();
    error InsufficientHeldBalance();
    error NotSelf();
    error UnauthorizedNativeSender();

    /// @param permit2_      Canonical Permit2 on BSC (same address on every chain): 0x000000000022D473030F116dDEE9F6B43aC78BA3
    /// @param wbnb_         WBNB on BSC: 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
    /// @param owner_        Contract owner (config + pause + rescue).
    /// @param feeCollector_ Address that receives protocol fees.
    /// @param feeBps_       Default fee in bps (<= MAX_FEE_BPS).
    constructor(
        address permit2_,
        address wbnb_,
        address owner_,
        address feeCollector_,
        uint16 feeBps_
    ) Ownable(owner_) {
        if (permit2_ == address(0) || wbnb_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps_ > 0 && feeCollector_ == address(0)) revert FeeCollectorRequired();

        permit2 = ISignatureTransfer(permit2_);
        wbnb = IWBNB(wbnb_);
        feeCollector = feeCollector_;
        feeBps = feeBps_;
    }

    /// @dev Accept BNB only from the WBNB contract (native-output unwraps). Rejecting other
    ///      senders is hygiene only; any force-sent BNB (e.g. selfdestruct) is still recoverable
    ///      via rescueNative, and no logic ever depends on address(this).balance.
    receive() external payable {
        if (msg.sender != address(wbnb)) revert UnauthorizedNativeSender();
    }

    // ──────────────────────────── Entry point ──────────────────────

    /// @notice Sweep a batch of dust tokens into a single output token (ERC-20 or native BNB).
    /// @dev Single entrypoint. `mode` selects how inputs are pulled. In Allowance mode the
    ///      `permit`/`signature` args are ignored and may be empty. Caller-agnostic: only
    ///      `msg.sender` is used, so plain EOAs, EIP-7702 smart accounts, and contract callers
    ///      all work (Permit2 validates EIP-1271 signatures for smart-account signers).
    /// @param mode      Permit2Signature or Allowance.
    /// @param routes    Swap legs; each `tokenIn`/`amountIn` is the single source of truth.
    /// @param params    Output token, recipient, slippage floor, deadline, per-sweep fee override.
    /// @param permit    Permit2 batch permit (Permit2Signature mode only).
    /// @param signature Permit2 signature over the witness (Permit2Signature mode only).
    /// @return grossAmountOut Realized output before fee.
    /// @return feeAmount      Protocol fee taken from gross output.
    /// @return netAmountOut   Output delivered to `recipient`.
    function sweep(
        SweepMode mode,
        SweepRoute[] calldata routes,
        SweepParams calldata params,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256, uint256, uint256) {
        SweepState memory st;
        st.effectiveFeeBps = _resolveFeeBps(params.feeBpsOverride);
        _validateParams(routes, params);

        st.actualOutput =
            params.outputToken == NATIVE_TOKEN_SENTINEL ? address(wbnb) : params.outputToken;
        _validateRoutes(routes, st.actualOutput);

        st.initialOutputBalance = IERC20(st.actualOutput).balanceOf(address(this));
        st.routeCount = routes.length;

        _pullAndExecute(mode, routes, params, st.effectiveFeeBps, st.actualOutput, permit, signature);

        return _settleOutput(st, params);
    }

    /// @dev Snapshot inputs, pull them in (exact amounts), run best-effort swaps, refund leftovers.
    ///      Kept in its own frame so the snapshot arrays do not crowd the entrypoint's stack.
    ///      `actualOutput` is threaded through so passthrough legs (tokenIn == output) skip the
    ///      swap and are NOT refunded (the output token is settled by _settleOutput, not here).
    function _pullAndExecute(
        SweepMode mode,
        SweepRoute[] calldata routes,
        SweepParams calldata params,
        uint16 effectiveFeeBps,
        address actualOutput,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) internal {
        (address[] memory inputTokens, uint256[] memory inputInitial) = _snapshotInputs(routes);

        if (mode == SweepMode.Permit2Signature) {
            _pullInputsWithPermit2(routes, params, effectiveFeeBps, permit, signature);
        } else {
            _pullInputsWithAllowance(routes);
        }

        _executeRoutesBestEffort(routes, params.deadline, actualOutput);
        _refundLeftoverInputs(inputTokens, inputInitial, actualOutput);
    }

    /// @notice Execute one route. External + self-only so the parent can wrap it in try/catch.
    /// @dev Reverting here (failed swap, or fee-on-transfer leaving < amountIn held) rolls back
    ///      every approval made in this frame, so a skipped route leaves NO dangling allowance.
    ///      On success, approvals are explicitly reset to 0 before returning.
    function executeRoute(SweepRoute calldata route, uint256 deadline) external {
        if (msg.sender != address(this)) revert NotSelf();

        IERC20 tokenIn = IERC20(route.tokenIn);

        // Fee-on-transfer / under-delivery guard: never approve more than we actually hold.
        if (tokenIn.balanceOf(address(this)) < route.amountIn) revert InsufficientHeldBalance();

        // Router -> DEX approval == EXACTLY the amount about to be swapped.
        tokenIn.forceApprove(route.spender, 0);
        tokenIn.forceApprove(route.spender, route.amountIn);

        // Uniswap Universal Router / V4 special case: the router pulls via Permit2.
        if (route.spender == address(permit2)) {
            if (route.amountIn > type(uint160).max) revert AmountTooLargeForPermit2Allowance();
            if (deadline > type(uint48).max) revert Permit2AllowanceExpirationTooLarge();
            IAllowanceTransfer(address(permit2)).approve(
                route.tokenIn, route.target, uint160(route.amountIn), uint48(deadline)
            );
        }

        (bool success, bytes memory returnData) = route.target.call(route.data);

        // Reset both approval rails to 0 regardless of swap outcome.
        if (route.spender == address(permit2)) {
            IAllowanceTransfer(address(permit2)).approve(route.tokenIn, route.target, 0, uint48(block.timestamp));
        }
        tokenIn.forceApprove(route.spender, 0);

        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            }
            revert SwapCallFailed(route.target);
        }
    }

    // ──────────────────────────── Internal: validation ─────────────

    function _resolveFeeBps(uint16 feeBpsOverride) internal view returns (uint16 effectiveFeeBps) {
        effectiveFeeBps = feeBpsOverride == FEE_OVERRIDE_SENTINEL ? feeBps : feeBpsOverride;
        if (effectiveFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
    }

    function _validateParams(SweepRoute[] calldata routes, SweepParams calldata params) internal view {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (routes.length == 0) revert EmptyRoutes();
        if (routes.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (params.outputToken == address(0) || params.recipient == address(0)) revert ZeroAddress();
    }

    function _validateRoutes(SweepRoute[] calldata routes, address actualOutput) internal view {
        for (uint256 i; i < routes.length;) {
            SweepRoute calldata route = routes[i];

            if (route.tokenIn == address(0)) revert ZeroAddress();
            if (route.tokenIn == NATIVE_TOKEN_SENTINEL) revert NativeInputUnsupported();
            if (route.amountIn == 0) revert ZeroAmount();
            if (route.value != 0) revert NonZeroValue(i);

            // PASSTHROUGH LEG: the input already IS the settlement token (e.g. WBNB swept into
            // native BNB, since actualOutput == WBNB; or the output ERC-20 itself included as dust).
            // Nothing is swapped — the pulled tokens settle directly as output — so target/spender/
            // data are unused and are NOT allowlist-checked. This is safe: only the user's own
            // tokens move, straight from `msg.sender` into the output pool and back to `recipient`
            // (minus fee); no external `target.call` is ever made for these legs.
            if (route.tokenIn == actualOutput) {
                unchecked {
                    ++i;
                }
                continue;
            }

            if (route.target == address(0) || route.spender == address(0)) revert ZeroAddress();
            if (route.data.length < 4) revert MalformedRouteData(i);
            if (!allowedTargets[route.target]) revert TargetNotAllowed(route.target);
            if (!allowedSpenders[route.spender]) revert SpenderNotAllowed(route.spender);

            unchecked {
                ++i;
            }
        }
    }

    function _validatePermit(
        SweepRoute[] calldata routes,
        SweepParams calldata params,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit
    ) internal pure {
        if (permit.deadline != params.deadline) revert PermitDeadlineMismatch();
        if (permit.permitted.length != routes.length) revert PermitLengthMismatch();

        for (uint256 i; i < routes.length;) {
            if (permit.permitted[i].token != routes[i].tokenIn) revert PermitTokenMismatch(i);
            if (permit.permitted[i].amount != routes[i].amountIn) revert PermitAmountMismatch(i);
            unchecked {
                ++i;
            }
        }
    }

    // ──────────────────────────── Internal: input pulls ────────────

    function _pullInputsWithPermit2(
        SweepRoute[] calldata routes,
        SweepParams calldata params,
        uint16 effectiveFeeBps,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) internal {
        _validatePermit(routes, params, permit);

        ISignatureTransfer.SignatureTransferDetails[] memory transferDetails =
            new ISignatureTransfer.SignatureTransferDetails[](routes.length);
        for (uint256 i; i < routes.length;) {
            transferDetails[i] = ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: routes[i].amountIn // EXACTLY route.amountIn
            });
            unchecked {
                ++i;
            }
        }

        bytes32 witness = hashSweepWitness(
            hashRoutes(routes),
            params.outputToken,
            params.recipient,
            params.minAmountOut,
            params.deadline,
            effectiveFeeBps
        );

        permit2.permitWitnessTransferFrom(
            permit, transferDetails, msg.sender, witness, PERMIT2_WITNESS_TYPE_STRING, signature
        );
    }

    function _pullInputsWithAllowance(SweepRoute[] calldata routes) internal {
        for (uint256 i; i < routes.length;) {
            // Pull EXACTLY route.amountIn; the wallet's approval must match this exactly.
            IERC20(routes[i].tokenIn).safeTransferFrom(msg.sender, address(this), routes[i].amountIn);
            unchecked {
                ++i;
            }
        }
    }

    // ──────────────────────────── Internal: execution ──────────────

    function _executeRoutesBestEffort(SweepRoute[] calldata routes, uint256 deadline, address actualOutput)
        internal
    {
        for (uint256 i; i < routes.length;) {
            SweepRoute calldata route = routes[i];

            if (route.tokenIn == actualOutput) {
                // Passthrough: the pulled tokens are already in the output denomination (e.g. WBNB
                // for a native-BNB sweep). No swap, no external call — they simply stay in the
                // router and settle as output in _settleOutput (which unwraps WBNB -> BNB on native
                // output). Emit with target/spender == tokenIn so the leg is still observable.
                emit RouteExecuted(route.tokenIn, route.tokenIn, route.tokenIn, route.amountIn);
            } else {
                try this.executeRoute(route, deadline) {
                    emit RouteExecuted(route.tokenIn, route.target, route.spender, route.amountIn);
                } catch (bytes memory reason) {
                    // Best-effort: skip the failed leg. Its tokenIn stays in the router and is
                    // returned to the user by _refundLeftoverInputs — never stranded, never reverted.
                    emit RouteSkipped(route.tokenIn, route.amountIn, reason);
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    // ──────────────────────────── Internal: refunds & settle ───────

    /// @dev Snapshot unique input-token balances BEFORE pulling, so leftover refunds only return
    ///      what this sweep brought in (and any pre-existing stuck balance is left for rescue()).
    function _snapshotInputs(SweepRoute[] calldata routes)
        internal
        view
        returns (address[] memory tokens, uint256[] memory initialBalances)
    {
        tokens = new address[](routes.length);
        initialBalances = new uint256[](routes.length);
        uint256 count;

        for (uint256 i; i < routes.length;) {
            address token = routes[i].tokenIn;
            bool seen;
            for (uint256 j; j < count;) {
                if (tokens[j] == token) {
                    seen = true;
                    break;
                }
                unchecked {
                    ++j;
                }
            }
            if (!seen) {
                tokens[count] = token;
                initialBalances[count] = IERC20(token).balanceOf(address(this));
                unchecked {
                    ++count;
                }
            }
            unchecked {
                ++i;
            }
        }

        // Trim to unique count.
        assembly {
            mstore(tokens, count)
            mstore(initialBalances, count)
        }
    }

    /// @dev Return any input tokens not consumed by swaps (failed legs, fee-on-transfer skips,
    ///      router refunds) back to the user. Best-effort so one weird token can't brick the batch.
    ///      The output token is NEVER refunded here: its whole balance is settled by _settleOutput
    ///      (gross - fee -> recipient). Skipping it is what lets a passthrough leg (tokenIn ==
    ///      output) be delivered as output instead of being handed back to the user.
    function _refundLeftoverInputs(
        address[] memory tokens,
        uint256[] memory initialBalances,
        address actualOutput
    ) internal {
        for (uint256 i; i < tokens.length;) {
            if (tokens[i] == actualOutput) {
                unchecked {
                    ++i;
                }
                continue;
            }
            uint256 current = IERC20(tokens[i]).balanceOf(address(this));
            if (current > initialBalances[i]) {
                uint256 refund = current - initialBalances[i];
                (bool ok, bytes memory ret) = tokens[i].call(
                    abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, refund)
                );
                // A compliant transfer returns nothing or 32 bytes == true. Never abi.decode a
                // short (1-31 byte) return: that itself reverts and would brick the whole sweep,
                // defeating best-effort. Treat anything non-compliant as a failed refund instead.
                bool refunded = ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
                if (refunded) {
                    emit InputRefunded(tokens[i], msg.sender, refund);
                } else {
                    // Leave it for rescue() rather than reverting the whole sweep.
                    emit RefundFailed(tokens[i], msg.sender, refund);
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    function _settleOutput(SweepState memory st, SweepParams calldata params)
        internal
        returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut)
    {
        grossAmountOut = IERC20(st.actualOutput).balanceOf(address(this)) - st.initialOutputBalance;
        if (grossAmountOut < params.minAmountOut) revert InsufficientOutput();

        feeAmount = (grossAmountOut * st.effectiveFeeBps) / BPS_DENOMINATOR;
        netAmountOut = grossAmountOut - feeAmount;

        if (feeAmount > 0) {
            address collector = feeCollector;
            if (collector == address(0)) revert FeeCollectorRequired();
            IERC20(st.actualOutput).safeTransfer(collector, feeAmount);
            emit ProtocolFeePaid(params.outputToken, msg.sender, collector, feeAmount);
        }

        if (params.outputToken == NATIVE_TOKEN_SENTINEL) {
            wbnb.withdraw(netAmountOut);
            (bool success,) = params.recipient.call{value: netAmountOut}("");
            if (!success) revert NativeTransferFailed();
        } else {
            IERC20(st.actualOutput).safeTransfer(params.recipient, netAmountOut);
        }

        emit DustSwept(
            msg.sender,
            params.recipient,
            params.outputToken,
            st.routeCount,
            grossAmountOut,
            feeAmount,
            netAmountOut
        );
    }

    // ──────────────────────────── Witness hashing ──────────────────

    /// @notice Hash the route array for witness binding (order-sensitive).
    function hashRoutes(SweepRoute[] calldata routes) public pure returns (bytes32 routeHash) {
        bytes32[] memory routeHashes = new bytes32[](routes.length);
        for (uint256 i; i < routes.length;) {
            SweepRoute calldata route = routes[i];
            routeHashes[i] = keccak256(
                abi.encode(
                    SWEEP_ROUTE_TYPEHASH,
                    route.tokenIn,
                    route.amountIn,
                    route.target,
                    route.spender,
                    route.value,
                    keccak256(route.data)
                )
            );
            unchecked {
                ++i;
            }
        }
        routeHash = keccak256(abi.encodePacked(routeHashes));
    }

    /// @notice Hash the Permit2 witness the user signs. Binds routes, output, recipient,
    ///         slippage floor, deadline AND the effective fee the user will pay.
    function hashSweepWitness(
        bytes32 routeHash,
        address outputToken,
        address recipient,
        uint256 minAmountOut,
        uint256 deadline,
        uint16 feeBps_
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DUST_SWEEP_WITNESS_TYPEHASH, routeHash, outputToken, recipient, minAmountOut, deadline, feeBps_
            )
        );
    }

    // ──────────────────────────── Admin ────────────────────────────

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (newFeeBps > 0 && feeCollector == address(0)) revert FeeCollectorRequired();
        uint16 oldFeeBps = feeBps;
        feeBps = newFeeBps;
        emit FeeBpsUpdated(oldFeeBps, newFeeBps);
    }

    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0) && feeBps > 0) revert FeeCollectorRequired();
        address oldCollector = feeCollector;
        feeCollector = newCollector;
        emit FeeCollectorUpdated(oldCollector, newCollector);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedTargets[target] = allowed;
        emit AllowedTargetUpdated(target, allowed);
    }

    function setAllowedSpender(address spender, bool allowed) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        allowedSpenders[spender] = allowed;
        emit AllowedSpenderUpdated(spender, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Rescued(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool success,) = to.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
        emit NativeRescued(to, amount);
    }
}
