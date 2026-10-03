"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { spring } from "@/lib/motion";

export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  /** Spoken name when the label is not plain text. */
  ariaLabel?: string;
}

interface SegmentedControlProps<T extends string> {
  segments: ReadonlyArray<Segment<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive tech, e.g. "Sort coins". */
  label: string;
  size?: "md" | "sm";
  fullWidth?: boolean;
  className?: string;
  /** Tone of the selected segment, e.g. buy/sell colors. */
  selectedClassName?: (value: T) => string | undefined;
}

/**
 * iOS segmented control: a radio group with a sliding thumb. Arrow keys move
 * the selection, as with any radio group.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  size = "md",
  fullWidth = false,
  className,
  selectedClassName,
}: SegmentedControlProps<T>) {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const last = segments.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? (index === last ? 0 : index + 1)
            : (index === 0 ? last : index - 1);
    const next = segments[nextIndex];
    if (next) {
      onChange(next.value);
      refs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative inline-grid rounded-[10px] bg-fill-3 p-[2px]",
        fullWidth && "grid w-full",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
    >
      {segments.map((segment, index) => {
        const selected = segment.value === value;
        return (
          <button
            key={segment.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={segment.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(segment.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative flex min-w-0 items-center justify-center rounded-[8px] px-3 font-semibold transition-colors duration-150",
              size === "md" ? "h-9 text-subhead" : "h-8 text-footnote",
              // Keep a 44px hit target even though the visual is shorter.
              "before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']",
              // iOS draws every segment title in the primary label color; the thumb marks selection.
              "text-label",
            )}
          >
            {/* The thumb paints first and the title is positioned after it, so plain
                paint order keeps the title on top without negative z-index tricks. */}
            {selected ? (
              <motion.span
                layoutId={`segment-thumb-${id}`}
                transition={spring.snappy}
                className={cn(
                  "absolute inset-0 rounded-[8px] bg-bg-elevated shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366]",
                  selectedClassName?.(segment.value),
                )}
              />
            ) : null}
            <span className="relative truncate">{segment.label}</span>
          </button>
        );
      })}
    </div>
  );
}
