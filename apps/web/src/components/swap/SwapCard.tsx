import React from 'react';

interface SwapCardProps {
  children: React.ReactNode;
}

export function SwapCard({ children }: SwapCardProps) {
  return (
    <div className="flex flex-col min-h-screen pb-safe">
      <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-6">
        <div className="w-full max-w-md mx-auto swap-container">
          <div className="bg-[#0D111C] border border-[#1B2236] rounded-[24px] sm:rounded-3xl p-2 sm:p-4 shadow-2xl">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
