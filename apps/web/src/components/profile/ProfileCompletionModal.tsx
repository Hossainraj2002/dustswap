import { useEffect, useMemo, useRef } from "react";
import type {
  ProfileCompletionGuide as ProfileCompletionGuideState,
  ProfileCompletionStepKey,
} from "@/lib/profileCompletion";

type ProfileCompletionModalProps = {
  open: boolean;
  guide: ProfileCompletionGuideState | null;
  isBusy?: boolean;
  onContinue: (
    step: ProfileCompletionStepKey | "claim_reward"
  ) => void;
  onDismiss: () => void;
};

function StepStatusIcon({ complete }: { complete: boolean }) {
  return complete ? (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.4}
        d="M5 13l4 4L19 7"
      />
    </svg>
  ) : (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" strokeWidth={2.2} />
    </svg>
  );
}

function getPrimaryAction(
  guide: ProfileCompletionGuideState | null
): {
  step: ProfileCompletionStepKey | "claim_reward" | null;
  label: string;
} {
  switch (guide?.nextStep) {
    case "add_referral":
      return { step: "add_referral", label: "Add referral" };
    case "connect_x":
      return { step: "connect_x", label: "Connect X" };
    case "connect_discord":
      return { step: "connect_discord", label: "Connect Discord" };
    case "claim_reward":
      return { step: "claim_reward", label: "Claim 1,000 PP" };
    default:
      return { step: null, label: "Profile complete" };
  }
}

export function ProfileCompletionModal({
  open,
  guide,
  isBusy = false,
  onContinue,
  onDismiss,
}: ProfileCompletionModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const action = useMemo(() => getPrimaryAction(guide), [guide]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      primaryButtonRef.current?.focus();
    }, 50);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("disabled"));

      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open]);

  if (!open || !guide) {
    return null;
  }

  return (
    <div className="fixed left-0 right-0 top-0 z-[90] flex items-end justify-center bg-slate-950/42 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-sm bottom-[calc(var(--ds-mobile-fixed-bottom-offset)+10px)] sm:bottom-0 sm:items-center sm:py-6">
      <button
        type="button"
        aria-label="Close profile completion"
        className="absolute inset-0 cursor-default"
        onClick={onDismiss}
      />

      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-completion-modal-title"
        className="relative w-full max-w-sm overflow-hidden rounded-[24px] border border-white/80 bg-[radial-gradient(circle_at_top_right,rgba(37,99,235,0.12),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.99),rgba(239,246,255,0.97))] shadow-[0_28px_80px_rgba(15,23,42,0.2)] sm:max-w-md sm:rounded-[26px]"
      >
        <div className="h-[3px] bg-[linear-gradient(90deg,#2563eb,#38bdf8,#60a5fa)]" />

        <div className="px-4 py-4 sm:px-5 sm:py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-black uppercase tracking-[0.28em] text-sky-600">
                Profile completion
              </p>
              <h2
                id="profile-completion-modal-title"
                className="mt-1.5 text-lg font-black tracking-tight text-slate-950 sm:text-xl"
              >
                Complete your profile
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-600 sm:text-sm">
                Finish 3 quick steps to unlock your profile and claim 1,000 PP.
              </p>
            </div>

            <div className="shrink-0 rounded-[16px] border border-sky-200 bg-white/92 px-2.5 py-2 text-right shadow-sm">
              <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">
                Progress
              </p>
              <p className="mt-0.5 text-base font-black tracking-tight text-slate-950 sm:text-lg">
                {guide.completionPercent}%
              </p>
            </div>
          </div>

          <div className="mt-3 h-2 rounded-full bg-slate-200/80">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,#2563eb,#0ea5e9)] transition-[width] duration-300"
              style={{ width: `${guide.completionPercent}%` }}
            />
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {guide.steps.map((step) => {
              const complete = step.status === "complete";
              const active = guide.nextStep === step.key;

              return (
                <div
                  key={step.key}
                  className={`flex min-h-[60px] flex-col items-start justify-center gap-1 rounded-[16px] border px-2.5 py-2 ${
                    complete
                      ? "border-emerald-200 bg-emerald-50/80 text-emerald-800"
                      : active
                        ? "border-sky-300 bg-white text-slate-950 shadow-[0_10px_24px_rgba(37,99,235,0.08)]"
                        : "border-slate-200 bg-white/85 text-slate-700"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                      complete
                        ? "border-emerald-200 bg-white text-emerald-600"
                        : active
                          ? "border-sky-200 bg-sky-50 text-sky-600"
                          : "border-slate-200 bg-slate-50 text-slate-400"
                    }`}
                  >
                    <StepStatusIcon complete={complete} />
                  </span>
                  <p className="text-[12px] font-black leading-4 tracking-tight">
                    {step.label}
                  </p>
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-[11px] leading-4 text-slate-500 sm:text-xs">
            You can continue anytime from your profile.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[40px] rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[13px] font-bold text-slate-600 transition hover:bg-slate-50"
            >
              Not now
            </button>
            <button
              ref={primaryButtonRef}
              type="button"
              onClick={() => {
                if (action.step) {
                  onContinue(action.step);
                }
              }}
              disabled={!action.step || isBusy}
              className={`min-h-[40px] rounded-[14px] px-3 py-2 text-[13px] font-black transition ${
                !action.step || isBusy
                  ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
                  : "bg-[linear-gradient(135deg,#2563eb,#0ea5e9)] text-white shadow-[0_10px_24px_rgba(37,99,235,0.18)]"
              }`}
            >
              {isBusy && action.step === "claim_reward" ? "Claiming..." : action.label}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
