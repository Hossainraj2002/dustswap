import type {
  ProfileCompletionGuide as ProfileCompletionGuideState,
  ProfileCompletionStepKey,
} from "@/lib/profileCompletion";
import { ProfileCompletionModal } from "@/components/profile/ProfileCompletionModal";
import { ProfileCompletionTracker } from "@/components/profile/ProfileCompletionTracker";

type ProfileCompletionGuideProps = {
  guide: ProfileCompletionGuideState | null;
  isLoading?: boolean;
  isModalOpen: boolean;
  isClaimingReward?: boolean;
  onContinue: (
    step: ProfileCompletionStepKey | "claim_reward"
  ) => void;
  onDismissModal: () => void;
};

export function ProfileCompletionGuide({
  guide,
  isLoading = false,
  isModalOpen,
  isClaimingReward = false,
  onContinue,
  onDismissModal,
}: ProfileCompletionGuideProps) {
  return (
    <>
      <ProfileCompletionTracker
        guide={guide}
        isLoading={isLoading}
        isClaimingReward={isClaimingReward}
        onContinue={onContinue}
      />

      <ProfileCompletionModal
        open={isModalOpen}
        guide={guide}
        isBusy={isClaimingReward}
        onContinue={onContinue}
        onDismiss={onDismissModal}
      />
    </>
  );
}
