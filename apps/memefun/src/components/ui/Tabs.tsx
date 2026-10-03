"use client";

import { useId, type ReactNode } from "react";
import { Tabs as RadixTabs } from "radix-ui";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { spring } from "@/lib/motion";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
  content: ReactNode;
}

interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  listClassName?: string;
}

/**
 * Pill tabs (App Store style): a horizontally scrolling row that works for
 * more options than fit a segmented control. Radix supplies the tab semantics
 * and arrow-key navigation.
 */
export function Tabs<T extends string>({ items, value, onChange, label, className, listClassName }: TabsProps<T>) {
  const id = useId();
  return (
    <RadixTabs.Root value={value} onValueChange={(next) => onChange(next as T)} className={className}>
      <RadixTabs.List aria-label={label} className={cn("mf-scroll-x -mx-4 flex gap-1.5 px-4 py-1", listClassName)}>
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <RadixTabs.Trigger
              key={item.value}
              value={item.value}
              className={cn(
                "group relative inline-flex h-9 shrink-0 items-center rounded-full px-4 text-subhead font-semibold transition-colors",
                "before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']",
                selected ? "text-bg" : "text-label",
              )}
            >
              {/* Pill first, label positioned after it: paint order keeps the label on top. */}
              {selected ? (
                <motion.span layoutId={`tab-pill-${id}`} transition={spring.snappy} className="absolute inset-0 rounded-full bg-label" />
              ) : (
                <span className="absolute inset-0 rounded-full bg-fill-3 transition-colors group-hover:bg-fill-2" aria-hidden />
              )}
              <span className="relative inline-flex items-center gap-1.5">
                {item.label}
                {item.count !== undefined ? (
                  <span className={cn("mf-num text-footnote", selected ? "text-bg/70" : "text-label-2")}>{item.count}</span>
                ) : null}
              </span>
            </RadixTabs.Trigger>
          );
        })}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="outline-none focus-visible:outline-none">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
