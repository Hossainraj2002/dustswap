import type {
  ProfileCompletionGuide as ProfileCompletionGuideState,
  ProfileCompletionNextStep,
  ProfileCompletionStepKey,
} from "@/lib/profileCompletion";

type ProfileCompletionTrackerProps = {
  guide: ProfileCompletionGuideState | null;
  isLoading?: boolean;
  isClaimingReward?: boolean;
  onContinue: (
    step: ProfileCompletionStepKey | "claim_reward"
  ) => void;
};

function CheckIcon() {
  return (
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
  );
}

function CircleIcon() {
  return (
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

function SparkIcon() {
  return (
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
        strokeWidth={2.2}
        d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"
      />
    </svg>
  );
}

function getPrimaryAction(
  guide: ProfileCompletionGuideState | null
): {
  step: ProfileCompletionStepKey | "claim_reward" | null;
  label: string;
  disabled: boolean;
} {
  if (!guide) {
    return {
      step: null,
      label: "Loading...",
      disabled: true,
    };
  }

  switch (guide.nextStep) {
    case "add_referral":
      return { step: "add_referral", label: "Add referral", disabled: false };
    case "connect_x":
      return { step: "connect_x", label: "Connect X", disabled: false };
    case "connect_discord":
      return {
        step: "connect_discord",
        label: "Connect Discord",
        disabled: false,
      };
    case "claim_reward":
      return {
        step: "claim_reward",
        label: "Claim 1,000 PP",
        disabled: false,
      };
    default:
      return {
        step: null,
        label: guide.rewardClaimed ? "1,000 PP claimed" : "Profile complete",
        disabled: true,
      };
  }
}

function getActiveStepKey(nextStep: ProfileCompletionNextStep) {
  return nextStep === "claim_reward" ? null : nextStep;
}

function getHelperCopy(guide: ProfileCompletionGuideState | null) {
  if (!guide) {
    return "Complete your profile to unlock your 1,000 PP bonus.";
  }

  if (guide.canClaimReward) {
    return "You've linked your referral, X, and Discord. Claim your 1,000 PP completion bonus.";
  }

  if (guide.rewardClaimed && guide.completedSteps < guide.totalSteps) {
    return "1,000 PP claimed. Reconnect the missing step to keep your profile complete.";
  }

  if (guide.rewardClaimed) {
    return "1,000 PP claimed.";
  }

  const activeStep = guide.steps.find((step) => step.key === guide.nextStep);
  if (activeStep) {
    return `Next: ${activeStep.label} to finish your profile.`;
  }

  return "Complete your profile to unlock your 1,000 PP bonus.";
}

function getRewardCopy(guide: ProfileCompletionGuideState | null) {
  if (guide?.canClaimReward) {
    return "You're eligible for the profile completion bonus.";
  }

  if (guide?.rewardClaimed) {
    return guide.completedSteps < guide.totalSteps
      ? "Bonus claimed. Reconnect the missing step to keep your profile complete."
      : "1,000 PP claimed.";
  }

  return "Unlock your 1,000 PP profile bonus.";
}

export function ProfileCompletionTracker({
  guide,
  isLoading = false,
  isClaimingReward = false,
  onContinue,
}: ProfileCompletionTrackerProps) {
  const activeStepKey = getActiveStepKey(guide?.nextStep ?? null);
  const primaryAction = getPrimaryAction(guide);
  const progressValue = guide?.completionPercent ?? 0;

  return (
    <section className="overflow-hidden rounded-[24px] border border-white/80 bg-[radial-gradient(circle_at_top_right,rgba(37,99,235,0.12),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,246,255,0.94))] p-3.5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] sm:rounded-[26px] sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-black uppercase tracking-[0.28em] text-sky-600">
            Profile completion
          </p>
          <h2 className="mt-1 text-base font-black tracking-tight text-slate-950 sm:text-lg">
            {guide?.canClaimReward ? "Profile complete" : "Complete your profile"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-600 sm:text-sm">
            {getHelperCopy(guide)}
          </p>
        </div>

        <div className="shrink-0 rounded-[16px] border border-sky-200 bg-white/92 px-2.5 py-2 text-right shadow-sm">
          <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-500">
            Progress
          </p>
          <p className="mt-0.5 text-lg font-black tracking-tight text-slate-950 sm:text-xl">
            {isLoading ? (
              <span className="animate-pulse opacity-50">--</span>
            ) : (
              `${progressValue}%`
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 h-2 rounded-full bg-slate-200/80">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,#2563eb,#38bdf8)] transition-[width] duration-300"
          style={{ width: `${progressValue}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {(guide?.steps || [
          { key: "add_referral", label: "Add referral", status: "incomplete" as const },
          { key: "connect_x", label: "Connect X", status: "incomplete" as const },
          {
            key: "connect_discord",
            label: "Connect Discord",
            status: "incomplete" as const,
          },
        ]).map((step) => {
          const complete = step.status === "complete";
          const active = activeStepKey === step.key;

          return (
            <button
              key={step.key}
              type="button"
              onClick={() => {
                if (!complete) {
                  onContinue(step.key);
                }
              }}
              disabled={complete}
              className={`flex min-h-[60px] flex-col items-start justify-center gap-1 rounded-[16px] border px-2.5 py-2 text-left transition ${
                complete
                  ? "cursor-default border-emerald-200 bg-emerald-50/85 text-emerald-800"
                  : active
                    ? "border-sky-300 bg-white text-slate-950 shadow-[0_10px_24px_rgba(37,99,235,0.12)]"
                    : "border-slate-200 bg-white/88 text-slate-700 hover:border-sky-200 hover:text-slate-950"
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
                {complete ? <CheckIcon /> : <CircleIcon />}
              </span>

              <span className="block min-w-0 text-[12px] font-black leading-4 tracking-tight">
                {step.label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-[18px] border border-slate-200/80 bg-white/88 p-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sky-600">
          <SparkIcon />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold leading-4 text-slate-700 sm:text-xs">
            {getRewardCopy(guide)}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            if (primaryAction.step) {
              onContinue(primaryAction.step);
            }
          }}
          disabled={primaryAction.disabled || isLoading || isClaimingReward}
          className={`inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-[14px] px-3.5 text-[13px] font-black transition ${
            primaryAction.disabled || isLoading || isClaimingReward
              ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
              : "bg-[linear-gradient(135deg,#2563eb,#0ea5e9)] text-white shadow-[0_10px_24px_rgba(37,99,235,0.18)]"
          }`}
        >
          {isClaimingReward && primaryAction.step === "claim_reward"
            ? "Claiming..."
            : primaryAction.label}
        </button>
      </div>
    </section>
  );
}
