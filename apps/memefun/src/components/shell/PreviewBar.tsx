"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlaskConical, ChevronRight } from "lucide-react";
import { SCENARIOS, usePreview, type ScenarioId } from "@/lib/preview/scenario";
import { COIN_FOR_SCENARIO } from "@/lib/preview/scenarioTargets";
import { cn } from "@/lib/cn";
import { Sheet } from "@/components/ui/Sheet";

/**
 * Always visible in preview so simulated data is never mistaken for a live
 * market. Opens the scenario list used to review every state.
 */
export function PreviewBar() {
  const { preview, scenario, setScenario } = usePreview();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!preview) return null;
  const current = SCENARIOS.find((entry) => entry.id === scenario);
  const groups = [...new Set(SCENARIOS.map((entry) => entry.group))];

  const choose = (id: ScenarioId) => {
    setOpen(false);
    if (COIN_FOR_SCENARIO[id]) {
      // The go page waits for the scenario's market, then opens a matching coin.
      router.push(`/go/${id}?scenario=${id}`);
      return;
    }
    if (id === "admin") {
      router.push("/admin?scenario=admin");
      return;
    }
    setScenario(id);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 bg-warning/10 px-4 py-2 text-left text-footnote text-label transition-colors hover:bg-warning/18 lg:rounded-md"
      >
        <FlaskConical className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">Preview.</span> Simulated market data, nothing here is real.
          {scenario !== "default" ? <span> Scenario: {current?.label}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 font-semibold text-label">
          Scenarios
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Preview scenarios" description="Switch the simulated market or wallet into a specific state.">
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group} className="flex flex-col gap-2">
              <h3 className="px-1 text-footnote font-semibold uppercase tracking-wide text-label-2">{group}</h3>
              <div className="mf-card overflow-hidden bg-bg-elevated-2 [&>*+*]:hairline-t">
                {SCENARIOS.filter((entry) => entry.group === group).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => choose(entry.id)}
                    aria-current={entry.id === scenario ? "true" : undefined}
                    className={cn("flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-body transition-colors", entry.id === scenario ? "font-semibold text-tint" : "hover:bg-fill-4")}
                  >
                    {entry.label}
                    {entry.id === scenario ? <span className="text-footnote">Current</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Sheet>
    </>
  );
}
