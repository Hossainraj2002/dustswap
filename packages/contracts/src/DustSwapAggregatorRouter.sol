// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IDustSwapPermit2SignatureTransfer {
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

    function permitTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

interface IDustSwapPermit2AllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title DustSwapAggregatorRouter
/// @notice Direct-DEX aggregation router for DustSwap `/swapown` swaps.
/// @dev Route calldata must settle output tokens back to this contract. The contract
///      then applies DustSwap fees/referrals and sends net outputs to the receiver.
contract DustSwapAggregatorRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct RouteCall {
        address tokenIn;
        uint256 amountIn;
        address target;
        address spender;
        uint256 value;
        bytes data;
    }

    struct Output {
        address token;
        uint256 minAmountOut;
    }

    struct SwapParams {
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 minAmountOut;
        address receiver;
        uint256 deadline;
        bytes32 referralCode;
    }

    struct BasketParams {
        Output[] outputs;
        address receiver;
        uint256 deadline;
        bytes32 referralCode;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant REFERRAL_SHARE_BPS = 8_000;
    uint256 public constant MAX_FEE_BPS = 300;
    uint256 public constant MAX_INPUT_TOKENS = 6;
    uint256 public constant MAX_OUTPUT_TOKENS = 6;
    uint256 public constant MAX_ROUTE_CALLS = 36;
    address public constant NATIVE_TOKEN_SENTINEL =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    string public constant AGGREGATOR_NAME = "DustSwap";
    string public constant LOGO_URI = "logo.png";

    IDustSwapPermit2SignatureTransfer public immutable permit2;

    uint16 public feeBps;
    address public feeCollector;

    mapping(address => bool) public allowedTargets;
    mapping(address => bool) public allowedSpenders;
    mapping(bytes32 => address) public referralRecipients;

    event DustSwapSwap(
        address indexed user,
        address indexed receiver,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 grossAmountOut,
        uint256 netAmountOut,
        uint256 feeAmount,
        bytes32 referralCode,
        address referrer,
        string aggregatorName,
        string logoURI
    );
    event DustSwapBasketSwap(
        address indexed user,
        address indexed receiver,
        uint256 inputCount,
        uint256 outputCount,
        uint256 routeCount,
        bytes32 referralCode
    );
    event DustSwapRouteExecuted(
        address indexed tokenIn,
        address indexed target,
        address indexed spender,
        uint256 amountIn
    );
    event DustSwapProtocolFeePaid(
        address indexed token,
        address indexed collector,
        uint256 amount
    );
    event DustSwapReferralFeePaid(
        bytes32 indexed referralCode,
        address indexed referrer,
        address indexed token,
        uint256 amount
    );
    event AllowedTargetUpdated(address indexed target, bool allowed);
    event AllowedSpenderUpdated(address indexed spender, bool allowed);
    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event ReferralRecipientUpdated(bytes32 indexed referralCode, address indexed recipient);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error EmptyRoutes();
    error EmptyOutputs();
    error TooManyRoutes();
    error TooManyInputs();
    error TooManyOutputs();
    error DeadlineExpired();
    error FeeTooHigh();
    error FeeCollectorRequired();
    error NativeInputUnsupported();
    error InvalidMsgValue();
    error TargetNotAllowed(address target);
    error SpenderNotAllowed(address spender);
    error MalformedRoute(uint256 index);
    error DuplicateOutput(address token);
    error SingleSwapInputMismatch();
    error PermitLengthMismatch();
    error PermitTokenMismatch(uint256 index);
    error PermitAmountMismatch(uint256 index);
    error AmountTooLargeForPermit2Allowance();
    error Permit2AllowanceExpirationTooLarge();
    error SwapCallFailed(address target);
    error InsufficientOutput(address token, uint256 actual, uint256 minimum);

    constructor(
        address _permit2,
        address _owner,
        address _feeCollector,
        uint16 _feeBps
    ) Ownable(_owner) {
        if (_permit2 == address(0) || _owner == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (_feeBps > 0 && _feeCollector == address(0)) revert FeeCollectorRequired();

        permit2 = IDustSwapPermit2SignatureTransfer(_permit2);
        feeCollector = _feeCollector;
        feeBps = _feeBps;
    }

    receive() external payable {}

    /// @notice Execute a single-input, single-output DustSwap route using ERC-20 allowances.
    function swap(
        RouteCall[] calldata routes,
        SwapParams calldata params
    ) external payable nonReentrant returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut) {
        _validateSingleSwap(routes, params);
        Output[] memory outputs = new Output[](1);
        outputs[0] = Output({token: params.tokenOut, minAmountOut: params.minAmountOut});
        uint256[] memory initialBalances = _snapshotOutputs(outputs);

        _pullInputsWithAllowance(routes);
        _executeRoutes(routes, params.deadline);
        (grossAmountOut, feeAmount, netAmountOut) = _settleOutput(
            outputs[0],
            initialBalances[0],
            params.receiver,
            params.referralCode
        );

        _emitSingleSwap(params, grossAmountOut, feeAmount, netAmountOut);
    }

    /// @notice Execute a single-input, single-output DustSwap route using Permit2.
    function swapWithPermit2(
        RouteCall[] calldata routes,
        SwapParams calldata params,
        IDustSwapPermit2SignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) external payable nonReentrant returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut) {
        _validateSingleSwap(routes, params);
        _validatePermit(routes, permit);
        Output[] memory outputs = new Output[](1);
        outputs[0] = Output({token: params.tokenOut, minAmountOut: params.minAmountOut});
        uint256[] memory initialBalances = _snapshotOutputs(outputs);

        _pullInputsWithPermit2(routes, permit, signature);
        _executeRoutes(routes, params.deadline);
        (grossAmountOut, feeAmount, netAmountOut) = _settleOutput(
            outputs[0],
            initialBalances[0],
            params.receiver,
            params.referralCode
        );

        _emitSingleSwap(params, grossAmountOut, feeAmount, netAmountOut);
    }

    /// @notice Execute up to 6 input tokens into up to 6 output tokens using ERC-20 allowances.
    function swapBasket(
        RouteCall[] calldata routes,
        BasketParams calldata params
    ) external payable nonReentrant returns (uint256[] memory grossAmountsOut, uint256[] memory netAmountsOut) {
        Output[] memory outputs = _copyOutputs(params.outputs);
        _validateBasket(routes, params.receiver, params.deadline, outputs);
        uint256[] memory initialBalances = _snapshotOutputs(outputs);

        _pullInputsWithAllowance(routes);
        _executeRoutes(routes, params.deadline);
        (grossAmountsOut, netAmountsOut) = _settleOutputs(outputs, initialBalances, params.receiver, params.referralCode);

        _emitBasketOutputSwaps(routes, outputs, grossAmountsOut, netAmountsOut, params.receiver, params.referralCode);

        emit DustSwapBasketSwap(
            msg.sender,
            params.receiver,
            _countInputTokens(routes),
            outputs.length,
            routes.length,
            params.referralCode
        );
    }

    /// @notice Execute up to 6 input tokens into up to 6 output tokens using Permit2.
    function swapBasketWithPermit2(
        RouteCall[] calldata routes,
        BasketParams calldata params,
        IDustSwapPermit2SignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) external payable nonReentrant returns (uint256[] memory grossAmountsOut, uint256[] memory netAmountsOut) {
        Output[] memory outputs = _copyOutputs(params.outputs);
        _validateBasket(routes, params.receiver, params.deadline, outputs);
        _validatePermit(routes, permit);
        uint256[] memory initialBalances = _snapshotOutputs(outputs);

        _pullInputsWithPermit2(routes, permit, signature);
        _executeRoutes(routes, params.deadline);
        (grossAmountsOut, netAmountsOut) = _settleOutputs(outputs, initialBalances, params.receiver, params.referralCode);

        _emitBasketOutputSwaps(routes, outputs, grossAmountsOut, netAmountsOut, params.receiver, params.referralCode);

        emit DustSwapBasketSwap(
            msg.sender,
            params.receiver,
            _countInputTokens(routes),
            outputs.length,
            routes.length,
            params.referralCode
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

    function setReferralRecipient(bytes32 referralCode, address recipient) external onlyOwner {
        referralRecipients[referralCode] = recipient;
        emit ReferralRecipientUpdated(referralCode, recipient);
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

    function _validateSingleSwap(RouteCall[] calldata routes, SwapParams calldata params) internal view {
        Output[] memory outputs = new Output[](1);
        outputs[0] = Output({token: params.tokenOut, minAmountOut: params.minAmountOut});
        _validateCommon(routes, params.receiver, params.deadline, outputs);
        if (params.tokenIn == address(0) || params.tokenIn == NATIVE_TOKEN_SENTINEL || params.tokenOut == address(0)) {
            revert ZeroAddress();
        }
        if (params.amountIn == 0 || params.minAmountOut == 0) revert ZeroAmount();

        uint256 totalAmountIn;
        for (uint256 i; i < routes.length;) {
            if (routes[i].tokenIn != params.tokenIn) revert SingleSwapInputMismatch();
            totalAmountIn += routes[i].amountIn;
            unchecked {
                ++i;
            }
        }

        if (totalAmountIn != params.amountIn) revert SingleSwapInputMismatch();
    }

    function _validateBasket(
        RouteCall[] calldata routes,
        address receiver,
        uint256 deadline,
        Output[] memory outputs
    ) internal view {
        _validateCommon(routes, receiver, deadline, outputs);
        if (_countInputTokens(routes) > MAX_INPUT_TOKENS) revert TooManyInputs();
    }

    function _copyOutputs(Output[] calldata outputs) internal pure returns (Output[] memory copied) {
        copied = new Output[](outputs.length);
        for (uint256 i; i < outputs.length;) {
            copied[i] = Output({token: outputs[i].token, minAmountOut: outputs[i].minAmountOut});
            unchecked {
                ++i;
            }
        }
    }

    function _validateCommon(
        RouteCall[] calldata routes,
        address receiver,
        uint256 deadline,
        Output[] memory outputs
    ) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (receiver == address(0)) revert ZeroAddress();
        if (routes.length == 0) revert EmptyRoutes();
        if (routes.length > MAX_ROUTE_CALLS) revert TooManyRoutes();
        if (outputs.length == 0) revert EmptyOutputs();
        if (outputs.length > MAX_OUTPUT_TOKENS) revert TooManyOutputs();
        _validateOutputs(outputs);
        _validateRoutes(routes);
    }

    function _validateOutputs(Output[] memory outputs) internal pure {
        for (uint256 i; i < outputs.length;) {
            if (outputs[i].token == address(0) || outputs[i].token == NATIVE_TOKEN_SENTINEL) {
                revert ZeroAddress();
            }
            if (outputs[i].minAmountOut == 0) revert ZeroAmount();

            for (uint256 j = i + 1; j < outputs.length;) {
                if (outputs[j].token == outputs[i].token) revert DuplicateOutput(outputs[i].token);
                unchecked {
                    ++j;
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    function _validateRoutes(RouteCall[] calldata routes) internal view {
        uint256 totalValue;
        for (uint256 i; i < routes.length;) {
            RouteCall calldata route = routes[i];
            if (
                route.tokenIn == address(0) ||
                route.target == address(0) ||
                route.spender == address(0) ||
                route.data.length < 4
            ) {
                revert MalformedRoute(i);
            }
            if (route.tokenIn == NATIVE_TOKEN_SENTINEL) revert NativeInputUnsupported();
            if (route.amountIn == 0) revert ZeroAmount();
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
        RouteCall[] calldata routes,
        IDustSwapPermit2SignatureTransfer.PermitBatchTransferFrom calldata permit
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

    function _pullInputsWithAllowance(RouteCall[] calldata routes) internal {
        for (uint256 i; i < routes.length;) {
            IERC20(routes[i].tokenIn).safeTransferFrom(msg.sender, address(this), routes[i].amountIn);
            unchecked {
                ++i;
            }
        }
    }

    function _pullInputsWithPermit2(
        RouteCall[] calldata routes,
        IDustSwapPermit2SignatureTransfer.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) internal {
        IDustSwapPermit2SignatureTransfer.SignatureTransferDetails[] memory transferDetails =
            new IDustSwapPermit2SignatureTransfer.SignatureTransferDetails[](routes.length);
        for (uint256 i; i < routes.length;) {
            transferDetails[i] = IDustSwapPermit2SignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: routes[i].amountIn
            });
            unchecked {
                ++i;
            }
        }

        permit2.permitTransferFrom(permit, transferDetails, msg.sender, signature);
    }

    function _executeRoutes(RouteCall[] calldata routes, uint256 deadline) internal {
        for (uint256 i; i < routes.length;) {
            RouteCall calldata route = routes[i];
            IERC20 tokenIn = IERC20(route.tokenIn);

            tokenIn.forceApprove(route.spender, 0);
            tokenIn.forceApprove(route.spender, route.amountIn);

            if (route.spender == address(permit2)) {
                if (route.amountIn > type(uint160).max) revert AmountTooLargeForPermit2Allowance();
                if (deadline > type(uint48).max) revert Permit2AllowanceExpirationTooLarge();
                IDustSwapPermit2AllowanceTransfer(address(permit2)).approve(
                    route.tokenIn,
                    route.target,
                    uint160(route.amountIn),
                    uint48(deadline)
                );
            }

            (bool success, bytes memory returnData) = route.target.call{value: route.value}(route.data);

            if (route.spender == address(permit2)) {
                IDustSwapPermit2AllowanceTransfer(address(permit2)).approve(route.tokenIn, route.target, 0, uint48(block.timestamp));
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

            emit DustSwapRouteExecuted(route.tokenIn, route.target, route.spender, route.amountIn);
            unchecked {
                ++i;
            }
        }
    }

    function _snapshotOutputs(Output[] memory outputs) internal view returns (uint256[] memory balances) {
        balances = new uint256[](outputs.length);
        for (uint256 i; i < outputs.length;) {
            balances[i] = IERC20(outputs[i].token).balanceOf(address(this));
            unchecked {
                ++i;
            }
        }
    }

    function _settleOutputs(
        Output[] memory outputs,
        uint256[] memory initialBalances,
        address receiver,
        bytes32 referralCode
    ) internal returns (uint256[] memory grossAmountsOut, uint256[] memory netAmountsOut) {
        grossAmountsOut = new uint256[](outputs.length);
        netAmountsOut = new uint256[](outputs.length);

        for (uint256 i; i < outputs.length;) {
            (uint256 grossAmountOut,, uint256 netAmountOut) =
                _settleOutput(outputs[i], initialBalances[i], receiver, referralCode);
            grossAmountsOut[i] = grossAmountOut;
            netAmountsOut[i] = netAmountOut;
            unchecked {
                ++i;
            }
        }
    }

    function _settleOutput(
        Output memory output,
        uint256 initialBalance,
        address receiver,
        bytes32 referralCode
    ) internal returns (uint256 grossAmountOut, uint256 feeAmount, uint256 netAmountOut) {
        grossAmountOut = IERC20(output.token).balanceOf(address(this)) - initialBalance;
        if (grossAmountOut < output.minAmountOut) {
            revert InsufficientOutput(output.token, grossAmountOut, output.minAmountOut);
        }

        feeAmount = (grossAmountOut * feeBps) / BPS_DENOMINATOR;
        netAmountOut = grossAmountOut - feeAmount;
        (uint256 protocolFee, uint256 referralFee, address referrer) =
            _splitFee(referralCode, feeAmount);

        if (protocolFee > 0) {
            address collector = feeCollector;
            if (collector == address(0)) revert FeeCollectorRequired();
            IERC20(output.token).safeTransfer(collector, protocolFee);
            emit DustSwapProtocolFeePaid(output.token, collector, protocolFee);
        }

        if (referralFee > 0) {
            IERC20(output.token).safeTransfer(referrer, referralFee);
            emit DustSwapReferralFeePaid(referralCode, referrer, output.token, referralFee);
        }

        IERC20(output.token).safeTransfer(receiver, netAmountOut);
    }

    function _emitSingleSwap(
        SwapParams calldata params,
        uint256 grossAmountOut,
        uint256 feeAmount,
        uint256 netAmountOut
    ) internal {
        emit DustSwapSwap(
            msg.sender,
            params.receiver,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            grossAmountOut,
            netAmountOut,
            feeAmount,
            params.referralCode,
            referralRecipients[params.referralCode],
            AGGREGATOR_NAME,
            LOGO_URI
        );
    }

    function _emitBasketOutputSwaps(
        RouteCall[] calldata routes,
        Output[] memory outputs,
        uint256[] memory grossAmountsOut,
        uint256[] memory netAmountsOut,
        address receiver,
        bytes32 referralCode
    ) internal {
        address primaryInput = routes[0].tokenIn;
        uint256 totalInputAmount = _totalRouteAmount(routes);
        address referrer = referralRecipients[referralCode];

        for (uint256 i; i < outputs.length;) {
            uint256 grossAmountOut = grossAmountsOut[i];
            uint256 netAmountOut = netAmountsOut[i];
            emit DustSwapSwap(
                msg.sender,
                receiver,
                primaryInput,
                outputs[i].token,
                totalInputAmount,
                grossAmountOut,
                netAmountOut,
                grossAmountOut - netAmountOut,
                referralCode,
                referrer,
                AGGREGATOR_NAME,
                LOGO_URI
            );

            unchecked {
                ++i;
            }
        }
    }

    function _splitFee(
        bytes32 referralCode,
        uint256 feeAmount
    ) internal view returns (uint256 protocolFee, uint256 referralFee, address referrer) {
        referrer = referralRecipients[referralCode];
        if (feeAmount == 0 || referralCode == bytes32(0) || referrer == address(0)) {
            return (feeAmount, 0, address(0));
        }

        referralFee = (feeAmount * REFERRAL_SHARE_BPS) / BPS_DENOMINATOR;
        protocolFee = feeAmount - referralFee;
    }

    function _countInputTokens(RouteCall[] calldata routes) internal pure returns (uint256 count) {
        address[MAX_INPUT_TOKENS] memory seen;
        for (uint256 i; i < routes.length;) {
            bool found;
            for (uint256 j; j < count;) {
                if (seen[j] == routes[i].tokenIn) {
                    found = true;
                    break;
                }
                unchecked {
                    ++j;
                }
            }

            if (!found) {
                if (count >= MAX_INPUT_TOKENS) revert TooManyInputs();
                seen[count] = routes[i].tokenIn;
                unchecked {
                    ++count;
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    function _totalRouteAmount(RouteCall[] calldata routes) internal pure returns (uint256 totalAmount) {
        for (uint256 i; i < routes.length;) {
            totalAmount += routes[i].amountIn;
            unchecked {
                ++i;
            }
        }
    }
}
