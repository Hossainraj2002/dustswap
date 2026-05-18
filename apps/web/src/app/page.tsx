import FootprintDropLanding from "@/components/landing/FootprintDropLanding";

const FOOTPRINT_DROP_COUNTDOWN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FOOTPRINT_DROP_COUNTDOWN_END_AT = new Date(
  Date.now() + FOOTPRINT_DROP_COUNTDOWN_DURATION_MS
).toISOString();

type HomePageProps = {
  searchParams?: Promise<{
    ref?: string | string[];
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const rawReferralCode = resolvedSearchParams?.ref;
  const initialReferralCode = Array.isArray(rawReferralCode)
    ? rawReferralCode[0] || null
    : rawReferralCode || null;

  return (
    <FootprintDropLanding
      initialReferralCode={initialReferralCode}
      countdownEndsAt={FOOTPRINT_DROP_COUNTDOWN_END_AT}
    />
  );
}
