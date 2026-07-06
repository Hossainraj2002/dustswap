// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

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

/// @notice Minimal WETH interface for unwrapping to native ETH on native-output sweeps.
interface IWETH9 {
    function withdraw(uint256 amount) external;
}

/// @title DustSwapSweepRouter (DustSweep V3)
/// @author DustSwap
/// @notice Best-effort, multi-DEX dust sweep router for Base (chainId 8453). Sweeps many small
///         ERC-20 balances into a single output token (ERC-20 or native ETH) using allowlisted
///         swap targets, with hard, per-sweep, exact-amount approvals only.
/// @dev    Brand-new V3 contract. It does NOT replace or interact with DustSweepPermit2RouterV2;
///         the app is switched over by pointing a single config value at this address.
///
///         SECURITY MODEL — APPROVALS (non-negotiable):
///         `route.amountIn` is the single source of truth. The user permits/approves EXACTLY
///         `route.amountIn` per token, the router pulls EXACTLY that, and approves the DEX EXACTLY
///         that amount, resetting to 0 immediately after. No infinite/standing allowance path
///         exists. Fee-on-transfer tokens (where the router would hold < `amountIn`) are skipped
///         and refunded rather than over-approved or failing the whole batch.
contract DustSwapSweepRouter is Ownable, ReentrancyGuard, Pausable {
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
    /// @dev `outputToken` may be a normal ERC-20 or NATIVE_TOKEN_SENTINEL for native ETH.
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
    IWETH9 public immutable weth;

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

    /// @param permit2_      Canonical Permit2 on Base: 0x000000000022D473030F116dDEE9F6B43aC78BA3
    /// @param weth_         WETH on Base: 0x4200000000000000000000000000000000000006
    /// @param owner_        Contract owner (config + pause + rescue).
    /// @param feeCollector_ Address that receives protocol fees.
    /// @param feeBps_       Default fee in bps (<= MAX_FEE_BPS).
    constructor(
        address permit2_,
        address weth_,
        address owner_,
        address feeCollector_,
        uint16 feeBps_
    ) Ownable(owner_) {
        if (permit2_ == address(0) || weth_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps_ > 0 && feeCollector_ == address(0)) revert FeeCollectorRequired();

        permit2 = ISignatureTransfer(permit2_);
        weth = IWETH9(weth_);
        feeCollector = feeCollector_;
        feeBps = feeBps_;
    }

    /// @dev Accept ETH only from the WETH contract (native-output unwraps). Rejecting other
    ///      senders is hygiene only; any force-sent ETH (e.g. selfdestruct) is still recoverable
    ///      via rescueNative, and no logic ever depends on address(this).balance.
    receive() external payable {
        if (msg.sender != address(weth)) revert UnauthorizedNativeSender();
    }

    // ──────────────────────────── Entry point ──────────────────────

    /// @notice Sweep a batch of dust tokens into a single output token (ERC-20 or native ETH).
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
            params.outputToken == NATIVE_TOKEN_SENTINEL ? address(weth) : params.outputToken;
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

            // PASSTHROUGH LEG: the input already IS the settlement token (e.g. WETH swept into
            // native ETH, since actualOutput == WETH; or the output ERC-20 itself included as dust).
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
                // Passthrough: the pulled tokens are already in the output denomination (e.g. WETH
                // for a native-ETH sweep). No swap, no external call — they simply stay in the
                // router and settle as output in _settleOutput (which unwraps WETH -> ETH on native
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
            weth.withdraw(netAmountOut);
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
