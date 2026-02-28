// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DustSweepRouter — Batch-swap multiple dust tokens to a single output
/// @notice Tokens must be approved (or batch-approved via Smart Wallet) before calling.
///         All swaps route through Uniswap Universal Router calldata built off-chain.
contract DustSweepRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────────────────────
    uint256 public constant MAX_BATCH         = 25;
    uint256 public constant MAX_FEE_BPS       = 500;   // 5 % ceiling
    uint256 public constant BPS_DENOMINATOR   = 10_000;

    // ─── State ───────────────────────────────────────────────────────────────
    address public immutable uniswapRouter;
    address public           feeCollector;
    uint256 public           sweepFeeBps = 100;   // 1 %
    uint256 public           swapFeeBps  = 30;    // 0.3 %
    bool    public           paused;

    // ─── Events ──────────────────────────────────────────────────────────────
    event DustSwept(
        address indexed user,
        uint256 tokenCount,
        address outputToken,
        uint256 totalOutput,
        uint256 fee,
        uint256 userReceived
    );
    event SingleSwap(
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event Paused(bool state);
    event FeeUpdated(string feeType, uint256 oldFee, uint256 newFee);
    event FeeCollectorUpdated(address oldCollector, address newCollector);

    // ─── Modifiers ───────────────────────────────────────────────────────────
    modifier whenNotPaused() {
        require(!paused, "DustSweepRouter: paused");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────
    constructor(address _uniswapRouter, address _feeCollector) Ownable(msg.sender) {
        require(_uniswapRouter != address(0), "DustSweepRouter: zero router");
        require(_feeCollector  != address(0), "DustSweepRouter: zero feeCollector");
        uniswapRouter = _uniswapRouter;
        feeCollector  = _feeCollector;
    }

    // ─── Structs ─────────────────────────────────────────────────────────────

    struct SweepParams {
        address[] inputTokens;
        uint256[] inputAmounts;
        address   outputToken;
        uint256   minOutputAmount;  // slippage protection
        bytes[]   swapCalldata;     // pre-built Uniswap calldata per token
    }

    // ─── Core: Sweep ─────────────────────────────────────────────────────────

    /// @notice Batch-sweep multiple dust tokens into a single output token.
    /// @dev    Compatible with Base Smart Wallet batch transaction flow:
    ///         the frontend sends all approval calls + this sweep call in one
    ///         `wallet_sendCalls` bundle so users sign once.
    /// @param params See SweepParams struct above.
    /// @return userReceived Amount of outputToken sent to caller.
    function sweepDust(SweepParams calldata params)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 userReceived)
    {
        // ── Validate ────────────────────────────────────────────────────────
        require(params.inputTokens.length > 0,           "DustSweepRouter: empty");
        require(params.inputTokens.length <= MAX_BATCH,  "DustSweepRouter: too many tokens");
        require(
            params.inputTokens.length == params.inputAmounts.length &&
            params.inputTokens.length == params.swapCalldata.length,
            "DustSweepRouter: length mismatch"
        );

        // ── Snapshot output balance before swaps ────────────────────────────
        uint256 outputBefore = IERC20(params.outputToken).balanceOf(address(this));

        // ── Pull tokens & swap ──────────────────────────────────────────────
        for (uint256 i; i < params.inputTokens.length; i++) {
            if (params.inputAmounts[i] == 0) continue;

            IERC20(params.inputTokens[i]).safeTransferFrom(
                msg.sender, address(this), params.inputAmounts[i]
            );
            IERC20(params.inputTokens[i]).safeIncreaseAllowance(
                uniswapRouter, params.inputAmounts[i]
            );

            // Graceful failure: one bad swap doesn't revert the whole batch
            (bool ok,) = uniswapRouter.call(params.swapCalldata[i]);
            if (!ok) {
                // Return the specific token to user so nothing is lost
                uint256 remaining = IERC20(params.inputTokens[i]).balanceOf(address(this));
                if (remaining > 0) IERC20(params.inputTokens[i]).safeTransfer(msg.sender, remaining);
            }
        }

        // ── Calculate output & fee ───────────────────────────────────────────
        uint256 totalOutput = IERC20(params.outputToken).balanceOf(address(this)) - outputBefore;
        require(totalOutput > 0, "DustSweepRouter: no output");

        uint256 fee = (totalOutput * sweepFeeBps) / BPS_DENOMINATOR;
        userReceived = totalOutput - fee;

        require(userReceived >= params.minOutputAmount, "DustSweepRouter: slippage");

        // ── Distribute ──────────────────────────────────────────────────────
        if (fee > 0) IERC20(params.outputToken).safeTransfer(feeCollector, fee);
        IERC20(params.outputToken).safeTransfer(msg.sender, userReceived);

        emit DustSwept(
            msg.sender,
            params.inputTokens.length,
            params.outputToken,
            totalOutput,
            fee,
            userReceived
        );
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setPause(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setSweepFee(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_FEE_BPS, "DustSweepRouter: fee too high");
        emit FeeUpdated("sweep", sweepFeeBps, _bps);
        sweepFeeBps = _bps;
    }

    function setSwapFee(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_FEE_BPS, "DustSweepRouter: fee too high");
        emit FeeUpdated("swap", swapFeeBps, _bps);
        swapFeeBps = _bps;
    }

    function setFeeCollector(address _feeCollector) external onlyOwner {
        require(_feeCollector != address(0), "DustSweepRouter: zero address");
        emit FeeCollectorUpdated(feeCollector, _feeCollector);
        feeCollector = _feeCollector;
    }

    /// @notice Emergency token rescue
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function rescueETH() external onlyOwner {
        (bool ok,) = payable(msg.sender).call{value: address(this).balance}("");
        require(ok, "DustSweepRouter: ETH rescue failed");
    }

    receive() external payable {}
}
