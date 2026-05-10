import type { Metadata } from "next";
import { MaintenanceClient } from "./MaintenanceClient";

export const metadata: Metadata = {
  title: "DustSwap Maintenance",
  description:
    "DustSwap is temporarily under maintenance while we upgrade our systems.",
};

export default function MaintenancePage() {
  return <MaintenanceClient />;
}
