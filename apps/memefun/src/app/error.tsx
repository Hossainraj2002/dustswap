"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/display";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[memefun] page error", error);
  }, [error]);
  return (
    <div className="pt-16">
      <div className="mf-card">
        <EmptyState
          icon={<TriangleAlert aria-hidden />}
          title="Something went wrong on this page"
          message="Your funds are safe: nothing is sent without your confirmation. Try loading the page again."
          action={<Button onClick={reset}>Try again</Button>}
        />
      </div>
    </div>
  );
}
