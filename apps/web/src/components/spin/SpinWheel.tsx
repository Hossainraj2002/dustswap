"use client";

import { useMemo } from "react";
import {
  type SpinRewardKey,
  SPIN_SEGMENT_ANGLE,
  SPIN_WHEEL_SEGMENTS,
  getSpinWheelGradient,
} from "@/lib/spin";

type SpinWheelProps = {
  rotation: number;
  activeRewardKey?: SpinRewardKey | null;
  isSpinning?: boolean;
};

export function SpinWheel({
  rotation,
  activeRewardKey,
  isSpinning = false,
}: SpinWheelProps) {
  const gradient = useMemo(() => getSpinWheelGradient(), []);
  const activeReward = activeRewardKey
    ? SPIN_WHEEL_SEGMENTS.find((segment) => segment.key === activeRewardKey) || null
    : null;

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[420px]">
      <div className="pointer-events-none absolute inset-x-0 top-1 z-20 flex justify-center">
        <div className="relative">
          <div className="absolute left-1/2 top-0 h-14 w-14 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.2),transparent_72%)] blur-xl" />
          <div className="relative h-0 w-0 border-l-[18px] border-r-[18px] border-t-[30px] border-l-transparent border-r-transparent border-t-[#0f172a] drop-shadow-[0_10px_22px_rgba(15,23,42,0.28)]" />
        </div>
      </div>

      <div className="absolute inset-[3%] rounded-full bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.95),rgba(191,219,254,0.7)_45%,rgba(147,197,253,0.25)_68%,rgba(14,165,233,0.14)_100%)] p-3 shadow-[0_28px_80px_rgba(59,130,246,0.22)]">
        <div
          className="relative h-full w-full rounded-full border border-white/80 shadow-[inset_0_2px_0_rgba(255,255,255,0.95),inset_0_-14px_32px_rgba(191,219,254,0.55)]"
          style={{
            backgroundImage: gradient,
            transform: `rotate(${rotation}deg)`,
            transition: isSpinning
              ? "transform 4600ms cubic-bezier(0.16, 1, 0.3, 1)"
              : "transform 700ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <div className="absolute inset-0 rounded-full border-[10px] border-white/65" />
          <div className="absolute inset-[6%] rounded-full border border-sky-200/70" />

          {SPIN_WHEEL_SEGMENTS.map((segment, index) => {
            const angle = index * SPIN_SEGMENT_ANGLE;
            const labelAngle = angle + SPIN_SEGMENT_ANGLE / 2;
            const active = activeRewardKey === segment.key;

            return (
              <div key={segment.key}>
                <div
                  className="absolute left-1/2 top-1/2 h-[45%] w-px origin-bottom bg-white/75"
                  style={{
                    transform: `translate(-50%, -100%) rotate(${angle}deg)`,
                  }}
                />
                <div
                  className="absolute left-1/2 top-1/2 w-[32%] -translate-x-1/2 -translate-y-1/2 text-center"
                  style={{
                    transform: `translate(-50%, -50%) rotate(${labelAngle}deg) translateY(-145%) rotate(${-labelAngle}deg)`,
                  }}
                >
                  <div
                    className={`rounded-[18px] border px-2 py-2 shadow-[0_10px_20px_rgba(255,255,255,0.24)] ${
                      active
                        ? "border-sky-200 bg-white/95"
                        : "border-white/60 bg-white/78"
                    }`}
                  >
                    <p
                      className="text-[11px] font-black uppercase tracking-[0.08em]"
                      style={{ color: segment.accent }}
                    >
                      {segment.label}
                    </p>
                    <p className="mt-1 text-[10px] font-semibold text-slate-500">
                      {segment.probability}%
                    </p>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="absolute inset-[34%] rounded-full border border-white/85 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.98),rgba(239,246,255,0.96)_55%,rgba(191,219,254,0.86)_100%)] shadow-[0_20px_40px_rgba(59,130,246,0.18)]">
            <div className="absolute inset-[12%] rounded-full border border-sky-100 bg-white/90" />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-[32%] z-20 flex items-center justify-center">
        <div className="flex h-full w-full flex-col items-center justify-center rounded-full border border-white/90 bg-[radial-gradient(circle,rgba(255,255,255,0.98),rgba(219,234,254,0.94)_65%,rgba(147,197,253,0.8)_100%)] px-6 text-center shadow-[0_18px_40px_rgba(59,130,246,0.2)]">
          <p className="text-[10px] font-black uppercase tracking-[0.32em] text-sky-600">
            DustSpin
          </p>
          <p className="mt-2 text-lg font-black tracking-tight text-slate-950 sm:text-xl">
            {isSpinning ? "Spinning..." : activeReward?.label || "Free Spin"}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-slate-500 sm:text-xs">
            {isSpinning
              ? "Wheel is locking your onchain reward."
              : activeReward
                ? `${activeReward.probability}% probability`
                : "Blue-white reward wheel"}
          </p>
        </div>
      </div>
    </div>
  );
}
