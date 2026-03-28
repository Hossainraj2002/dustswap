import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconFrame(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function ProfileIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="7.5" r="3.25" />
      <path d="M5.5 18.25c1.2-2.75 3.53-4.25 6.5-4.25s5.3 1.5 6.5 4.25" />
    </IconFrame>
  );
}

export function QuestsIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m12 3.5 1.65 4.35L18 9.5l-4.35 1.65L12 15.5l-1.65-4.35L6 9.5l4.35-1.65L12 3.5Z" />
      <path d="M18.5 16.5 19.3 18.7 21.5 19.5 19.3 20.3 18.5 22.5 17.7 20.3 15.5 19.5 17.7 18.7 18.5 16.5Z" />
    </IconFrame>
  );
}

export function DustSweepIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 15.5c2.2-1.9 4.8-2.85 7.8-2.85 3.9 0 6.77 1.38 8.62 4.1" />
      <path d="M13.25 6.25 18.5 11.5" />
      <path d="m16.9 4.85 2.25 2.25" />
      <circle cx="7.25" cy="8.25" r="1.1" />
      <circle cx="4.75" cy="11.5" r="0.9" />
      <circle cx="9.9" cy="5.1" r="0.9" />
    </IconFrame>
  );
}

export function SwapIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5 8h11.5" />
      <path d="m13.5 4.5 3.5 3.5-3.5 3.5" />
      <path d="M19 16H7.5" />
      <path d="m10.5 12.5-3.5 3.5 3.5 3.5" />
    </IconFrame>
  );
}

export function LeaderboardIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M6.25 18.5v-4.75" />
      <path d="M12 18.5v-8.5" />
      <path d="M17.75 18.5V8" />
      <path d="M4.5 18.5h15" />
      <path d="M15.75 5.5h4" />
      <path d="m18.75 3.5 1 2-1 2" />
    </IconFrame>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4.5 10.5 12 4l7.5 6.5" />
      <path d="M6.5 9.75v9h11v-9" />
      <path d="M10 18.75V14h4v4.75" />
    </IconFrame>
  );
}

export function BridgeIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4.5 17.75h15" />
      <path d="M6.5 17.75v-3.5" />
      <path d="M17.5 17.75v-3.5" />
      <path d="M8 17.75c.7-3.35 2.03-5 4-5s3.3 1.65 4 5" />
      <path d="M8 8.25h8" />
    </IconFrame>
  );
}

export function ParticlesIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="7.25" cy="8" r="1.4" />
      <circle cx="16.9" cy="6.8" r="1.15" />
      <circle cx="13.1" cy="15.1" r="1.65" />
      <circle cx="6.5" cy="16.8" r="1" />
      <path d="M8.4 8.3 15.5 7.05" />
      <path d="m15.95 7.85-2.05 5.7" />
      <path d="m11.7 14.65-4.1 1.45" />
    </IconFrame>
  );
}
