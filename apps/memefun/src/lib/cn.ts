import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge has to know the custom theme scales, otherwise it treats
 * `text-headline` (a size) and `text-label` (a color) as the same group and
 * silently drops one of them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "large-title",
        "title1",
        "title2",
        "title3",
        "headline",
        "body",
        "callout",
        "subhead",
        "footnote",
        "caption1",
        "caption2",
      ],
      color: [
        "bg",
        "bg-grouped",
        "bg-elevated",
        "bg-elevated-2",
        "bg-secondary",
        "label",
        "label-2",
        "label-3",
        "label-4",
        "placeholder",
        "fill",
        "fill-2",
        "fill-3",
        "fill-4",
        "separator",
        "separator-opaque",
        "tint",
        "tint-fill",
        "on-tint",
        "up",
        "up-fill",
        "down",
        "down-fill",
        "warning",
        "warning-ring",
        "mode-creator",
        "mode-burn",
        "mode-holders",
        "mode-floor",
        "mode-platform",
        "referral",
      ],
      radius: ["xs", "sm", "md", "lg", "xl"],
      shadow: ["float", "card"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
