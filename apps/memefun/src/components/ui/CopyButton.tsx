"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/** Copies text and confirms in place. The confirmation is announced politely. */
export function CopyButton({ value, label, className, children }: { value: string; label: string; className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (insecure context, permissions). Fall back to a selection copy.
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      setCopied(ok);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "relative inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-footnote font-semibold text-label-2 transition-colors hover:bg-fill-3 hover:text-label",
        "before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
        className,
      )}
    >
      {children}
      {copied ? <Check className="size-3.5 text-up" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
