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
      className="h-4 w-4"
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
      className="h-4 w-4"
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
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/42 px-3 pb-6 pt-8 backdrop-blur-sm sm:items-center sm:px-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-completion-modal-title"
        className="w-full max-w-md overflow-hidden rounded-[28px] border border-white/80 bg-[radial-gradient(circle_at_top_right,rgba(37,99,235,0.12),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.99),rgba(239,246,255,0.97))] shadow-[0_32px_90px_rgba(15,23,42,0.24)]"
      >
        <div className="h-[3px] bg-[linear-gradient(90deg,#2563eb,#38bdf8,#60a5fa)]" />

        <div className="px-5 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-sky-600">
                Profile completion
              </p>
              <h2
                id="profile-completion-modal-title"
                className="mt-2 text-2xl font-black tracking-tight text-slate-950"
              >
                Complete your profile
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Finish 3 quick steps to unlock your full DustSwap profile and claim 1,000 PP.
              </p>
            </div>

            <div className="shrink-0 rounded-[18px] border border-sky-200 bg-white/90 px-3 py-2 text-right shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                Progress
              </p>
              <p className="mt-1 text-lg font-black tracking-tight text-slate-950">
                {guide.completionPercent}%
              </p>
            </div>
          </div>

          <div className="mt-4 h-2.5 rounded-full bg-slate-200/80">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,#2563eb,#0ea5e9)] transition-[width] duration-300"
              style={{ width: `${guide.completionPercent}%` }}
            />
          </div>

          <div className="mt-5 space-y-2">
            {guide.steps.map((step) => {
              const complete = step.status === "complete";
              const active = guide.nextStep === step.key;

              return (
                <div
                  key={step.key}
                  className={`flex items-center gap-3 rounded-[18px] border px-3 py-3 ${
                    complete
                      ? "border-emerald-200 bg-emerald-50/80 text-emerald-800"
                      : active
                        ? "border-sky-300 bg-white text-slate-950 shadow-[0_10px_24px_rgba(37,99,235,0.08)]"
                        : "border-slate-200 bg-white/85 text-slate-700"
                  }`}
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${
                      complete
                        ? "border-emerald-200 bg-white text-emerald-600"
                        : active
                          ? "border-sky-200 bg-sky-50 text-sky-600"
                          : "border-slate-200 bg-slate-50 text-slate-400"
                    }`}
                  >
                    <StepStatusIcon complete={complete} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-black tracking-tight">{step.label}</p>
                    <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.18em] opacity-70">
                      {complete ? "Complete" : active ? "Up next" : "Incomplete"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-4 text-sm leading-6 text-slate-500">
            You can continue anytime from your profile.
          </p>

          <div className="mt-5 flex gap-2.5">
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[46px] flex-1 rounded-[16px] border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50"
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
              className={`min-h-[46px] flex-1 rounded-[16px] px-4 py-2.5 text-sm font-black transition ${
                !action.step || isBusy
                  ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
                  : "bg-[linear-gradient(135deg,#2563eb,#0ea5e9)] text-white shadow-[0_14px_30px_rgba(37,99,235,0.22)] hover:-translate-y-0.5"
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
