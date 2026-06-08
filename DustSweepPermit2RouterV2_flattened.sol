// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

library SafeERC20 {
    error SafeERC20FailedOperation(address token);
    error SafeERC20FailedDecreaseAllowance(address spender, uint256 currentAllowance, uint256 requestedDecrease);

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transfer, (to, value)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transferFrom, (from, to, value)));
    }

    function forceApprove(IERC20 token, address spender, uint256 value) internal {
        bytes memory approvalCall = abi.encodeCall(token.approve, (spender, value));

        if (!_callOptionalReturnBool(token, approvalCall)) {
            _callOptionalReturn(token, abi.encodeCall(token.approve, (spender, 0)));
            _callOptionalReturn(token, approvalCall);
        }
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        (bool success, bytes memory returndata) = address(token).call(data);

        if (!success || (returndata.length != 0 && !abi.decode(returndata, (bool)))) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    function _callOptionalReturnBool(IERC20 token, bytes memory data) private returns (bool) {
        (bool success, bytes memory returndata) = address(token).call(data);
        return success && (returndata.length == 0 || abi.decode(returndata, (bool)));
    }
}

abstract contract Ownable {
    address private _owner;

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(initialOwner);
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    function _checkOwner() internal view virtual {
        if (owner() != msg.sender) revert OwnableUnauthorizedAccount(msg.sender);
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(newOwner);
    }

    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

abstract contract ReentrancyGuard {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == ENTERED) revert ReentrancyGuardReentrantCall();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }
}

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
/// @notice ERC-20 dust sweep router with exact-allowance and Permit2 execution modes.
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

        _validateSweepParams(routes, params);
        if (permit.deadline != params.deadline) revert PermitDeadlineMismatch();

        uint256 initialOutputBalance = IERC20(params.outputToken).balanceOf(address(this));

        _validateRoutes(routes, params.outputToken);
        _validatePermit(routes, permit);
        _pullInputsWithPermit2(routes, params, permit, signature);
        _executeRoutes(routes, params.deadline);

        return _settleOutput(routes.length, params, initialOutputBalance);
    }

    function sweepWithAllowance(
        SweepRoute[] calldata routes,
        address outputToken,
        address receiver,
        uint256 minAmountOut,
        uint256 deadline
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

        _validateSweepParams(routes, params);

        uint256 initialOutputBalance = IERC20(params.outputToken).balanceOf(address(this));

        _validateRoutes(routes, params.outputToken);
        _pullInputsWithAllowance(routes);
        _executeRoutes(routes, params.deadline);

        return _settleOutput(routes.length, params, initialOutputBalance);
    }

    function _validateSweepParams(
        SweepRoute[] calldata routes,
        SweepParams memory params
    ) internal view {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (routes.length == 0) revert EmptyRoutes();
        if (routes.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (params.outputToken == address(0) || params.receiver == address(0)) revert ZeroAddress();
        if (params.outputToken == NATIVE_TOKEN_SENTINEL) revert NativeInputUnsupported();
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

    function _pullInputsWithAllowance(SweepRoute[] calldata routes) internal {
        for (uint256 i; i < routes.length;) {
            IERC20(routes[i].tokenIn).safeTransferFrom(msg.sender, address(this), routes[i].amountIn);

            unchecked {
                ++i;
            }
        }
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

    function _validateRoutes(
        SweepRoute[] calldata routes,
        address outputToken
    ) internal view {
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

            totalValue += route.value;

            unchecked {
                ++i;
            }
        }

        if (msg.value != totalValue) revert InvalidMsgValue();
    }

    function _validatePermit(
        SweepRoute[] calldata routes,
        ISignatureTransfer.PermitBatchTransferFrom calldata permit
    ) internal pure {
        if (permit.permitted.length != routes.length) revert PermitLengthMismatch();

        for (uint256 i; i < routes.length;) {
            if (permit.permitted[i].token != routes[i].tokenIn) revert PermitTokenMismatch(i);
            if (permit.permitted[i].amount != routes[i].amountIn) revert PermitAmountMismatch(i);

            unchecked {
                ++i;
            }
        }
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
