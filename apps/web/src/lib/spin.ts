import type { Abi } from "viem";

export type SpinRewardKey =
  | "50_pp"
  | "100_pp"
  | "200_pp"
  | "250_pp"
  | "300_pp"
  | "400_pp"
  | "500_pp";

export type SpinRewardKind = "pp" | "usdc";

export type SpinWheelSegment = {
  key: SpinRewardKey;
  label: string;
  probability: number;
  type: SpinRewardKind;
  amount: number;
  fill: string;
  accent: string;
};

export const SPIN_CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_SPIN_CONTRACT_ADDRESS as
  | `0x${string}`
  | undefined;

export const SPIN_TRIGGER_ABI = [
  {
    type: "function",
    name: "spin",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

export const SPIN_WHEEL_SEGMENTS: readonly SpinWheelSegment[] = [
  {
    key: "500_pp",
    label: "500 PP",
    probability: 10,
    type: "pp",
    amount: 500,
    fill: "#93c5fd",
    accent: "#0f172a",
  },
  {
    key: "400_pp",
    label: "400 PP",
    probability: 15,
    type: "pp",
    amount: 400,
    fill: "#e0f2fe",
    accent: "#0f766e",
  },
  {
    key: "300_pp",
    label: "300 PP",
    probability: 15,
    type: "pp",
    amount: 300,
    fill: "#bae6fd",
    accent: "#075985",
  },
  {
    key: "250_pp",
    label: "250 PP",
    probability: 20,
    type: "pp",
    amount: 250,
    fill: "#f0f9ff",
    accent: "#0f766e",
  },
  {
    key: "200_pp",
    label: "200 PP",
    probability: 20,
    type: "pp",
    amount: 200,
    fill: "#bfdbfe",
    accent: "#1d4ed8",
  },
  {
    key: "100_pp",
    label: "100 PP",
    probability: 20,
    type: "pp",
    amount: 100,
    fill: "#dbeafe",
    accent: "#1e40af",
  },
  {
    key: "50_pp",
    label: "50 PP",
    probability: 5,
    type: "pp",
    amount: 50,
    fill: "#f8fbff",
    accent: "#1d4ed8",
  },
] as const;

export const SPIN_WHEEL_DURATION_MS = 4600;
export const SPIN_SEGMENT_ANGLE = 360 / SPIN_WHEEL_SEGMENTS.length;

export function getSpinWheelGradient() {
  const stops: string[] = [];

  SPIN_WHEEL_SEGMENTS.forEach((segment, index) => {
    const start = index * SPIN_SEGMENT_ANGLE;
    const end = start + SPIN_SEGMENT_ANGLE;
    stops.push(`${segment.fill} ${start}deg ${end}deg`);
  });

  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

export function getSpinSegmentIndex(key: SpinRewardKey) {
  return Math.max(
    0,
    SPIN_WHEEL_SEGMENTS.findIndex((segment) => segment.key === key)
  );
}

export function getSpinTargetRotation(currentRotation: number, rewardKey: SpinRewardKey) {
  const segmentIndex = getSpinSegmentIndex(rewardKey);
  const segmentCenter = segmentIndex * SPIN_SEGMENT_ANGLE + SPIN_SEGMENT_ANGLE / 2;
  const currentNormalized = ((currentRotation % 360) + 360) % 360;
  const targetNormalized = (360 - segmentCenter + 360) % 360;
  let delta = targetNormalized - currentNormalized;

  if (delta < 0) {
    delta += 360;
  }

  return currentRotation + 360 * 6 + delta;
}

export function formatTicketLabel(ticketCount: number) {
  return `${ticketCount} Ticket${ticketCount === 1 ? "" : "s"}`;
}

export function shortTxHash(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
