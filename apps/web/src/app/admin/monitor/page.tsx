import type { Metadata } from "next";
import { AdminMonitorPanel } from "@/components/admin/AdminMonitorPanel";

export const metadata: Metadata = {
  title: "DustSwap Monitor",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminMonitorPage() {
  return <AdminMonitorPanel />;
}
