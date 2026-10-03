import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/display";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="pt-16">
      <div className="mf-card">
        <EmptyState
          icon={<Compass aria-hidden />}
          title="This page does not exist"
          message="The link may be wrong, or the page moved."
          action={
            <Button asChild>
              <Link href="/">Go to Discover</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
