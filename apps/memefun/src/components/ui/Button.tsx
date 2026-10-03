"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "filled" | "tinted" | "gray" | "plain" | "buy" | "sell" | "destructive";
export type ButtonSize = "lg" | "md" | "sm";

const variantClasses: Record<ButtonVariant, string> = {
  filled: "bg-tint-fill text-on-tint hover:brightness-110 active:brightness-95",
  tinted: "bg-tint/10 text-tint hover:bg-tint/14 active:bg-tint/14",
  gray: "bg-fill-3 text-label hover:bg-fill-2 active:bg-fill",
  plain: "bg-transparent text-tint hover:bg-tint/8 active:bg-tint/14",
  buy: "bg-up-fill text-on-tint font-semibold hover:brightness-110 active:brightness-95",
  sell: "bg-down-fill text-on-tint font-semibold hover:brightness-110 active:brightness-95",
  destructive: "bg-down/10 text-down hover:bg-down/14 active:bg-down/14",
};

// Every size keeps at least a 44px hit target (HIG). `sm` draws a 34px
// capsule and extends its hit area invisibly with ::before.
const sizeClasses: Record<ButtonSize, string> = {
  lg: "h-[52px] px-6 rounded-md text-headline",
  md: "h-11 px-4 rounded-sm text-headline",
  sm: "h-[34px] px-3.5 rounded-full text-subhead font-semibold before:absolute before:-inset-x-1 before:-inset-y-[5px] before:content-['']",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the child element (usually a Link) with button styling. */
  asChild?: boolean;
  loading?: boolean;
  /** Read by assistive tech while loading, e.g. "Launching". */
  loadingLabel?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "filled",
    size = "md",
    asChild = false,
    loading = false,
    loadingLabel,
    leading,
    trailing,
    fullWidth = false,
    className,
    children,
    disabled,
    type,
    ...props
  },
  ref,
) {
  const classes = cn(
    "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[filter,background-color,opacity,transform] duration-150 ease-out",
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
    variantClasses[variant],
    sizeClasses[size],
    fullWidth && "w-full",
    className,
  );

  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="size-[1.1em]" />
          <span>{loadingLabel ?? children}</span>
        </>
      ) : (
        <>
          {leading}
          {children}
          {trailing}
        </>
      )}
    </button>
  );
});
