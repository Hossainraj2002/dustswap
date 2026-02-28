// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BurnVault — Store "burned" tokens with optional reclaim (10% tax)
/// @notice Users burn dust/scam tokens here. Optionally reclaim later at a cost.
contract BurnVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Configuration ───────────────────────────────────────────────────────
    uint256 public reclaimTaxBps = 1000;           // 10 % (bps out of 10 000)
    uint256 public constant MAX_TAX          = 2000; // 20 % ceiling
    uint256 public constant MAX_TOKENS_PER_BURN = 50;

    uint256 private _burnCounter;

    // ─── Data ─────────────────────────────────────────────────────────────────
    struct BurnRecord {
        address   user;
        address[] tokens;
        uint256[] amounts;
        bool      reclaimed;
        uint256   timestamp;
    }

    mapping(bytes32 => BurnRecord)   private _burns;
    mapping(address => bytes32[])    private _userBurns;

    // ─── Events ──────────────────────────────────────────────────────────────
    event TokensBurned(
        address indexed user,
        bytes32 indexed burnId,
        address[] tokens,
        uint256[] amounts
    );
    event TokensReclaimed(address indexed user, bytes32 indexed burnId);
    event ReclaimTaxUpdated(uint256 oldTax, uint256 newTax);

    constructor() Ownable(msg.sender) {}

    // ─── Burn ────────────────────────────────────────────────────────────────

    /// @notice Burn multiple tokens in one call. Returns a burnId for potential reclaim.
    function burnTokens(
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external nonReentrant returns (bytes32 burnId) {
        require(tokens.length > 0,                          "BurnVault: empty");
        require(tokens.length == amounts.length,            "BurnVault: length mismatch");
        require(tokens.length <= MAX_TOKENS_PER_BURN,       "BurnVault: too many tokens");

        burnId = keccak256(abi.encodePacked(msg.sender, block.timestamp, _burnCounter++));

        for (uint256 i; i < tokens.length; i++) {
            require(amounts[i] > 0,             "BurnVault: zero amount");
            require(tokens[i] != address(0),    "BurnVault: zero token");
            IERC20(tokens[i]).safeTransferFrom(msg.sender, address(this), amounts[i]);
        }

        _burns[burnId] = BurnRecord({
            user:      msg.sender,
            tokens:    tokens,
            amounts:   amounts,
            reclaimed: false,
            timestamp: block.timestamp
        });
        _userBurns[msg.sender].push(burnId);

        emit TokensBurned(msg.sender, burnId, tokens, amounts);
    }

    // ─── Reclaim ─────────────────────────────────────────────────────────────

    /// @notice Reclaim previously burned tokens minus the reclaim tax
    function reclaimTokens(bytes32 burnId) external nonReentrant {
        BurnRecord storage r = _burns[burnId];
        require(r.user == msg.sender,   "BurnVault: not owner");
        require(!r.reclaimed,           "BurnVault: already reclaimed");
        require(r.user != address(0),   "BurnVault: not found");

        r.reclaimed = true;

        for (uint256 i; i < r.tokens.length; i++) {
            uint256 available = IERC20(r.tokens[i]).balanceOf(address(this));
            uint256 toReturn  = r.amounts[i] > available ? available : r.amounts[i];
            if (toReturn == 0) continue;

            uint256 tax        = (toReturn * reclaimTaxBps) / 10_000;
            uint256 userAmount = toReturn - tax;

            if (userAmount > 0) IERC20(r.tokens[i]).safeTransfer(msg.sender, userAmount);
            // tax stays in vault
        }

        emit TokensReclaimed(msg.sender, burnId);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getUserBurns(address user) external view returns (bytes32[] memory) {
        return _userBurns[user];
    }

    function getBurnRecord(bytes32 burnId)
        external view
        returns (
            address user,
            address[] memory tokens,
            uint256[] memory amounts,
            bool    reclaimed,
            uint256 timestamp
        )
    {
        BurnRecord storage r = _burns[burnId];
        return (r.user, r.tokens, r.amounts, r.reclaimed, r.timestamp);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setReclaimTax(uint256 _taxBps) external onlyOwner {
        require(_taxBps <= MAX_TAX, "BurnVault: tax too high");
        uint256 old = reclaimTaxBps;
        reclaimTaxBps = _taxBps;
        emit ReclaimTaxUpdated(old, _taxBps);
    }

    /// @notice Owner withdraws accumulated tax tokens
    function withdrawTax(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
