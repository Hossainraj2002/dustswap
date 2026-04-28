import type { Metadata } from "next";
import { PartnerMemberPage } from "@/components/partner/PartnerMemberPage";

export const metadata: Metadata = {
  title: "DustSwap Partner",
  robots: {
    index: false,
    follow: false,
  },
};

export default function PartnerPage() {
  return <PartnerMemberPage />;
}
