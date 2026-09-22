import type { Metadata } from "next";
import { AdminUserExplorer } from "@/components/admin/AdminUserExplorer";

export const metadata: Metadata = {
  title: "DustSwap Admin — User explorer",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminUsersPage() {
  return <AdminUserExplorer />;
}
