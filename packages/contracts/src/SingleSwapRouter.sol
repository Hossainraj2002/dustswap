// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IPermit2 {
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;
}

contract SingleSwapRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable FEE_COLLECTOR;
    address public immutable V3_ROUTER;
    address public immutable UNIVERSAL_ROUTER;
    address public immutable PERMIT2;
    address public immutable WETH;

    // Fixed 0.2% fee
    uint256 public constant FEE_BPS = 20;

    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountAfterFee,
        bool useV4
    );

    constructor(
        address _feeCollector,
        address _v3Router,
        address _universalRouter,
        address _permit2,
        address _weth
    ) {
        FEE_COLLECTOR = _feeCollector;
        V3_ROUTER = _v3Router;
        UNIVERSAL_ROUTER = _universalRouter;
        PERMIT2 = _permit2;
        WETH = _weth;
    }

    // Required to receive ETH from WETH unwrapping or router refunds
    receive() external payable {}

    /// @notice Swaps tokens using V3 or V4 (Universal Router).
    /// @param tokenIn Address of the token to swap from. Use address(0) for native ETH.
    /// @param tokenOut Address of the token to swap to.
    /// @param amountIn Total amount to swap (including the 0.2% fee).
    /// @param amountOutMin Minimum amount of tokenOut expected.
    /// @param useV4 If true, routes through V4 (UniversalRouter). Otherwise routes V3 (SwapRouter02).
    /// @param path Swap path for V3 (encoded tokens/fees) or ABI encoded command data for V4 Universal Router.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bool useV4,
        bytes calldata path
    ) external payable nonReentrant {
        require(amountIn > 0, "Amount must be > 0");

        uint256 fee = (amountIn * FEE_BPS) / 10000;
        uint256 amountAfterFee = amountIn - fee;

        bool isNativeIn = (tokenIn == address(0));

        if (isNativeIn) {
            require(msg.value == amountIn, "ETH amount mismatch");
            // Send fee native
            (bool feeSuccess, ) = FEE_COLLECTOR.call{value: fee}("");
            require(feeSuccess, "Fee transfer failed");
        } else {
            require(msg.value == 0, "No ETH expected");
            // Pull tokenIn and send fee
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                amountIn
            );
            IERC20(tokenIn).safeTransfer(FEE_COLLECTOR, fee);
        }

        if (useV4) {
            // V4 Route via Universal Router
            if (isNativeIn) {
                // Pass native ETH to Universal Router via low-level call
                // The 'path' contains the exact calldata for Universal Router
                (bool success, bytes memory returnData) = UNIVERSAL_ROUTER.call{
                    value: amountAfterFee
                }(path);
                if (!success) {
                    if (returnData.length > 0) {
                        assembly {
                            let returndata_size := mload(returnData)
                            revert(add(32, returnData), returndata_size)
                        }
                    } else {
                        revert("V4 swap failed");
                    }
                }
            } else {
                // Approve Permit2
                IERC20(tokenIn).approve(PERMIT2, amountAfterFee);
                IPermit2(PERMIT2).approve(
                    tokenIn,
                    UNIVERSAL_ROUTER,
                    uint160(amountAfterFee),
                    uint48(block.timestamp + 100)
                );

                (bool success, bytes memory returnData) = UNIVERSAL_ROUTER.call(
                    path
                );
                if (!success) {
                    if (returnData.length > 0) {
                        assembly {
                            let returndata_size := mload(returnData)
                            revert(add(32, returnData), returndata_size)
                        }
                    } else {
                        revert("V4 swap failed");
                    }
                }
            }
        } else {
            // V3 Route via SwapRouter02
            address routerTokenIn = tokenIn;

            if (isNativeIn) {
                // Wrap native ETH to WETH for V3
                IWETH(WETH).deposit{value: amountAfterFee}();
                routerTokenIn = WETH;
            }

            IERC20(routerTokenIn).approve(V3_ROUTER, amountAfterFee);

            IV3SwapRouter.ExactInputParams memory params = IV3SwapRouter
                .ExactInputParams({
                    path: path,
                    recipient: msg.sender,
                    amountIn: amountAfterFee,
                    amountOutMinimum: amountOutMin
                });

            IV3SwapRouter(V3_ROUTER).exactInput(params);
        }

        emit Swap(
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            amountAfterFee,
            useV4
        );
    }
}
