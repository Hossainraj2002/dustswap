import type { Metadata } from "next";
import { PartnerAdminConsole } from "@/components/partner/PartnerAdminConsole";

export const metadata: Metadata = {
  title: "DustSwap Partner Admin",
  robots: {
    index: false,
    follow: false,
  },
};

export default function PartnerAdminPage() {
  return <PartnerAdminConsole mode="manager" />;
}
