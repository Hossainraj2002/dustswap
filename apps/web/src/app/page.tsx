import FootprintDropLanding from "@/components/landing/FootprintDropLanding";

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

  return <FootprintDropLanding initialReferralCode={initialReferralCode} />;
}
