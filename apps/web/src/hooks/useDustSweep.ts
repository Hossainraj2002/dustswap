'use client';

/**
 * useDustSweep.ts
 *
 * Core hook for the Dust Sweep feature.
 *
 * BASE UX INTEGRATIONS:
 *
 * 1. BATCH TRANSACTIONS
 *    Instead of sending N approval TXs + 1 sweep TX separately (N+1 signatures),
 *    we build them all into a single `wallet_sendCalls` batch.
 *    The user signs ONCE, the Smart Wallet executes everything atomically.
 *    Docs: https://docs.base.org/base-account/improve-ux/batch-transactions
 *
 * 2. SPONSORED GAS (Paymaster)
 *    When NEXT_PUBLIC_PAYMASTER_URL is set, we attach `paymasterService` to
 *    the batch capabilities. The paymaster pays gas → users pay $0.
 *    Docs: https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters
 *
 * Usage:
 *   const { sweep, status, txHash, error } = useDustSweep();
 *   await sweep(selectedTokens, outputTokenAddress);
 */

import { useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { useWriteContracts, useCallsStatus } from 'wagmi/experimental';
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import {
  CONTRACT_ADDRESSES,
  DUST_SWEEP_ROUTER_ABI,
  ERC20_ABI,
} from '@/lib/contracts';
import { PAYMASTER_URL } from '@/app/providers';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SweepToken {
  tokenAddress: `0x${string}`;
  amount: bigint;
  /** Pre-built calldata for Uniswap Universal Router (built by backend) */
  swapCalldata: `0x${string}`;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useDustSweep() {
  const { address } = useAccount();
  const chainId     = useChainId();

  // wagmi/experimental: sends a batch of calls in one wallet_sendCalls
  const { writeContractsAsync, data: batchId, error, isPending } = useWriteContracts();

  // Track status of the submitted batch
  const { data: callsStatus } = useCallsStatus({
    id: batchId as string,
    query: { enabled: !!batchId, refetchInterval: 2_000 },
  });

  const isConfirming = callsStatus?.status === 'PENDING';
  const isSuccess    = callsStatus?.status === 'CONFIRMED';
  const txHash       = callsStatus?.receipts?.[0]?.transactionHash;

  /**
   * Execute a dust sweep.
   *
   * Builds and submits ONE batch containing:
   *   [approve(token0), approve(token1), …, sweepDust(params)]
   *
   * With paymaster capabilities if NEXT_PUBLIC_PAYMASTER_URL is set.
   */
  const sweep = useCallback(async (
    tokens:      SweepToken[],
    outputToken: `0x${string}`,
    /** Minimum acceptable output — set slippage tolerance here */
    minOutput:   bigint = 0n,
  ): Promise<string | undefined> => {
    if (!address || tokens.length === 0) return;

    const addrs = CONTRACT_ADDRESSES[chainId as keyof typeof CONTRACT_ADDRESSES];
    if (!addrs?.dustSweepRouter || addrs.dustSweepRouter === '0x0') {
      throw new Error('DustSweepRouter not deployed on this network. Check NEXT_PUBLIC_ROUTER_ADDRESS.');
    }

    // ── 1. Build approve calls ──────────────────────────────────────────────
    const approveCalls = tokens.map((tok) => ({
      address: tok.tokenAddress,
      abi:     ERC20_ABI,
      functionName: 'approve' as const,
      args: [addrs.dustSweepRouter, maxUint256] as const,
    }));

    // ── 2. Build sweepDust call ─────────────────────────────────────────────
    const sweepCall = {
      address:      addrs.dustSweepRouter,
      abi:          DUST_SWEEP_ROUTER_ABI,
      functionName: 'sweepDust' as const,
      args: [{
        inputTokens:     tokens.map(t => t.tokenAddress),
        inputAmounts:    tokens.map(t => t.amount),
        outputToken,
        minOutputAmount: minOutput,
        swapCalldata:    tokens.map(t => t.swapCalldata),
      }] as const,
    };

    // ── 3. Attach paymaster capabilities (gas sponsorship) ─────────────────
    // When NEXT_PUBLIC_PAYMASTER_URL is configured, the paymaster pays gas.
    // If the URL is not set, the user pays normal gas.
    const capabilities = PAYMASTER_URL
      ? {
          paymasterService: {
            url: PAYMASTER_URL,
          },
        }
      : undefined;

    // ── 4. Submit batch ─────────────────────────────────────────────────────
    // This triggers ONE wallet prompt for ALL calls.
    const id = await writeContractsAsync({
      contracts: [...approveCalls, sweepCall],
      capabilities,
    });

    return id;
  }, [address, chainId, writeContractsAsync]);

  return {
    sweep,
    batchId,
    txHash,
    error,
    isPending,      // waiting for wallet confirmation
    isConfirming,   // tx submitted, waiting for on-chain inclusion
    isSuccess,      // tx confirmed on-chain
  };
}
