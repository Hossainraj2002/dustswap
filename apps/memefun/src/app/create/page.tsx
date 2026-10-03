import type { Metadata } from "next";
import { CreateScreen } from "@/components/create/CreateScreen";

export const metadata: Metadata = {
  title: "Create a coin",
  description: "Launch a meme coin on Base in one transaction. Fixed supply, no admin keys, liquidity locked forever.",
};

export default function CreatePage() {
  return <CreateScreen />;
}
