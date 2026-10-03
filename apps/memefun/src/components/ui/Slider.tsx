"use client";

import { Slider as RadixSlider } from "radix-ui";
import { cn } from "@/lib/cn";

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  /** Spoken value, e.g. "2.5 percent". */
  valueText?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  trackClassName?: string;
}

/** iOS slider: thin track, tinted progress, 28px white thumb with a 44px hit area. */
export function Slider({ value, onChange, min, max, step, label, valueText, disabled, className, trackClassName }: SliderProps) {
  return (
    <RadixSlider.Root
      value={[value]}
      onValueChange={(values) => {
        const next = values[0];
        if (typeof next === "number") onChange(next);
      }}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      className={cn("relative flex h-11 w-full touch-none select-none items-center", className)}
    >
      <RadixSlider.Track className={cn("relative h-1 w-full grow overflow-hidden rounded-full bg-fill", trackClassName)}>
        <RadixSlider.Range className="absolute h-full rounded-full bg-tint-fill" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        aria-label={label}
        aria-valuetext={valueText?.(value)}
        className="relative block size-7 rounded-full bg-white shadow-[0_0.5px_4px_rgba(0,0,0,0.12),0_6px_13px_rgba(0,0,0,0.12)] outline-none transition-transform focus-visible:ring-[3px] focus-visible:ring-tint/50 active:scale-110 before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
      />
    </RadixSlider.Root>
  );
}
