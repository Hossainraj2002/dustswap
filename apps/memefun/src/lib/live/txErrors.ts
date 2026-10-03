import { type Abi, BaseError, ContractFunctionRevertedError, InsufficientFundsError, decodeErrorResult, parseAbi } from "viem";
import { feeVaultAbi, holderRewardDistributorAbi, memeFunConfigAbi, memeFunFactoryAbi, memeFunHookAbi, memeFunRouterAbi } from "@/lib/contracts/abis";
import { TxError } from "@/lib/market/Market";
import { isUserRejectedRequest } from "@/lib/wallet/paymaster";

/**
 * Errors memefun calls can revert with that are not in the memefun ABIs: the tokens' own (B20,
 * OpenZeppelin ERC-20), the test stock faucet and OpenZeppelin Ownable. Passed along with each
 * contract ABI when simulating, so a revert decodes to a name.
 */
export const EXTRA_ERRORS_ABI = parseAbi([
  "error TooSoon(uint256 nextAt)",
  "error InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
  "error OwnableUnauthorizedAccount(address account)",
  "error ExpiredSignature(uint256 deadline)",
  "error ContractPaused(uint8 feature)",
  "error PolicyForbids(bytes32 policyScope, uint64 policyId)",
]);

type Known = { message: string; kind: TxError["kind"] };

/** Every revert a person can cause, in plain words. */
export const REVERT_MESSAGES: Record<string, Known> = {
  // Trading
  InsufficientOutput: {
    message: "The price moved more than your slippage allows, so the trade was cancelled. Only the network fee was spent.",
    kind: "reverted",
  },
  Expired: { message: "The request waited too long in your wallet and expired. Try again.", kind: "reverted" },
  ZeroAmount: { message: "Enter an amount above zero.", kind: "reverted" },
  WrongValue: { message: "The amount sent did not match the order. Refresh and try again.", kind: "reverted" },
  // Launching
  LaunchesPaused: { message: "New launches are paused right now. Existing coins trade as normal.", kind: "reverted" },
  QuoteNotLaunchable: { message: "That pair is not available right now. Choose another.", kind: "reverted" },
  ModeNotEnabled: { message: "That fee destination is not available right now.", kind: "reverted" },
  FeeOutOfBounds: { message: "The trading fee is outside the allowed range.", kind: "reverted" },
  CreatorKeepNotAllowed: { message: "The creator share is above the allowed limit.", kind: "reverted" },
  InvalidName: { message: "The name is empty or too long.", kind: "reverted" },
  InvalidSymbol: { message: "The ticker is empty or too long.", kind: "reverted" },
  InvalidUri: { message: "The coin details are too large. Shorten the description.", kind: "reverted" },
  StartTickDrift: { message: "The opening price changed while you were confirming. Try again.", kind: "reverted" },
  FirstBuySlippage: { message: "The first buy would get fewer coins than shown. Try again.", kind: "reverted" },
  StalePrice: { message: "The pair's price feed is out of date, so launches on it are paused. Try again later.", kind: "reverted" },
  // Claims
  NothingToClaim: { message: "There is nothing left to claim here.", kind: "reverted" },
  NotCreator: { message: "Only the coin's creator can do this.", kind: "reverted" },
  AlreadyClaimed: { message: "These rewards were already claimed.", kind: "reverted" },
  ClaimsNotOpen: { message: "These rewards open for claiming 12 hours after they are published.", kind: "reverted" },
  ClaimPeriodOver: { message: "The claim window for these rewards has closed.", kind: "reverted" },
  EpochUnavailable: { message: "These rewards are no longer available.", kind: "reverted" },
  InvalidProof: { message: "These rewards could not be verified. Refresh and try again.", kind: "reverted" },
  // Settings
  FeeNotLower: { message: "A coin's fee can only go down.", kind: "reverted" },
  OwnableUnauthorizedAccount: { message: "Only the memefun owner wallet can change settings. Connect it and try again.", kind: "reverted" },
  // Test stock faucet
  TooSoon: { message: "You already got test stock today. Come back tomorrow.", kind: "reverted" },
  // Tokens
  InsufficientBalance: { message: "Not enough balance for this.", kind: "insufficient" },
  ERC20InsufficientBalance: { message: "Not enough balance for this.", kind: "insufficient" },
  InsufficientAllowance: { message: "The approval did not cover this amount. Try again.", kind: "reverted" },
  ERC20InsufficientAllowance: { message: "The approval did not cover this amount. Try again.", kind: "reverted" },
  ExpiredSignature: { message: "The signature expired. Try again.", kind: "reverted" },
  ContractPaused: { message: "Transfers of this token are paused by its issuer.", kind: "reverted" },
  PolicyForbids: { message: "This token's issuer does not allow this transfer.", kind: "reverted" },
};

/** Every custom error any memefun contract or token can revert with, for decoding raw reverts. */
const ALL_ERRORS_ABI = [
  ...[memeFunConfigAbi, memeFunFactoryAbi, memeFunHookAbi, memeFunRouterAbi, feeVaultAbi, holderRewardDistributorAbi].flatMap((abi) =>
    abi.filter((item) => item.type === "error"),
  ),
  ...EXTRA_ERRORS_ABI,
] as Abi;

/** The decoded revert error name (or string reason) behind a viem error, if there is one. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  // A plain `require` message decodes as Error(string); its text is the useful part.
  if (reverted.data?.errorName && reverted.data.errorName !== "Error") return reverted.data.errorName;
  if (reverted.reason) return reverted.reason;
  if (reverted.raw && reverted.raw.length >= 10) {
    try {
      const decoded = decodeErrorResult({ abi: ALL_ERRORS_ABI, data: reverted.raw });
      return decoded.errorName === "Error" ? String(decoded.args?.[0] ?? "Error") : decoded.errorName;
    } catch {
      // An error from a contract we do not know.
    }
  }
  return null;
}

function insufficientFunds(error: unknown): boolean {
  if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("insufficient funds") || message.includes("exceeds the balance of the account");
}

/**
 * Any failure on the way to (or inside) a transaction, as the TxError the screens show.
 * `fallback` names what failed when there is nothing more specific to say.
 */
export function toTxError(error: unknown, fallback: string): TxError {
  if (error instanceof TxError) return error;
  if (isUserRejectedRequest(error)) return new TxError("You rejected the request in your wallet.", "rejected");
  const name = revertName(error);
  if (name) {
    const known = REVERT_MESSAGES[name];
    if (known) return new TxError(known.message, known.kind);
    if (/exceeds balance|insufficient balance/i.test(name)) return new TxError(REVERT_MESSAGES.InsufficientBalance!.message, "insufficient");
    if (/allowance/i.test(name)) return new TxError(REVERT_MESSAGES.InsufficientAllowance!.message, "reverted");
  }
  if (insufficientFunds(error)) return new TxError("Not enough ETH for this and its network fee.", "insufficient");
  return new TxError(fallback, "reverted");
}
