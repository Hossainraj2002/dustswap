// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BurnVault
/// @notice Users deposit (burn) valueless / zero-liquidity tokens.
///         They may later reclaim them with a configurable tax that flows
///         to the FeeCollector.
contract BurnVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────── Types ────────────────────────

    struct BurnRecord {
        address burner;
        address token;
        uint256 amount;
        uint256 timestamp;
        bool reclaimed;
    }

    // ──────────────────────── Constants ────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_RECLAIM_TAX_BPS = 5_000; // 50 %

    // ──────────────────────── State ────────────────────────
    address public feeCollector;
    uint256 public reclaimTaxBps = 1_000; // 10 %

    uint256 public nextRecordId;
    mapping(uint256 => BurnRecord) public burnRecords;
    mapping(address => uint256[]) private _userBurnIds;

    // ──────────────────────── Events ───────────────────────
    event TokensBurned(
        address indexed burner, uint256[] recordIds, address[] tokens, uint256[] amounts
    );
    event TokenReclaimed(
        uint256 indexed recordId,
        address indexed burner,
        address indexed token,
        uint256 amountReturned,
        uint256 taxAmount
    );
    event ReclaimTaxBpsUpdated(uint256 oldBps, uint256 newBps);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);

    // ──────────────────────── Errors ───────────────────────
    error ZeroAddress();
    error ArrayLengthMismatch();
    error EmptyArray();
    error ZeroAmount();
    error NotBurner();
    error AlreadyReclaimed();
    error TaxTooHigh();
    error RecordDoesNotExist();

    // ──────────────────────── Constructor ──────────────────
    /// @param _feeCollector Address of the FeeCollector contract.
    /// @param _owner        Contract owner.
    constructor(address _feeCollector, address _owner) Ownable(_owner) {
        if (_feeCollector == address(0)) revert ZeroAddress();
        feeCollector = _feeCollector;
    }

    // ──────────────────────── Core ─────────────────────────

    /// @notice Burn (deposit) one or more tokens into the vault.
    /// @param tokens  Token addresses to burn.
    /// @param amounts Corresponding amounts (must match length).
    function burnTokens(address[] calldata tokens, uint256[] calldata amounts)
        external
        nonReentrant
    {
        uint256 length = tokens.length;
        if (length == 0) revert EmptyArray();
        if (length != amounts.length) revert ArrayLengthMismatch();

        uint256[] memory recordIds = new uint256[](length);

        for (uint256 i; i < length;) {
            address token = tokens[i];
            uint256 amount = amounts[i];
            if (token == address(0)) revert ZeroAddress();
            if (amount == 0) revert ZeroAmount();

            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

            uint256 recordId = nextRecordId;
            burnRecords[recordId] = BurnRecord({
                burner: msg.sender,
                token: token,
                amount: amount,
                timestamp: block.timestamp,
                reclaimed: false
            });
            _userBurnIds[msg.sender].push(recordId);
            recordIds[i] = recordId;

            unchecked {
                ++nextRecordId;
                ++i;
            }
        }

        emit TokensBurned(msg.sender, recordIds, tokens, amounts);
    }

    /// @notice Reclaim a previously burned token. 10 % tax goes to FeeCollector.
    /// @param recordId The burn record ID to reclaim.
    function reclaimToken(uint256 recordId) external nonReentrant {
        if (recordId >= nextRecordId) revert RecordDoesNotExist();

        BurnRecord storage record = burnRecords[recordId];
        if (record.burner != msg.sender) revert NotBurner();
        if (record.reclaimed) revert AlreadyReclaimed();

        record.reclaimed = true;

        uint256 taxAmount = (record.amount * reclaimTaxBps) / BPS_DENOMINATOR;
        uint256 returnAmount = record.amount - taxAmount;

        if (taxAmount > 0) {
            IERC20(record.token).safeTransfer(feeCollector, taxAmount);
        }
        if (returnAmount > 0) {
            IERC20(record.token).safeTransfer(msg.sender, returnAmount);
        }

        emit TokenReclaimed(recordId, msg.sender, record.token, returnAmount, taxAmount);
    }

    // ──────────────────────── Views ────────────────────────

    /// @notice Return all burn record IDs for a given user.
    function getUserBurnIds(address user) external view returns (uint256[] memory) {
        return _userBurnIds[user];
    }

    /// @notice Return a single burn record by ID.
    function getBurnRecord(uint256 recordId) external view returns (BurnRecord memory) {
        if (recordId >= nextRecordId) revert RecordDoesNotExist();
        return burnRecords[recordId];
    }

    /// @notice Return all burn records for a user (convenience view).
    /// @dev    May be expensive for users with many records — use off-chain indexing in production.
    function getUserBurnRecords(address user) external view returns (BurnRecord[] memory) {
        uint256[] storage ids = _userBurnIds[user];
        uint256 length = ids.length;
        BurnRecord[] memory records = new BurnRecord[](length);
        for (uint256 i; i < length;) {
            records[i] = burnRecords[ids[i]];
            unchecked {
                ++i;
            }
        }
        return records;
    }

    // ──────────────────────── Admin ────────────────────────

    /// @notice Update the reclaim tax in basis points.
    function setReclaimTaxBps(uint256 _bps) external onlyOwner {
        if (_bps > MAX_RECLAIM_TAX_BPS) revert TaxTooHigh();
        uint256 old = reclaimTaxBps;
        reclaimTaxBps = _bps;
        emit ReclaimTaxBpsUpdated(old, _bps);
    }

    /// @notice Update the FeeCollector address.
    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert ZeroAddress();
        address old = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(old, _feeCollector);
    }
}