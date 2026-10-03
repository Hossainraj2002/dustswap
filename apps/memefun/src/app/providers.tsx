"use client";

import { Suspense, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { ThemeProvider, useTheme } from "@/components/theme/ThemeProvider";
import { Toaster } from "@/components/ui/Toaster";
import { MarketProvider } from "@/lib/market/MarketProvider";
import { PreviewProvider } from "@/lib/preview/scenario";
import { WalletProvider } from "@/lib/wallet/WalletProvider";

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster theme={resolvedTheme} />;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 15_000, gcTime: 5 * 60_000, retry: 2, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* useSearchParams in PreviewProvider needs a Suspense boundary for static rendering. */}
        <Suspense fallback={null}>
          <PreviewProvider>
            <WalletProvider>
              <MarketProvider>
                <MotionConfig reducedMotion="user">
                  {children}
                  <ThemedToaster />
                </MotionConfig>
              </MarketProvider>
            </WalletProvider>
          </PreviewProvider>
        </Suspense>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
