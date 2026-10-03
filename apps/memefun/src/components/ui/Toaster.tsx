"use client";

import { Toaster as Sonner } from "sonner";
import { useIsRegularWidth } from "@/lib/hooks";

/** iOS banner-style notifications: top on phones, bottom-right on desktop. */
export function Toaster({ theme }: { theme: "light" | "dark" }) {
  const regular = useIsRegularWidth();
  return (
    <Sonner
      theme={theme}
      position={regular ? "bottom-right" : "top-center"}
      offset={regular ? 24 : 12}
      gap={8}
      visibleToasts={3}
      toastOptions={{
        classNames: {
          toast: "rounded-lg! border-0! bg-bg-elevated! text-label! shadow-float! font-sans! text-subhead! px-4! py-3!",
          title: "font-semibold! text-subhead!",
          description: "text-footnote! text-label-2!",
          actionButton: "bg-tint-fill! text-on-tint! rounded-full! font-semibold!",
        },
      }}
    />
  );
}
