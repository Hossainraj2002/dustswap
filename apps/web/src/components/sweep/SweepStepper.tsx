"use client";

import { type SweepRouteKind, type SweepStep } from "@/types/dustsweep";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type StepperModel = {
  steps: string[];
  // Index of the step currently in progress. Steps before it are complete.
  // Equals steps.length once everything is done (success).
  activeIndex: number;
};

function buildModel(
  routeKind: SweepRouteKind,
  hasSetup: boolean,
  sweepStep: SweepStep,
  approvalMode?: "standard",
): StepperModel {
  if (approvalMode === "standard") {
    const steps = ["Approve", "Sweep", "Done"];
    const activeIndex =
      sweepStep === "success"
        ? 3
        : sweepStep === "pending"
          ? 1
          : 0;
    return { steps, activeIndex };
  }

  if (routeKind === "batch") {
    const steps = ["Confirm batch", "Done"];
    if (sweepStep === "success") return { steps, activeIndex: 2 };
    return { steps, activeIndex: 0 };
  }

  // Route C — Permit2.
  if (hasSetup) {
    const steps = ["Setup", "Sign", "Sweep", "Done"];
    const activeIndex =
      sweepStep === "success"
        ? 4
        : sweepStep === "pending"
          ? 2
          : sweepStep === "signing"
            ? 1
            : 0; // approving / idle → Setup
    return { steps, activeIndex };
  }

  const steps = ["Sign", "Sweep", "Done"];
  const activeIndex =
    sweepStep === "success"
      ? 3
      : sweepStep === "pending"
        ? 1
        : 0; // signing / approving / idle → Sign
  return { steps, activeIndex };
}

/**
 * An honest, route-aware step indicator rendered above the Sweep button during
 * execution. Replaces ambiguous spinners with the real steps the wallet will
 * walk through (2.6).
 */
export function SweepStepper({
  routeKind,
  sweepStep,
  hasSetup = false,
  approvalMode,
}: {
  routeKind: SweepRouteKind;
  sweepStep: SweepStep;
  hasSetup?: boolean;
  approvalMode?: "standard";
}) {
  const { steps, activeIndex } = buildModel(
    routeKind,
    hasSetup,
    sweepStep,
    approvalMode,
  );

  return (
    <div className="rounded-[16px] border border-slate-200 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-white/10 dark:bg-white/[0.06]">
      <ol className="flex items-center justify-between gap-1">
        {steps.map((label, index) => {
          const isComplete = index < activeIndex;
          const isActive = index === activeIndex;
          return (
            <li
              key={label}
              className="flex flex-1 flex-col items-center gap-1.5"
              aria-current={isActive ? "step" : undefined}
            >
              <div className="flex w-full items-center">
                <span
                  className={cx(
                    "h-0.5 flex-1 rounded-full",
                    index === 0
                      ? "opacity-0"
                      : isComplete || isActive
                        ? "bg-blue-600"
                        : "bg-slate-200 dark:bg-white/10",
                  )}
                />
                <span
                  className={cx(
                    "mx-1 flex h-3 w-3 shrink-0 items-center justify-center rounded-full",
                    isComplete
                      ? "bg-blue-600"
                      : isActive
                        ? "bg-blue-600 ring-4 ring-blue-200 motion-safe:animate-pulse dark:ring-blue-400/20"
                        : "bg-slate-200 dark:bg-white/10",
                  )}
                />
                <span
                  className={cx(
                    "h-0.5 flex-1 rounded-full",
                    index === steps.length - 1
                      ? "opacity-0"
                      : isComplete
                        ? "bg-blue-600"
                        : "bg-slate-200 dark:bg-white/10",
                  )}
                />
              </div>
              <span
                className={cx(
                  "text-[11px] font-medium",
                  isComplete || isActive
                    ? "text-blue-700 dark:text-blue-300"
                    : "text-slate-400 dark:text-slate-500",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
