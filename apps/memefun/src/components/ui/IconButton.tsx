"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only controls need a spoken name. */
  label: string;
  icon: ReactNode;
  variant?: "gray" | "plain" | "glass" | "tinted";
  size?: "md" | "sm";
}

/** Circular icon control. The visible circle may be 36px; the hit target is always 44px. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "gray", size = "md", className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,transform] duration-150 active:scale-95 disabled:opacity-40",
        "before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        size === "md" ? "size-9 [&_svg]:size-[18px]" : "size-8 [&_svg]:size-4",
        variant === "gray" && "bg-fill-3 text-label hover:bg-fill-2",
        variant === "plain" && "text-tint hover:bg-tint/10",
        variant === "tinted" && "bg-tint/10 text-tint hover:bg-tint/18",
        variant === "glass" && "mf-glass text-label",
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
});
