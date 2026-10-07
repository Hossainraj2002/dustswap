"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { STEPS, type StepId } from "@/lib/create/draft";

/** The five launch steps. Completed steps can be revisited; later ones cannot be skipped to. */
export function Stepper({ current, furthest, onSelect, disabled = false }: { current: StepId; furthest: number; onSelect: (step: StepId) => void; disabled?: boolean }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <nav aria-label="Launch steps">
      <p className="mb-2 text-footnote font-semibold text-label-2 lg:hidden">
        Step {index + 1} of {STEPS.length}: {STEPS[index]?.label}
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-fill-3 lg:hidden" aria-hidden>
        <div className="h-full rounded-full bg-tint-fill transition-[width] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]" style={{ width: `${((index + 1) / STEPS.length) * 100}%` }} />
      </div>
      <ol className="hidden items-center gap-1 lg:flex">
        {STEPS.map((step, stepIndex) => {
          const done = stepIndex < index;
          const active = stepIndex === index;
          const revisitable = !active && stepIndex <= furthest;
          const content = (
            <>
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-caption1 font-bold",
                  active ? "bg-tint-fill text-on-tint" : done ? "bg-up-fill text-on-tint" : "bg-fill-3 text-label-2",
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : stepIndex + 1}
              </span>
              {step.label}
            </>
          );
          const classes = cn(
            "flex h-9 items-center gap-2 rounded-full pl-1.5 pr-3 text-subhead font-semibold transition-colors",
            active ? "bg-tint/10 text-tint" : done ? "text-label hover:bg-fill-4" : "text-label-2",
          );
          return (
            <li key={step.id} className="flex items-center gap-1">
              {revisitable ? (
                <button type="button" disabled={disabled} onClick={() => onSelect(step.id)} className={cn(classes, "disabled:cursor-default disabled:opacity-60")} aria-label={`${step.label}, completed. Edit`}>
                  {content}
                </button>
              ) : (
                // The current step and steps not reached yet are not actions.
                <span aria-current={active ? "step" : undefined} className={classes}>
                  {content}
                </span>
              )}
              {stepIndex < STEPS.length - 1 ? <span className="h-px w-4 bg-separator" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
