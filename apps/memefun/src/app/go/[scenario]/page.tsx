"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/Spinner";
import { useCoins } from "@/lib/market/hooks";
import { COIN_FOR_SCENARIO } from "@/lib/preview/scenarioTargets";
import type { ScenarioId } from "@/lib/preview/scenario";

/** Preview helper: waits for the scenario's market, then opens a matching coin. */
export default function GoToScenarioCoin({ params }: { params: Promise<{ scenario: string }> }) {
  const { scenario } = use(params);
  const router = useRouter();
  const { coins, ready } = useCoins();

  useEffect(() => {
    if (!ready) return;
    const predicate = COIN_FOR_SCENARIO[scenario as ScenarioId];
    if (!predicate) {
      router.replace("/");
      return;
    }
    const coin = coins.find((entry) => predicate(entry, Date.now()));
    if (coin) router.replace(`/t/${coin.address}?scenario=${scenario}`);
  }, [coins, ready, router, scenario]);

  return (
    <div className="flex min-h-[50dvh] items-center justify-center text-label-2" role="status">
      <Spinner label="Opening the coin for this scenario" />
    </div>
  );
}
