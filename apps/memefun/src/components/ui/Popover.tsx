"use client";

import { type ReactNode } from "react";
import { Popover as RadixPopover } from "radix-ui";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";

interface PopoverProps {
  trigger: ReactNode;
  /** Accessible name for the popover dialog, e.g. "Slippage". */
  label: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({ trigger, label, children, align = "center", side = "bottom", className, open, onOpenChange }: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          aria-label={label}
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            "z-50 w-72 rounded-lg bg-bg-elevated p-4 text-subhead text-label shadow-float outline-none mf-squircle",
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/**
 * An "i" button that explains a term. Uses a popover, not a hover tooltip,
 * so it works the same with touch, mouse and keyboard.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover
      label={label}
      trigger={
        <button
          type="button"
          aria-label={label}
          className="relative inline-flex size-5 items-center justify-center rounded-full text-label-2 transition-colors hover:text-label before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
        >
          <Info className="size-4" aria-hidden />
        </button>
      }
    >
      <p className="text-footnote leading-relaxed text-label-2">{children}</p>
    </Popover>
  );
}
