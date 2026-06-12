"use client";

import Image from "next/image";
import { useMemo } from "react";
import {
  type SpinRewardKey,
  SPIN_SEGMENT_ANGLE,
  SPIN_WHEEL_SEGMENTS,
  getSpinWheelGradient,
} from "@/lib/spin";
import { useTheme } from "@/components/theme/ThemeProvider";

type SpinWheelProps = {
  rotation: number;
  activeRewardKey?: SpinRewardKey | null;
  isSpinning?: boolean;
};

const DARK_SEGMENT_FILLS = [
  "#0b6978",
  "#0d465f",
  "#102a52",
  "#0f5756",
  "#15376a",
  "#123f72",
  "#0b3b5b",
] as const;

const DARK_REWARD_ACCENTS = [
  "#ffffff",
  "#ccfbf1",
  "#bae6fd",
  "#99f6e4",
  "#93c5fd",
  "#bfdbfe",
  "#dbeafe",
] as const;

function getDarkSpinWheelGradient() {
  const stops = SPIN_WHEEL_SEGMENTS.map((_, index) => {
    const start = index * SPIN_SEGMENT_ANGLE;
    const end = start + SPIN_SEGMENT_ANGLE;
    return `${DARK_SEGMENT_FILLS[index]} ${start}deg ${end}deg`;
  });

  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

export function SpinWheel({
  rotation,
  activeRewardKey,
  isSpinning = false,
}: SpinWheelProps) {
  const { resolvedTheme } = useTheme();
  const lightGradient = useMemo(() => getSpinWheelGradient(), []);
  const darkGradient = useMemo(() => getDarkSpinWheelGradient(), []);
  const isDark = resolvedTheme === "dark";
  const gradient = isDark ? darkGradient : lightGradient;

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[420px]">
      <div className="pointer-events-none absolute inset-x-0 top-1 z-20 flex justify-center">
        <div className="relative">
          <div className="absolute left-1/2 top-0 h-14 w-14 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.2),transparent_72%)] blur-xl" />
          <div className="relative h-0 w-0 border-l-[18px] border-r-[18px] border-t-[30px] border-l-transparent border-r-transparent border-t-[#0f172a] drop-shadow-[0_10px_22px_rgba(15,23,42,0.28)]" />
        </div>
      </div>

      <div className="spin-wheel-shell absolute inset-[3%] rounded-full bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.95),rgba(191,219,254,0.7)_45%,rgba(147,197,253,0.25)_68%,rgba(14,165,233,0.14)_100%)] p-3 shadow-[0_28px_80px_rgba(59,130,246,0.22)]">
        <div
          className="spin-wheel-face relative h-full w-full rounded-full border border-white/80 shadow-[inset_0_2px_0_rgba(255,255,255,0.95),inset_0_-14px_32px_rgba(191,219,254,0.55)]"
          style={{
            backgroundImage: gradient,
            transform: `rotate(${rotation}deg)`,
            transition: isSpinning
              ? "transform 4600ms cubic-bezier(0.16, 1, 0.3, 1)"
              : "transform 700ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <div className="spin-wheel-outer-rim absolute inset-0 rounded-full border-[10px] border-white/65" />
          <div className="spin-wheel-inner-rim absolute inset-[6%] rounded-full border border-sky-200/70" />
          <div className="spin-wheel-prize-band pointer-events-none absolute inset-[13%] rounded-full border border-white/35" />

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
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{
                    transform: `translate(-50%, -50%) rotate(${labelAngle}deg) translateY(clamp(-116px, -24vw, -82px))`,
                  }}
                >
                  <div
                    data-active={active ? "true" : "false"}
                    className={`spin-reward-pill flex h-[24px] w-[72px] items-center justify-center rounded-full border px-1.5 py-1 text-center sm:h-[26px] sm:w-[82px] ${
                      active
                        ? "border-sky-200 bg-white/88 shadow-[0_10px_24px_rgba(59,130,246,0.2)] backdrop-blur-md"
                        : "border-transparent bg-transparent shadow-none"
                    }`}
                  >
                    <p
                      className="spin-reward-text text-[10px] font-black uppercase leading-none tracking-[0.08em] sm:text-[11px]"
                      style={{
                        color: isDark ? DARK_REWARD_ACCENTS[index] : segment.accent,
                      }}
                    >
                      {segment.label}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="spin-center-white absolute left-1/2 top-1/2 z-20 h-[58px] w-[58px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-100 bg-white shadow-[0_16px_34px_rgba(59,130,246,0.18)] sm:h-[72px] sm:w-[72px]">
            <div className="spin-center-white absolute inset-[8%] rounded-full border border-sky-100 bg-white" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Image
                src="/logo.png"
                alt="DustSwap"
                width={34}
                height={34}
                className="h-7 w-7 sm:h-9 sm:w-9"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
