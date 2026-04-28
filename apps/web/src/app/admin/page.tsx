import type { Metadata } from "next";
import { PartnerAdminConsole } from "@/components/partner/PartnerAdminConsole";

export const metadata: Metadata = {
  title: "DustSwap Admin",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminOverviewPage() {
  return <PartnerAdminConsole mode="overview" />;
}
