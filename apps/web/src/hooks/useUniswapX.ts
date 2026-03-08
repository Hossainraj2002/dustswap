import { useState, useCallback, useEffect } from "react";
import { useWalletClient, useAccount, usePublicClient } from "wagmi";
import { DutchOrderBuilder } from "@uniswap/uniswapx-sdk";
import { parseUnits, encodeFunctionData, erc20Abi } from "viem";
import { BigNumber } from "ethers";

const BASE_CHAIN_ID = 8453;
// Standard UniswapX DutchOrderReactor on Base
const REACTOR_ADDRESS = "0x00000000A13Bbd79E4C93F16fA0f7601BB058A85"; // Verify actual V2 deployed address
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const FEE_RECIPIENT = "0xd4a1D777e2882487d47c96bc23A47CeaB4f4f18A";
const BPS_FEE = BigInt(20); // 0.2%
const BPS_MAX = BigInt(10000);

// Note: To submit UniswapX orders on Base, currently you post to standard API:
const UNISWAPX_API_URL = "https://api.uniswap.org/v2/orders";

export function useUniswapX() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [isSignLoading, setIsSignLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signAndSubmitOrder = useCallback(
    async ({
      inputToken,
      outputToken,
      amountIn, // string
      quoteOut, // string
    }: {
      inputToken: string;
      outputToken: string;
      amountIn: string;
      quoteOut: string;
    }) => {
      if (!address || !walletClient || !publicClient) return;
      setIsSignLoading(true);
      setError(null);

      try {
        const inputAmountBi = BigInt(amountIn);
        const quoteOutBi = BigInt(quoteOut);

        // 1. Check & Approve Permit2 if necessary
        const allowance = await publicClient.readContract({
          address: inputToken as `0x${string}`,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, PERMIT2_ADDRESS],
        });

        if (allowance < inputAmountBi) {
          const hash = await walletClient.sendTransaction({
            to: inputToken as `0x${string}`,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [PERMIT2_ADDRESS, inputAmountBi],
            }),
            capabilities: {
              paymasterService: {
                url: process.env.NEXT_PUBLIC_PAYMASTER_URL!,
              },
            },
          } as any);
          await publicClient.waitForTransactionReceipt({ hash });
        }

        // 2. Build the Order
        const now = Math.floor(Date.now() / 1000);
        const deadline = now + 60 * 60; // 1 hour validity

        // Fee calculation: 0.2% of quoted output
        const feeAmount = (quoteOutBi * BPS_FEE) / BPS_MAX;
        const userAmount = quoteOutBi - feeAmount;

        // Note: In Dutch orders, you typically have decay logic (startAmount > endAmount).
        // For simplicity/limit-order behavior, we use the same amount for start and end,
        // but fillers can improve the price via gasless execution.
        const builder = new DutchOrderBuilder(BASE_CHAIN_ID, REACTOR_ADDRESS, PERMIT2_ADDRESS);
        
        // Random nonce for order uniqueness
        const nonce = BigInt(Math.floor(Math.random() * 100000000000));

        const order = builder
          .deadline(deadline)
          .decayStartTime(now)
          .decayEndTime(now + 60 * 10) // 10 minute Dutch auction format
          .swapper(address)
          .nonce(BigNumber.from(nonce.toString()))
          .input({
            token: inputToken,
            startAmount: BigNumber.from(inputAmountBi.toString()),
            endAmount: BigNumber.from(inputAmountBi.toString()),
          })
          // 99.8% to swapper
          .output({
            token: outputToken,
            startAmount: BigNumber.from(userAmount.toString()),
            endAmount: BigNumber.from(((userAmount * BigInt(95)) / BigInt(100)).toString()), // Allow 5% variance for auction
            recipient: address,
          })
          // 0.2% protocol fee to your wallet
          .output({
            token: outputToken,
            startAmount: BigNumber.from(feeAmount.toString()),
            endAmount: BigNumber.from(((feeAmount * BigInt(95)) / BigInt(100)).toString()),
            recipient: FEE_RECIPIENT,
          })
          .build();

        // 3. Sign Order via EIP-712
        const { domain, types, values } = order.permitData();
        const signature = await walletClient.signTypedData({
          domain: domain as any,
          types: types as any,
          message: values as any,
          primaryType: "PermitWitnessTransferFrom",
        });

        // 4. Submit to UniswapX API
        const orderHash = order.hash();
        
        const res = await fetch(UNISWAPX_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chainId: BASE_CHAIN_ID,
            orderHash: orderHash,
            signature: signature,
            encodedOrder: order.serialize(),
          }),
        });

        if (!res.ok) {
          const errorMsg = await res.text();
          throw new Error(`Failed to submit order: ${errorMsg}`);
        }

        return { orderHash, signature };

      } catch (err: any) {
        setError(err.message || "Failed to sign or submit UniswapX order");
      } finally {
        setIsSignLoading(false);
      }
    },
    [address, walletClient, publicClient]
  );

  return { signAndSubmitOrder, isSignLoading, error };
}
