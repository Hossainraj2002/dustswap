import { Gift, House, Plus, Search, UserRound, CircleHelp, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Matches the active route. */
  match: (pathname: string) => boolean;
  prominent?: boolean;
}

/** Five tabs, single-word labels (HIG tab bar guidance). */
export const TAB_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: House, match: (p) => p === "/" || p.startsWith("/t/") },
  { href: "/search", label: "Search", icon: Search, match: (p) => p.startsWith("/search") },
  { href: "/create", label: "Create", icon: Plus, match: (p) => p.startsWith("/create"), prominent: true },
  { href: "/rewards", label: "Rewards", icon: Gift, match: (p) => p.startsWith("/rewards") },
  { href: "/me", label: "Profile", icon: UserRound, match: (p) => p.startsWith("/me") || p.startsWith("/u/") },
];

export const SIDEBAR_ITEMS: NavItem[] = [
  { href: "/", label: "Discover", icon: House, match: (p) => p === "/" || p.startsWith("/t/") },
  { href: "/rewards", label: "Rewards", icon: Gift, match: (p) => p.startsWith("/rewards") },
  { href: "/me", label: "Profile", icon: UserRound, match: (p) => p.startsWith("/me") || p.startsWith("/u/") },
  { href: "/how-it-works", label: "How it works", icon: CircleHelp, match: (p) => p.startsWith("/how-it-works") },
];
