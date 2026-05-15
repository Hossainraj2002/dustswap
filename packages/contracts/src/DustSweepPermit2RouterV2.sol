// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title DustSweepPermit2RouterV2
/// @notice Permit2-powered ERC-20 dust sweep router with allowlisted swap targets.
/// @dev Fees are paid immediately from final output token delta. Rescue functions are
///      only for accidental stuck funds and are blocked by the nonReentrant guard.
contract DustSweepPermit2RouterV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SweepRoute {
        address tokenIn;
        uint256 amountIn;
        address target;
        address spender;
        uint256 value;
        bytes data;
    }

    struct SweepParams {
        address outputToken;
        address receiver;
        uint256 minAmountOut;
        uint256 deadline;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint16 public constant MAX_FEE_BPS = 300;
    address public constant NATIVE_TOKEN_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    bytes32 public constant SWEEP_ROUTE_TYPEHASH =
        keccak256("SweepRoute(address tokenIn,uint256 amountIn,address target,address spender,uint256 value,bytes32 dataHash)");
    bytes32 public constant DUST_SWEEP_WITNESS_TYPEHASH =
        keccak256("DustSweepWitness(bytes32 routeHash,address outputToken,address receiver,uint256 minAmountOut,uint256 deadline)");
    string public constant PERMIT2_WITNESS_TYPE_STRING =
        "DustSweepWitness witness)DustSweepWitness(bytes32 routeHash,address outputToken,address receiver,uint256 minAmountOut,uint256 deadline)TokenPermissions(address token,uint256 amount)";

    ISignatureTransfer public immutable permit2;

    uint16 public feeBps;
    address public feeCollector;

    mapping(address => bool) public allowedTargets;
    mapping(address => bool) public allowedSpenders;

    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeeCollectorUpdated(address oldCollector, address newCollector);
    event ProtocolFeePaid(address indexed token, address indexed payer, address indexed collector, uint256 amount);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);
    event AllowedTargetUpdated(address indexed target, bool allowed);
    event AllowedSpenderUpdated(address indexed spender, bool allowed);
    event DustSweepExecuted(
        address indexed user,
        address indexed receiver,
        address indexed outputToken,
        uint256 routeCount,
        uint256 grossAmountOut,
        uint256 feeAmount,
        uint256 netAmountOut
    );
    event RouteExecuted(address indexed tokenIn, address indexed target, address indexed spender, uint256 amountIn);

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
    error NativeInputUnsupported();
    error InvalidMsgValue();
    error InsufficientOutput();
    error SwapCallFailed(address target);
    error AmountTooLargeForPermit2Allowance();
    error Permit2AllowanceExpirationTooLarge();

    constructor(
        address _permit2,
        address _owner,
        address _feeCollector,
        uint16 _feeBps
    ) Ownable(_owner) {
        if (_permit2 == address(0) || _owner == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (_feeBps > 0 && _feeCollector == address(0)) revert FeeCollectorRequired();

        permit2 = ISignatureTransfer(_permit2);
        feeCollector = _feeCollector;
        feeBps = _feeBps;
    }

    receive() external payable {}

    function sweepWithPermit2(
        SweepRoute[] calldata routes,
        address outputToken,
        address receiver,
        uint256 minAmountOut,
        uint256 deadline,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    )
        external
        payable
        nonReentrant
        returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut)
    {
        SweepParams memory params = SweepParams({
            outputToken: outputToken,
            receiver: receiver,
            minAmountOut: minAmountOut,
            deadline: deadline
        });

        _validateSweepParams(routes, params, permit.deadline);

        uint256 initialOutputBalance = IERC20(params.outputToken).balanceOf(address(this));

        _validateRoutesAndPermit(routes, params.outputToken, permit);
        _pullInputsWithPermit2(routes, params, permit, signature);
        _executeRoutes(routes, params.deadline);

        return _settleOutput(routes.length, params, initialOutputBalance);
    }

    function _validateSweepParams(
        SweepRoute[] calldata routes,
        SweepParams memory params,
        uint256 permitDeadline
    ) internal view {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (routes.length == 0) revert EmptyRoutes();
        if (routes.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (params.outputToken == address(0) || params.receiver == address(0)) revert ZeroAddress();
        if (params.outputToken == NATIVE_TOKEN_SENTINEL) revert NativeInputUnsupported();
        if (permitDeadline != params.deadline) revert PermitDeadlineMismatch();
    }

    function _pullInputsWithPermit2(
        SweepRoute[] calldata routes,
        SweepParams memory params,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) internal {
        ISignatureTransfer.SignatureTransferDetails[] memory transferDetails =
            _buildTransferDetails(routes);
        bytes32 witness = hashSweepWitness(
            hashRoutes(routes),
            params.outputToken,
            params.receiver,
            params.minAmountOut,
            params.deadline
        );

        permit2.permitWitnessTransferFrom(
            permit,
            transferDetails,
            msg.sender,
            witness,
            PERMIT2_WITNESS_TYPE_STRING,
            signature
        );
    }

    function _buildTransferDetails(
        SweepRoute[] calldata routes
    ) internal view returns (ISignatureTransfer.SignatureTransferDetails[] memory transferDetails) {
        transferDetails = new ISignatureTransfer.SignatureTransferDetails[](routes.length);
        for (uint256 i; i < routes.length;) {
            transferDetails[i] = ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: routes[i].amountIn
            });

            unchecked {
                ++i;
            }
        }
    }

    function _settleOutput(
        uint256 routeCount,
        SweepParams memory params,
        uint256 initialOutputBalance
    ) internal returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut) {
        grossAmountOut = IERC20(params.outputToken).balanceOf(address(this)) - initialOutputBalance;
        if (grossAmountOut < params.minAmountOut) revert InsufficientOutput();

        feeAmount = (grossAmountOut * feeBps) / BPS_DENOMINATOR;
        netAmountOut = grossAmountOut - feeAmount;

        if (feeAmount > 0) {
            address collector = feeCollector;
            if (collector == address(0)) revert FeeCollectorRequired();
            IERC20(params.outputToken).safeTransfer(collector, feeAmount);
            emit ProtocolFeePaid(params.outputToken, msg.sender, collector, feeAmount);
        }

        IERC20(params.outputToken).safeTransfer(params.receiver, netAmountOut);

        emit DustSweepExecuted(
            msg.sender,
            params.receiver,
            params.outputToken,
            routeCount,
            grossAmountOut,
            feeAmount,
            netAmountOut
        );
    }

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
        if (!success) revert SwapCallFailed(to);
        emit NativeRescued(to, amount);
    }

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

    function hashSweepWitness(
        bytes32 routeHash,
        address outputToken,
        address receiver,
        uint256 minAmountOut,
        uint256 deadline
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DUST_SWEEP_WITNESS_TYPEHASH,
                routeHash,
                outputToken,
                receiver,
                minAmountOut,
                deadline
            )
        );
    }

    function _validateRoutesAndPermit(
        SweepRoute[] calldata routes,
        address outputToken,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit
    ) internal view {
        if (permit.permitted.length != routes.length) revert PermitLengthMismatch();

        uint256 totalValue;
        for (uint256 i; i < routes.length;) {
            SweepRoute calldata route = routes[i];

            if (route.tokenIn == address(0) || route.target == address(0) || route.spender == address(0)) {
                revert ZeroAddress();
            }
            if (route.tokenIn == NATIVE_TOKEN_SENTINEL) revert NativeInputUnsupported();
            if (route.tokenIn == outputToken) revert MalformedRouteData(i);
            if (route.amountIn == 0) revert ZeroAmount();
            if (route.data.length < 4) revert MalformedRouteData(i);
            if (!allowedTargets[route.target]) revert TargetNotAllowed(route.target);
            if (!allowedSpenders[route.spender]) revert SpenderNotAllowed(route.spender);
            if (permit.permitted[i].token != route.tokenIn) revert PermitTokenMismatch(i);
            if (permit.permitted[i].amount != route.amountIn) revert PermitAmountMismatch(i);

            totalValue += route.value;

            unchecked {
                ++i;
            }
        }

        if (msg.value != totalValue) revert InvalidMsgValue();
    }

    function _executeRoutes(SweepRoute[] calldata routes, uint256 deadline) internal {
        for (uint256 i; i < routes.length;) {
            SweepRoute calldata route = routes[i];
            IERC20 tokenIn = IERC20(route.tokenIn);

            tokenIn.forceApprove(route.spender, 0);
            tokenIn.forceApprove(route.spender, route.amountIn);

            if (route.spender == address(permit2)) {
                if (route.amountIn > type(uint160).max) revert AmountTooLargeForPermit2Allowance();
                if (deadline > type(uint48).max) revert Permit2AllowanceExpirationTooLarge();
                IAllowanceTransfer(address(permit2)).approve(
                    route.tokenIn,
                    route.target,
                    uint160(route.amountIn),
                    uint48(deadline)
                );
            }

            (bool success, bytes memory returnData) = route.target.call{value: route.value}(route.data);

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

            emit RouteExecuted(route.tokenIn, route.target, route.spender, route.amountIn);

            unchecked {
                ++i;
            }
        }
    }
}
