import type { Address, PublicClient } from "viem";

import type { LaunchSettings } from "../../shared/core/settings";
import type { FeeMode, QuoteKind } from "../../shared/core/types";
import { memeFunConfigAbi } from "../../shared/abis";

const MODES: FeeMode[] = ["creator", "burn", "holders", "floor"];
const KINDS: QuoteKind[] = ["native", "stable", "stock"];

/**
 * The launch settings new coins get right now, read from MemeFunConfig (the source of truth the
 * factory enforces), in the admin page's LaunchSettings shape. Cached briefly: they only change
 * when the owner sends a transaction.
 */
export function createSettingsReader(client: PublicClient, config: Address, ttlMs = 15_000) {
  let cached: { at: number; value: LaunchSettings } | null = null;
  let inflight: Promise<LaunchSettings> | null = null;

  async function load(): Promise<LaunchSettings> {
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({ address: config, abi: memeFunConfigAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const [terms, openingFdvUsdE8, modes, kinds] = await Promise.all([
      read<{
        creationFee: bigint;
        feeMinBps: number;
        feeMaxBps: number;
        defaultFeeBps: number;
        platformShareBps: number;
        referralShareBps: number;
        creatorKeepMaxBps: number;
        protectionStartBps: number;
        protectionDurationSec: number;
        launchesPaused: boolean;
      }>("launchTerms"),
      read<bigint>("openingFdvUsdE8"),
      Promise.all(MODES.map((_, i) => read<{ enabled: boolean; module: Address }>("modeInfo", [i]))),
      Promise.all(KINDS.map((_, i) => read<boolean>("kindEnabled", [i]))),
    ]);
    return {
      creationFeeEth: Number(terms.creationFee) / 1e18,
      feeMinBps: terms.feeMinBps,
      feeMaxBps: terms.feeMaxBps,
      defaultFeeBps: terms.defaultFeeBps,
      platformShareBps: terms.platformShareBps,
      referralShareBps: terms.referralShareBps,
      creatorKeepMaxBps: terms.creatorKeepMaxBps,
      snipeStartBps: terms.protectionStartBps,
      snipeDurationSec: terms.protectionDurationSec,
      openingFdvUsd: Number(openingFdvUsdE8) / 1e8,
      launchesPaused: terms.launchesPaused,
      enabledModes: MODES.filter((_, i) => modes[i]?.enabled),
      enabledQuoteKinds: KINDS.filter((_, i) => kinds[i]),
    };
  }

  return {
    async get(): Promise<LaunchSettings> {
      if (cached && Date.now() - cached.at < ttlMs) return cached.value;
      inflight ??= load()
        .then((value) => {
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

export type SettingsReader = ReturnType<typeof createSettingsReader>;
