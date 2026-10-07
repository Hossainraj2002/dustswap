"use client";

import { useCallback, useEffect, useState } from "react";
import type { LaunchCampaignSummary, LaunchCampaignWalletStatus } from "@/core/campaign";
import { useMarket } from "@/lib/market/MarketProvider";
import { useWallet } from "@/lib/wallet/WalletProvider";

/** Optional campaign reads never change the normal market's trading/availability status. */
export function useLaunchCampaign(includeWallet = false) {
  const { market } = useMarket();
  const { address } = useWallet();
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{ summary: LaunchCampaignSummary | null; wallet: LaunchCampaignWalletStatus | null; error: boolean }>({ summary: null, wallet: null, error: false });
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    setData(previous => previous.summary === null && previous.wallet === null && !previous.error
      ? previous : { summary: null, wallet: null, error: false });
    // Preview and older market adapters have no campaign API. Do not schedule empty reads or
    // replace an already empty state: a parent may provide a fresh adapter object on each render.
    const readSummary = market?.readLaunchCampaign?.bind(market);
    if (!readSummary) return;
    let active = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const summary = await readSummary();
        let wallet: LaunchCampaignWalletStatus | null = null;
        let error = false;
        if (summary.enabled && includeWallet && address && market?.readLaunchCampaignWallet) {
          try { wallet = await market.readLaunchCampaignWallet(address); } catch { error = true; }
        }
        if (active) setData({ summary, wallet, error });
      } catch {
        if (active) setData({ summary: null, wallet: null, error: true });
      } finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [market, includeWallet, address, revision]);
  return { ...data, wallet: data.wallet?.wallet.toLowerCase() === address?.toLowerCase() ? data.wallet : null, refresh };
}
