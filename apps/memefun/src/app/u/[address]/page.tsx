import type { Metadata } from "next";
import { ProfileScreen } from "@/components/profile/ProfileScreen";

export const metadata: Metadata = { title: "Profile" };

export default async function UserPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <ProfileScreen address={address} />;
}
