import { useState, useCallback } from "react";
import { useWalletClient, usePublicClient, useAccount } from "wagmi";
import { Address, encodeFunctionData, erc20Abi } from "viem";

const SINGLE_SWAP_ROUTER = (process.env.NEXT_PUBLIC_SINGLE_SWAP_ROUTER ||
  "0x0000000000000000000000000000000000000000") as Address;
const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string; // raw amounts as strings
  amountOut: string;
  slippage: number; // percentage, e.g., 0.5
  useV4: boolean;
  path: string; // hex data
}

export function useSwap() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [isApproving, setIsApproving] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const swap = useCallback(
    async (params: SwapParams) => {
      if (!address || !walletClient || !publicClient) {
        setError("Wallet not connected");
        return;
      }

      setIsApproving(false);
      setIsSwapping(false);
      setTxHash(null);
      setError(null);

      try {
        const isNativeIn = params.tokenIn.toLowerCase() === NATIVE_TOKEN;
        const amountInBig = BigInt(params.amountIn);

        // 1. ERC20 Approval
        if (!isNativeIn) {
          setIsApproving(true);
          const allowance = await publicClient.readContract({
            address: params.tokenIn as Address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, SINGLE_SWAP_ROUTER],
          });

          if (allowance < amountInBig) {
            const approveData = encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [SINGLE_SWAP_ROUTER, amountInBig],
            });

            const approveHash = await walletClient.sendTransaction({
              to: params.tokenIn as Address,
              data: approveData,
              capabilities: {
                paymasterService: {
                  url: process.env.NEXT_PUBLIC_PAYMASTER_URL!,
                },
              },
            } as any);

            await publicClient.waitForTransactionReceipt({ hash: approveHash });
          }
          setIsApproving(false);
        }

        // 2. Perform Swap
        setIsSwapping(true);

        const amountOutBig = BigInt(params.amountOut);
        // Calculate amountOutMin safely with BigInt maths: out * (10000 - slippageBps) / 10000
        const slippageBps = BigInt(Math.floor(params.slippage * 100));
        const amountOutMin = (amountOutBig * (10000n - slippageBps)) / 10000n;

        const swapData = encodeFunctionData({
          abi: [
            {
              inputs: [
                { name: "tokenIn", type: "address" },
                { name: "tokenOut", type: "address" },
                { name: "amountIn", type: "uint256" },
                { name: "amountOutMin", type: "uint256" },
                { name: "useV4", type: "bool" },
                { name: "path", type: "bytes" },
              ],
              name: "swap",
              outputs: [],
              stateMutability: "payable",
              type: "function",
            },
          ],
          functionName: "swap",
          args: [
            isNativeIn ? "0x0000000000000000000000000000000000000000" : (params.tokenIn as Address),
            params.tokenOut.toLowerCase() === NATIVE_TOKEN ? "0x0000000000000000000000000000000000000000" : (params.tokenOut as Address),
            amountInBig,
            amountOutMin,
            params.useV4,
            params.path as `0x${string}`,
          ],
        });

        const tx = await walletClient.sendTransaction({
          to: SINGLE_SWAP_ROUTER,
          data: swapData,
          value: isNativeIn ? amountInBig : 0n,
          capabilities: {
            paymasterService: {
              url: process.env.NEXT_PUBLIC_PAYMASTER_URL!,
            },
          },
        } as any);

        setTxHash(tx);
        await publicClient.waitForTransactionReceipt({ hash: tx });

        // 3. Record Swap Volume
        try {
          await fetch("/api/points/record-swap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address, txHash: tx }),
          });
        } catch (e) {
          console.error("Failed to record swap for quests", e);
        }
      } catch (err: any) {
        setError(err.shortMessage || err.message || "Swap failed");
      } finally {
        setIsApproving(false);
        setIsSwapping(false);
      }
    },
    [address, walletClient, publicClient]
  );

  return { isApproving, isSwapping, txHash, error, swap };
}
