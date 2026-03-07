// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IWETH} from "./interfaces/IWETH.sol";

/// @title DustSweepRouter
/// @notice Batch-swap small "dust" ERC-20 balances into a single output token
///         via Uniswap V3 on Base, with a protocol fee sent to FeeCollector.
contract DustSweepRouter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ──────────────────────── Types ────────────────────────

    struct SwapOrder {
        address tokenIn;
        uint256 amountIn;
        uint24 poolFee;
        uint256 minAmountOut;
    }

    struct MultiHopSwapOrder {
        address tokenIn;
        uint256 amountIn;
        bytes path;
        uint256 minAmountOut;
    }

    // ──────────────────────── Constants ────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_BATCH_SIZE = 10;
    uint256 public constant MAX_DUST_SWEEP_FEE_BPS = 500; // 5 %
    uint256 public constant MAX_SWAP_FEE_BPS = 100; // 1 %
    string public constant BUILDER_CODE = "bc_ox7237gv";

    // ──────────────────────── Immutables ───────────────────
    ISwapRouter02 public immutable swapRouter;
    IWETH public immutable weth;

    // ──────────────────────── State ────────────────────────
    address public feeCollector;
    uint256 public dustSweepFeeBps = 200; // 2 %
    uint256 public swapFeeBps = 10; // 0.1 %

    // ──────────────────────── Events ───────────────────────
    event DustSwept(
        address indexed sender,
        address indexed recipient,
        address indexed tokenOut,
        uint256 totalOutput,
        uint256 feeAmount,
        uint256 orderCount
    );
    event SingleSwap(
        address indexed sender,
        address indexed recipient,
        address indexed tokenOut,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );
    event DustSweepFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event SwapFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event TokensRescued(address indexed token, uint256 amount, address indexed to);

    // ──────────────────────── Errors ───────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error EmptyOrders();
    error BatchTooLarge();
    error FeeTooHigh();
    error SwapFailed();
    error ETHTransferFailed();
    error InsufficientOutput();
    error InvalidTokenOut();
    error DeadlineExpired();

    // ──────────────────────── Constructor ──────────────────
    /// @param _swapRouter   Uniswap V3 SwapRouter02 on Base.
    /// @param _weth         WETH address on Base (0x4200…0006).
    /// @param _feeCollector FeeCollector contract.
    /// @param _owner        Contract owner.
    constructor(
        address _swapRouter,
        address _weth,
        address _feeCollector,
        address _owner
    ) Ownable(_owner) {
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_feeCollector == address(0)) revert ZeroAddress();

        swapRouter = ISwapRouter02(_swapRouter);
        weth = IWETH(_weth);
        feeCollector = _feeCollector;
    }

    // ──────────────────────── Receive (for WETH unwrap) ───
    receive() external payable {}

    // ──────────────────────── Core: Dust Sweep (single-hop) ─

    /// @notice Batch-swap multiple dust tokens into a single ERC-20 tokenOut.
    /// @param orders    Array of SwapOrder structs (max 10).
    /// @param tokenOut  The desired output token.
    /// @param recipient Address that receives the net output.
    /// @param deadline  Unix timestamp after which the transaction reverts.
    function sweepDust(
        SwapOrder[] calldata orders,
        address tokenOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (orders.length == 0) revert EmptyOrders();
        if (orders.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (tokenOut == address(0)) revert InvalidTokenOut();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 totalOutput = _executeBatchSwaps(orders, tokenOut);
        if (totalOutput == 0) revert InsufficientOutput();

        uint256 feeAmount = (totalOutput * dustSweepFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = totalOutput - feeAmount;

        IERC20 outputToken = IERC20(tokenOut);
        if (feeAmount > 0) {
            outputToken.safeTransfer(feeCollector, feeAmount);
        }
        outputToken.safeTransfer(recipient, netOutput);

        emit DustSwept(msg.sender, recipient, tokenOut, totalOutput, feeAmount, orders.length);
    }

    /// @notice Batch-swap multiple dust tokens into ETH (via WETH).
    /// @param orders    Array of SwapOrder structs (max 10).
    /// @param recipient Address that receives the net ETH output.
    /// @param deadline  Unix timestamp after which the transaction reverts.
    function sweepDustToETH(
        SwapOrder[] calldata orders,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (orders.length == 0) revert EmptyOrders();
        if (orders.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (recipient == address(0)) revert ZeroAddress();

        address wethAddr = address(weth);
        uint256 totalOutput = _executeBatchSwaps(orders, wethAddr);
        if (totalOutput == 0) revert InsufficientOutput();

        uint256 feeAmount = (totalOutput * dustSweepFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = totalOutput - feeAmount;

        // Send fee as WETH to feeCollector
        if (feeAmount > 0) {
            IERC20(wethAddr).safeTransfer(feeCollector, feeAmount);
        }

        // Unwrap net WETH → ETH and send to recipient
        weth.withdraw(netOutput);
        (bool success,) = recipient.call{value: netOutput}("");
        if (!success) revert ETHTransferFailed();

        emit DustSwept(msg.sender, recipient, address(0), totalOutput, feeAmount, orders.length);
    }

    // ──────────────────────── Core: Dust Sweep (multi-hop) ─

    /// @notice Batch-swap multiple dust tokens via multi-hop paths into a single ERC-20.
    /// @param orders    Array of MultiHopSwapOrder structs (max 10).
    /// @param tokenOut  The desired output token (must match end of each path).
    /// @param recipient Address that receives the net output.
    /// @param deadline  Unix timestamp after which the transaction reverts.
    function sweepDustMultiHop(
        MultiHopSwapOrder[] calldata orders,
        address tokenOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (orders.length == 0) revert EmptyOrders();
        if (orders.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (tokenOut == address(0)) revert InvalidTokenOut();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 totalOutput = _executeBatchMultiHopSwaps(orders);
        if (totalOutput == 0) revert InsufficientOutput();

        uint256 feeAmount = (totalOutput * dustSweepFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = totalOutput - feeAmount;

        IERC20 outputToken = IERC20(tokenOut);
        if (feeAmount > 0) {
            outputToken.safeTransfer(feeCollector, feeAmount);
        }
        outputToken.safeTransfer(recipient, netOutput);

        emit DustSwept(msg.sender, recipient, tokenOut, totalOutput, feeAmount, orders.length);
    }

    /// @notice Batch-swap multiple dust tokens via multi-hop paths into ETH.
    /// @param orders    Array of MultiHopSwapOrder structs (max 10).
    /// @param recipient Address that receives the net ETH output.
    /// @param deadline  Unix timestamp after which the transaction reverts.
    function sweepDustMultiHopToETH(
        MultiHopSwapOrder[] calldata orders,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (orders.length == 0) revert EmptyOrders();
        if (orders.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 totalOutput = _executeBatchMultiHopSwaps(orders);
        if (totalOutput == 0) revert InsufficientOutput();

        uint256 feeAmount = (totalOutput * dustSweepFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = totalOutput - feeAmount;

        if (feeAmount > 0) {
            IERC20(address(weth)).safeTransfer(feeCollector, feeAmount);
        }

        weth.withdraw(netOutput);
        (bool success,) = recipient.call{value: netOutput}("");
        if (!success) revert ETHTransferFailed();

        emit DustSwept(msg.sender, recipient, address(0), totalOutput, feeAmount, orders.length);
    }

    // ──────────────────────── Core: Single Swap ────────────

    /// @notice Swap a single token through Uniswap V3 with a 0.1 % fee.
    function singleSwap(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint24 poolFee,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 feeAmount = (amountOut * swapFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = amountOut - feeAmount;

        IERC20 outputToken = IERC20(tokenOut);
        if (feeAmount > 0) {
            outputToken.safeTransfer(feeCollector, feeAmount);
        }
        outputToken.safeTransfer(recipient, netOutput);

        emit SingleSwap(msg.sender, recipient, tokenOut, tokenIn, amountIn, amountOut, feeAmount);
    }

    // ──────────────────────── ETH Swap Functions ─────────────

    /// @notice Swap ETH for tokens. Wraps ETH to WETH, swaps, takes fee from output.
    function swapETHForTokens(
        address tokenOut,
        uint24 poolFee,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (msg.value == 0) revert ZeroAmount();
        if (tokenOut == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();

        weth.deposit{value: msg.value}();
        IERC20(address(weth)).forceApprove(address(swapRouter), msg.value);

        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 feeAmount = (amountOut * swapFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = amountOut - feeAmount;

        IERC20 outputToken = IERC20(tokenOut);
        if (feeAmount > 0) {
            outputToken.safeTransfer(feeCollector, feeAmount);
        }
        outputToken.safeTransfer(recipient, netOutput);

        emit SingleSwap(msg.sender, recipient, tokenOut, address(weth), msg.value, amountOut, feeAmount);
    }

    /// @notice Swap tokens for ETH. Swaps to WETH, unwraps, takes fee, sends ETH.
    function swapTokensForETH(
        address tokenIn,
        uint256 amountIn,
        uint24 poolFee,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (tokenIn == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        uint256 amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: address(weth),
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 feeAmount = (amountOut * swapFeeBps) / BPS_DENOMINATOR;
        uint256 netOutput = amountOut - feeAmount;

        if (feeAmount > 0) {
            IERC20(address(weth)).safeTransfer(feeCollector, feeAmount);
        }

        weth.withdraw(netOutput);
        (bool success,) = recipient.call{value: netOutput}("");
        if (!success) revert ETHTransferFailed();

        emit SingleSwap(msg.sender, recipient, address(0), tokenIn, amountIn, amountOut, feeAmount);
    }

    // ──────────────────────── Internal ─────────────────────

    /// @dev Execute single-hop batch swaps and return total output (held by this contract).
    function _executeBatchSwaps(
        SwapOrder[] calldata orders,
        address tokenOut
    ) internal returns (uint256 totalOutput) {
        uint256 length = orders.length;

        for (uint256 i; i < length;) {
            SwapOrder calldata order = orders[i];

            if (order.tokenIn == address(0)) revert ZeroAddress();
            if (order.amountIn == 0) revert ZeroAmount();

            IERC20(order.tokenIn).safeTransferFrom(msg.sender, address(this), order.amountIn);
            IERC20(order.tokenIn).forceApprove(address(swapRouter), order.amountIn);

            uint256 amountOut = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: order.tokenIn,
                    tokenOut: tokenOut,
                    fee: order.poolFee,
                    recipient: address(this),
                    amountIn: order.amountIn,
                    amountOutMinimum: order.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );

            totalOutput += amountOut;

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Execute multi-hop batch swaps and return total output (held by this contract).
    function _executeBatchMultiHopSwaps(
        MultiHopSwapOrder[] calldata orders
    ) internal returns (uint256 totalOutput) {
        uint256 length = orders.length;

        for (uint256 i; i < length;) {
            MultiHopSwapOrder calldata order = orders[i];

            if (order.tokenIn == address(0)) revert ZeroAddress();
            if (order.amountIn == 0) revert ZeroAmount();

            IERC20(order.tokenIn).safeTransferFrom(msg.sender, address(this), order.amountIn);
            IERC20(order.tokenIn).forceApprove(address(swapRouter), order.amountIn);

            uint256 amountOut = swapRouter.exactInput(
                ISwapRouter02.ExactInputParams({
                    path: order.path,
                    recipient: address(this),
                    amountIn: order.amountIn,
                    amountOutMinimum: order.minAmountOut
                })
            );

            totalOutput += amountOut;

            unchecked {
                ++i;
            }
        }
    }

    // ──────────────────────── Admin ────────────────────────

    /// @notice Set the dust sweep fee in basis points.
    function setDustSweepFeeBps(uint256 _bps) external onlyOwner {
        if (_bps > MAX_DUST_SWEEP_FEE_BPS) revert FeeTooHigh();
        uint256 old = dustSweepFeeBps;
        dustSweepFeeBps = _bps;
        emit DustSweepFeeBpsUpdated(old, _bps);
    }

    /// @notice Set the single-swap fee in basis points.
    function setSwapFeeBps(uint256 _bps) external onlyOwner {
        if (_bps > MAX_SWAP_FEE_BPS) revert FeeTooHigh();
        uint256 old = swapFeeBps;
        swapFeeBps = _bps;
        emit SwapFeeBpsUpdated(old, _bps);
    }

    /// @notice Update the fee collector address.
    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert ZeroAddress();
        address old = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(old, _feeCollector);
    }

    /// @notice Rescue tokens accidentally sent to this contract.
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(owner(), amount);
        emit TokensRescued(token, amount, owner());
    }

    /// @notice Pause all swap functions.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause all swap functions.
    function unpause() external onlyOwner {
        _unpause();
    }
}
