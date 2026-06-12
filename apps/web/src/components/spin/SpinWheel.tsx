"use client";

import Image from "next/image";
import {
  type SpinRewardKey,
  SPIN_SEGMENT_ANGLE,
  SPIN_WHEEL_SEGMENTS,
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

const VIEWBOX = 400;
const CENTER = VIEWBOX / 2;
const WEDGE_RADIUS = 200;
const RIM_RADIUS = 191;
const RIM_WIDTH = 15;
const RIM_INNER_EDGE = RIM_RADIUS - RIM_WIDTH / 2;
const SEPARATOR_INNER = 50;
const LABEL_RADIUS = 134;
const HUB_RING_RADIUS = 54;
const STUD_SIZE = 4.5;

function polarPoint(radius: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: Number((CENTER + radius * Math.cos(rad)).toFixed(2)),
    y: Number((CENTER + radius * Math.sin(rad)).toFixed(2)),
  };
}

function wedgePath(startAngle: number, endAngle: number, radius = WEDGE_RADIUS) {
  const start = polarPoint(radius, startAngle);
  const end = polarPoint(radius, endAngle);
  return `M ${CENTER} ${CENTER} L ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y} Z`;
}

export function SpinWheel({
  rotation,
  activeRewardKey,
  isSpinning = false,
}: SpinWheelProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const activeIndex = SPIN_WHEEL_SEGMENTS.findIndex(
    (segment) => segment.key === activeRewardKey
  );

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[420px]">
      <div className="pointer-events-none absolute inset-x-0 top-[1.5%] z-30 flex justify-center">
        <div className="relative">
          <div className="absolute left-1/2 top-0 h-14 w-14 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.2),transparent_72%)] blur-xl" />
          <svg
            width="44"
            height="38"
            viewBox="0 0 44 38"
            className="relative drop-shadow-[0_10px_22px_rgba(15,23,42,0.32)]"
            aria-hidden="true"
          >
            <path
              d="M6 5 L38 5 L25 29.5 Q22 34.5 19 29.5 Z"
              fill="#0f172a"
              stroke="rgba(255,255,255,0.92)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      <div className="spin-wheel-shell absolute inset-[3%] rounded-full bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.95),rgba(191,219,254,0.7)_45%,rgba(147,197,253,0.25)_68%,rgba(14,165,233,0.14)_100%)] p-3 shadow-[0_28px_80px_rgba(59,130,246,0.22)]">
        <div className="spin-wheel-face relative h-full w-full overflow-hidden rounded-full border border-white/80 shadow-[inset_0_2px_0_rgba(255,255,255,0.95),inset_0_-14px_32px_rgba(191,219,254,0.55)]">
          <svg
            viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
            className="absolute inset-0 h-full w-full"
            style={{
              transform: `rotate(${rotation}deg)`,
              transformOrigin: "50% 50%",
              willChange: "transform",
              transition: isSpinning
                ? "transform 4600ms cubic-bezier(0.16, 1, 0.3, 1)"
                : "transform 700ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            <defs>
              <filter id="spinActiveGlow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow
                  dx="0"
                  dy="0"
                  stdDeviation="8"
                  floodColor="#38bdf8"
                  floodOpacity="0.7"
                />
              </filter>
            </defs>

            {SPIN_WHEEL_SEGMENTS.map((segment, index) => {
              const startAngle = index * SPIN_SEGMENT_ANGLE;
              const endAngle = startAngle + SPIN_SEGMENT_ANGLE;

              return (
                <path
                  key={segment.key}
                  d={wedgePath(startAngle, endAngle)}
                  fill={isDark ? DARK_SEGMENT_FILLS[index] : segment.fill}
                />
              );
            })}

            {SPIN_WHEEL_SEGMENTS.map((segment, index) => {
              const angle = index * SPIN_SEGMENT_ANGLE;
              const inner = polarPoint(SEPARATOR_INNER, angle);
              const outer = polarPoint(RIM_INNER_EDGE, angle);

              return (
                <line
                  key={segment.key}
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={isDark ? "rgba(2,6,23,0.55)" : "rgba(255,255,255,0.95)"}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              );
            })}

            <circle
              cx={CENTER}
              cy={CENTER}
              r={HUB_RING_RADIUS}
              fill="none"
              stroke={isDark ? "rgba(125,211,252,0.25)" : "rgba(255,255,255,0.85)"}
              strokeWidth="1.5"
            />

            {activeIndex >= 0 && (
              <path
                d={wedgePath(
                  activeIndex * SPIN_SEGMENT_ANGLE,
                  (activeIndex + 1) * SPIN_SEGMENT_ANGLE,
                  RIM_INNER_EDGE
                )}
                fill="rgba(255,255,255,0.16)"
                stroke={isDark ? "#7dd3fc" : "#38bdf8"}
                strokeWidth="3"
                strokeLinejoin="round"
                filter="url(#spinActiveGlow)"
              />
            )}

            <circle
              cx={CENTER}
              cy={CENTER}
              r={RIM_RADIUS}
              fill="none"
              stroke={isDark ? "rgba(226,232,240,0.85)" : "#ffffff"}
              strokeWidth={RIM_WIDTH}
            />
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RIM_INNER_EDGE}
              fill="none"
              stroke={isDark ? "rgba(125,211,252,0.35)" : "rgba(186,230,253,0.9)"}
              strokeWidth="2"
            />

            {SPIN_WHEEL_SEGMENTS.map((segment, index) => {
              const stud = polarPoint(RIM_RADIUS, index * SPIN_SEGMENT_ANGLE);

              return (
                <circle
                  key={segment.key}
                  cx={stud.x}
                  cy={stud.y}
                  r={STUD_SIZE}
                  fill="#38bdf8"
                  stroke="rgba(255,255,255,0.9)"
                  strokeWidth="1.5"
                />
              );
            })}

            {SPIN_WHEEL_SEGMENTS.map((segment, index) => {
              const labelAngle =
                index * SPIN_SEGMENT_ANGLE + SPIN_SEGMENT_ANGLE / 2;
              const pos = polarPoint(LABEL_RADIUS, labelAngle);
              const active = activeIndex === index;

              return (
                <text
                  key={segment.key}
                  x={pos.x}
                  y={pos.y}
                  transform={`rotate(${labelAngle} ${pos.x} ${pos.y})`}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="spin-reward-text"
                  fill={isDark ? DARK_REWARD_ACCENTS[index] : segment.accent}
                  fontSize={active ? 25 : 23}
                  fontWeight="800"
                  letterSpacing="1.5"
                >
                  {segment.label}
                </text>
              );
            })}
          </svg>

          <div className="spin-wheel-gloss pointer-events-none absolute inset-0 rounded-full" />

          <div className="spin-center-white absolute left-1/2 top-1/2 z-20 h-[23%] w-[23%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-100 bg-white shadow-[0_16px_34px_rgba(59,130,246,0.18)]">
            <div className="spin-center-white absolute inset-[8%] rounded-full border border-sky-100 bg-white" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Image
                src="/logo.png"
                alt="DustSwap"
                width={40}
                height={40}
                className="h-[46%] w-[46%]"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
