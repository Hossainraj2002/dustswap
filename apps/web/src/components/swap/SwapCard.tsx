import React from 'react';

interface SwapCardProps {
  children: React.ReactNode;
}

export function SwapCard({ children }: SwapCardProps) {
  return (
    <div className="flex flex-col min-h-screen pb-safe relative overflow-hidden bg-[#030305]">
      {/* 3D Ambient Background Elements */}
      <div className="ambient-glow ambient-glow--purple" />
      <div className="ambient-glow ambient-glow--blue" />
      
      <div className="dust-particles">
        <div className="dust-particle dust-particle--1"></div>
        <div className="dust-particle dust-particle--2"></div>
        <div className="dust-particle dust-particle--3"></div>
        <div className="dust-particle dust-particle--4"></div>
        <div className="dust-particle dust-particle--5"></div>
        <div className="dust-particle dust-particle--6"></div>
        <div className="dust-particle dust-particle--7"></div>
        <div className="dust-particle dust-particle--8"></div>
      </div>

      {/* Main Content Container */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 lg:p-6 z-10 relative">
        <div className="w-full max-w-md mx-auto swap-container">
          <div className="swap-glass p-3 sm:p-5 relative transform perspective-[1000px]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
