"use client";

import { useRef, type ReactNode } from "react";
import { Dialog, VisuallyHidden } from "radix-ui";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsRegularWidth } from "@/lib/hooks";
import { spring } from "@/lib/motion";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Hide the title visually but keep it for assistive tech. */
  hideTitle?: boolean;
  description?: string;
  children: ReactNode;
  /** Pinned under the scrolling content (primary action). */
  footer?: ReactNode;
  className?: string;
  /** Width of the centered dialog on regular widths. */
  maxWidth?: number;
}

const DISMISS_OFFSET = 120;
const DISMISS_VELOCITY = 700;

/**
 * HIG sheet. Compact width: a bottom sheet with a grabber that can be dragged
 * down to dismiss. Regular width: a centered dialog. Radix provides focus
 * trapping, Esc to close and the dialog semantics.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  children,
  footer,
  className,
  maxWidth = 480,
}: SheetProps) {
  const regular = useIsRegularWidth();
  const dragControls = useDragControls();
  const opener = useRef<HTMLElement | null>(null);

  // Move focus to the sheet itself rather than its first control, as iOS does:
  // nothing looks pre-selected and a stray tap cannot hit Close. Remember what
  // opened the sheet first: Radix only returns focus to a Dialog.Trigger, and
  // these sheets are opened from ordinary buttons.
  const onOpenAutoFocus = (event: Event) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.focus();
  };

  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onOpenChange(false);
  };

  const header = (
    <div className={cn("flex items-start gap-3 px-5", regular ? "pt-5" : "pt-2")}>
      <div className="min-w-0 flex-1">
        {hideTitle ? (
          <VisuallyHidden.Root>
            <Dialog.Title>{title}</Dialog.Title>
          </VisuallyHidden.Root>
        ) : (
          <Dialog.Title className="text-title3 text-label">{title}</Dialog.Title>
        )}
        {description ? (
          <Dialog.Description className="mt-1 text-subhead text-label-2">{description}</Dialog.Description>
        ) : (
          <VisuallyHidden.Root>
            <Dialog.Description>{title}</Dialog.Description>
          </VisuallyHidden.Root>
        )}
      </div>
      <Dialog.Close
        className="relative -mr-1 inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-fill-3 text-label-2 transition-colors hover:bg-fill-2 before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
        aria-label="Close"
      >
        <X className="size-4" strokeWidth={2.4} aria-hidden />
      </Dialog.Close>
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22 }}
              />
            </Dialog.Overlay>
            {regular ? (
              <Dialog.Content asChild forceMount onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
                <motion.div
                  className={cn(
                    "fixed left-1/2 top-1/2 z-50 flex max-h-[min(86vh,760px)] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-float outline-none mf-squircle",
                    className,
                  )}
                  style={{ maxWidth }}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={spring.sheet}
                >
                  {header}
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
                  {footer ? <div className="hairline-t px-5 py-4">{footer}</div> : null}
                </motion.div>
              </Dialog.Content>
            ) : (
              <Dialog.Content asChild forceMount onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
                <motion.div
                  className={cn(
                    "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-xl bg-bg-elevated shadow-float outline-none",
                    className,
                  )}
                  initial={{ y: "100%" }}
                  animate={{ y: 0 }}
                  exit={{ y: "100%" }}
                  transition={spring.sheet}
                  drag="y"
                  dragListener={false}
                  dragControls={dragControls}
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0.04, bottom: 0.7 }}
                  onDragEnd={onDragEnd}
                >
                  <div
                    className="flex cursor-grab touch-none justify-center pb-1 pt-2 active:cursor-grabbing"
                    onPointerDown={(event) => dragControls.start(event)}
                    aria-hidden
                  >
                    <span className="h-[5px] w-9 rounded-full bg-label-3" />
                  </div>
                  <div className="touch-none" onPointerDown={(event) => dragControls.start(event)}>
                    {header}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-4">{children}</div>
                  {footer ? (
                    <div className="hairline-t px-5 pt-3" style={{ paddingBottom: "max(16px, var(--mf-safe-bottom))" }}>
                      {footer}
                    </div>
                  ) : (
                    <div style={{ height: "var(--mf-safe-bottom)" }} />
                  )}
                </motion.div>
              </Dialog.Content>
            )}
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
