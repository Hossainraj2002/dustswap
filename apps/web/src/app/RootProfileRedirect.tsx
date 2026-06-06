"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RootProfileRedirect({ target }: { target: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(target);
  }, [router, target]);

  return null;
}
