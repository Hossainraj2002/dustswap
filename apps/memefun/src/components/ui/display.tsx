"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ Badge */

export type BadgeTone = "gray" | "tint" | "up" | "down" | "warning" | "creator" | "burn" | "holders" | "floor";

const badgeTones: Record<BadgeTone, string> = {
  gray: "bg-fill-3 text-label-2",
  tint: "bg-tint/10 text-tint",
  up: "bg-up/10 text-up",
  down: "bg-down/10 text-down",
  warning: "bg-warning/10 text-warning",
  creator: "bg-mode-creator/10 text-mode-creator",
  burn: "bg-mode-burn/10 text-mode-burn",
  holders: "bg-mode-holders/10 text-mode-holders",
  floor: "bg-mode-floor/10 text-mode-floor",
};

export function Badge({ tone = "gray", children, className, icon }: { tone?: BadgeTone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-caption1 font-semibold [&_svg]:size-3",
        badgeTones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------- ChangePill */

/** Apple Stocks style change capsule. Bold white label on a solid tone (3:1). */
export function ChangePill({ value, className, size = "md" }: { value: number; className?: string; size?: "md" | "sm" }) {
  const up = value > 0.00005;
  const down = value < -0.00005;
  const percent = Math.abs(value * 100);
  const digits = percent >= 1000 ? 0 : percent >= 100 ? 0 : percent >= 10 ? 1 : 2;
  const text = `${up ? "+" : down ? "-" : ""}${percent >= 10000 ? `${Math.round(percent / 1000)}K` : percent.toFixed(digits)}%`;
  return (
    <span
      className={cn(
        "mf-num inline-flex shrink-0 items-center justify-center rounded-[7px] font-bold text-on-tint",
        size === "md" ? "h-7 min-w-[72px] px-2 text-subhead" : "h-[22px] min-w-[58px] px-1.5 text-caption1",
        up ? "bg-up-fill" : down ? "bg-down-fill" : "bg-fill text-label",
        className,
      )}
    >
      {text}
    </span>
  );
}

/** Text-only change for dense rows. */
export function ChangeText({ value, className }: { value: number; className?: string }) {
  const up = value > 0.00005;
  const down = value < -0.00005;
  const percent = Math.abs(value * 100);
  const digits = percent >= 100 ? 0 : percent >= 10 ? 1 : 2;
  return (
    <span className={cn("mf-num font-semibold", up ? "text-up" : down ? "text-down" : "text-label-2", className)}>
      {up ? "+" : down ? "-" : ""}
      {percent >= 10000 ? `${Math.round(percent / 1000)}K` : percent.toFixed(digits)}%
    </span>
  );
}

/* ------------------------------------------------------------------- Chip */

export function Chip({
  selected,
  onClick,
  children,
  icon,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-subhead font-semibold transition-colors duration-150",
        "before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
        "[&_svg]:size-4",
        selected ? "bg-label text-bg" : "bg-fill-3 text-label hover:bg-fill-2",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- Card */

export function Card({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" }) {
  return <Tag className={cn("mf-card", className)}>{children}</Tag>;
}

/* ---------------------------------------------------------- Inset grouped list */

export function List({ header, footer, children, className }: { header?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {header ? <h3 className="px-4 text-footnote font-semibold uppercase tracking-wide text-label-2">{header}</h3> : null}
      <div className="mf-card overflow-hidden [&>*+*]:hairline-t">{children}</div>
      {footer ? <p className="px-4 text-footnote text-label-2">{footer}</p> : null}
    </section>
  );
}

interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
  chevron?: boolean;
  className?: string;
}

export function ListRow({ title, subtitle, leading, trailing, href, onClick, chevron, className }: ListRowProps) {
  const content = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-label">{title}</span>
        {subtitle ? <span className="truncate text-subhead text-label-2">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-2 text-body text-label-2">{trailing}</span> : null}
      {chevron ? <ChevronRight className="size-4 shrink-0 text-label-3" aria-hidden /> : null}
    </>
  );
  const classes = cn(
    "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left",
    (href || onClick) && "transition-colors hover:bg-fill-4 active:bg-fill-3",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {content}
      </button>
    );
  }
  return <div className={classes}>{content}</div>;
}

/* ---------------------------------------------------------------- KeyValue */

export function KeyValue({ label, value, className, emphasis }: { label: ReactNode; value: ReactNode; className?: string; emphasis?: boolean }) {
  return (
    <div className={cn("flex min-h-8 items-center justify-between gap-4 text-subhead", className)}>
      <span className="text-label-2">{label}</span>
      <span className={cn("mf-num text-right text-label", emphasis && "font-semibold")}>{value}</span>
    </div>
  );
}

/* -------------------------------------------------------------- Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mf-skeleton block", className)} />;
}

/* ----------------------------------------------------------- ProgressBar */

export function ProgressBar({
  value,
  label,
  className,
  tone = "tint",
}: {
  value: number;
  label: string;
  className?: string;
  tone?: "tint" | "warning" | "up";
}) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-fill-3", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]",
          tone === "tint" && "bg-tint-fill",
          tone === "warning" && "bg-warning-ring",
          tone === "up" && "bg-up-fill",
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------ EmptyState */

export function EmptyState({ icon, title, message, action, className }: { icon?: ReactNode; title: string; message?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-14 text-center", className)}>
      {icon ? <div className="flex size-14 items-center justify-center rounded-full bg-fill-3 text-label-2 [&_svg]:size-7">{icon}</div> : null}
      <h3 className="text-title3 text-label">{title}</h3>
      {message ? <p className="max-w-sm text-subhead text-label-2">{message}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------- SectionHeader */

export function SectionHeader({ title, action, className, id }: { title: ReactNode; action?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn("flex items-end justify-between gap-3", className)}>
      <h2 id={id} className="text-title2 text-label">
        {title}
      </h2>
      {action}
    </div>
  );
}
