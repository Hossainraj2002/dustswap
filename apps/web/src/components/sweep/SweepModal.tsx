"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type OpenModal = { layer: number; dialog: HTMLDivElement };
const openModals: OpenModal[] = [];
let overflowBeforeModals = "";
let focusBeforeModals: HTMLElement | null = null;

function topModal() {
  return openModals.reduce<OpenModal | undefined>(
    (top, modal) => !top || modal.layer >= top.layer ? modal : top,
    undefined,
  );
}

// The backdrop covers navigation, while the dialog aligns with the sweep widget.
export function SweepModal({
  children,
  onClose,
  className = "z-[90] bg-slate-950/45",
  labelledBy,
  label,
  layer = 90,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  labelledBy?: string;
  label?: string;
  layer?: number;
}) {
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (openModals.length === 0) {
      focusBeforeModals = document.activeElement as HTMLElement | null;
      overflowBeforeModals = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const modal = { layer, dialog };
    openModals.push(modal);
    if (topModal() === modal) dialog.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (topModal() !== modal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const wasTopModal = topModal() === modal;
      openModals.splice(openModals.indexOf(modal), 1);
      const nextModal = topModal();
      if (!nextModal) {
        document.body.style.overflow = overflowBeforeModals;
        if (focusBeforeModals?.isConnected) focusBeforeModals.focus({ preventScroll: true });
        focusBeforeModals = null;
      } else if (wasTopModal) {
        nextModal.dialog.focus({ preventScroll: true });
      }
    };
  }, [mounted, layer]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`fixed inset-0 backdrop-blur-sm ${className}`}
      style={{ zIndex: layer }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
        className="sweep-modal-stage pointer-events-none absolute inset-y-0 right-0 flex items-center justify-center px-3 pb-[calc(0.75rem+var(--safe-area-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] outline-none sm:px-4 sm:py-6"
      >
        <div className="pointer-events-auto contents">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
