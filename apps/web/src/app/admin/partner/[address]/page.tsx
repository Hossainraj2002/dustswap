import type { Metadata } from "next";
import { PartnerAdminMemberPage } from "@/components/partner/PartnerAdminMemberPage";

export const metadata: Metadata = {
  title: "DustSwap Partner Profile",
  robots: {
    index: false,
    follow: false,
  },
};

type AdminPartnerMemberPageProps = {
  params: Promise<{
    address: string;
  }>;
};

export default async function AdminPartnerMemberPageRoute({
  params,
}: AdminPartnerMemberPageProps) {
  const { address } = await params;
  return <PartnerAdminMemberPage address={address} />;
}
