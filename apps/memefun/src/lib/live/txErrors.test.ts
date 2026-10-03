import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, parseAbi, UserRejectedRequestError } from "viem";
import { memeFunRouterAbi } from "@/lib/contracts/abis";
import { TxError } from "@/lib/market/Market";
import { REVERT_MESSAGES, revertName, toTxError } from "./txErrors";

function reverted(data: `0x${string}`, abi: readonly unknown[] = []) {
  return new BaseError("simulation failed", {
    cause: new ContractFunctionRevertedError({ abi: abi as never, data, functionName: "buy" }),
  });
}

describe("toTxError", () => {
  it("treats a wallet rejection as the person's choice", () => {
    const error = toTxError(new UserRejectedRequestError(new Error("User rejected the request.")), "fallback");
    expect(error.kind).toBe("rejected");
  });

  it("names a revert decoded with the contract's ABI", () => {
    const data = encodeErrorResult({ abi: memeFunRouterAbi, errorName: "InsufficientOutput", args: [10n, 9n] });
    const error = toTxError(reverted(data, memeFunRouterAbi), "fallback");
    expect(error.message).toBe(REVERT_MESSAGES.InsufficientOutput!.message);
    expect(error.kind).toBe("reverted");
  });

  it("decodes raw revert data against every memefun and token error", () => {
    const tooSoon = encodeErrorResult({ abi: parseAbi(["error TooSoon(uint256 nextAt)"]), errorName: "TooSoon", args: [123n] });
    expect(revertName(reverted(tooSoon))).toBe("TooSoon");
    const balance = encodeErrorResult({
      abi: parseAbi(["error InsufficientBalance(address sender, uint256 balance, uint256 needed)"]),
      errorName: "InsufficientBalance",
      args: ["0x0000000000000000000000000000000000000001", 1n, 2n],
    });
    expect(toTxError(reverted(balance), "fallback").kind).toBe("insufficient");
  });

  it("maps a plain string revert about allowances and balances", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] });
    expect(toTxError(reverted(data), "fallback").kind).toBe("insufficient");
  });

  it("says when there is not enough ETH for gas", () => {
    expect(toTxError(new Error("insufficient funds for gas * price + value"), "fallback").kind).toBe("insufficient");
  });

  it("falls back to the given message and keeps TxErrors as they are", () => {
    expect(toTxError(new Error("boom"), "The trade did not go through.").message).toBe("The trade did not go through.");
    const original = new TxError("kept", "reverted");
    expect(toTxError(original, "other")).toBe(original);
  });

  it("never uses arrows, em-dashes or ellipses in what people read", () => {
    for (const { message } of Object.values(REVERT_MESSAGES)) expect(message).not.toMatch(/[→—…]/);
  });
});
