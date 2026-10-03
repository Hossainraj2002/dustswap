import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Parses the real token blocks in globals.css and enforces the HIG / WCAG
 * contrast table: 4.5:1 for text up to 17px, 3:1 for bold text, large text
 * and meaningful graphics. Translucent colors are composited over the
 * background they sit on, the way the browser renders them.
 */

type Rgba = { r: number; g: number; b: number; a: number };

const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector} block`);
  const end = css.indexOf("\n}", start);
  const body = css.slice(start, end);
  const vars: Record<string, string> = {};
  for (const match of body.matchAll(/--(mf-[a-z0-9-]+):\s*([^;]+);/g)) {
    vars[match[1] as string] = (match[2] as string).trim();
  }
  return vars;
}

function parse(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  throw new Error(`unsupported color ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const fg = luminance(over(foreground, background));
  const bg = luminance(background);
  const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  light: block(":root"),
  dark: { ...block(":root"), ...block(":root.dark") },
};

const requirements: Array<{ fg: string; on: string[]; min: number; why: string }> = [
  { fg: "mf-label", on: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated", "mf-bg-elevated-2"], min: 4.5, why: "primary text" },
  { fg: "mf-label-2", on: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated", "mf-bg-elevated-2"], min: 4.5, why: "secondary text" },
  { fg: "mf-placeholder", on: ["mf-bg", "mf-bg-elevated"], min: 3, why: "placeholder text (fields always have a visible label)" },
  { fg: "mf-tint", on: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated", "mf-bg-elevated-2"], min: 4.5, why: "tinted text and links" },
  { fg: "mf-on-tint", on: ["mf-tint-fill"], min: 4.5, why: "filled button labels" },
  { fg: "mf-up", on: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"], min: 4.5, why: "price up text" },
  { fg: "mf-down", on: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"], min: 4.5, why: "price down text" },
  // WCAG only counts bold text as large from 18.7px, so 15px bold pill labels need 4.5:1.
  { fg: "mf-on-tint", on: ["mf-up-fill", "mf-down-fill"], min: 4.5, why: "labels on change pills" },
  { fg: "mf-warning", on: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"], min: 4.5, why: "launch protection text" },
  { fg: "mf-mode-creator", on: ["mf-bg-elevated"], min: 3, why: "fee split graphics" },
  { fg: "mf-mode-burn", on: ["mf-bg-elevated"], min: 3, why: "fee split graphics" },
  { fg: "mf-mode-holders", on: ["mf-bg-elevated"], min: 3, why: "fee split graphics" },
  { fg: "mf-mode-floor", on: ["mf-bg-elevated"], min: 3, why: "fee split graphics" },
  { fg: "mf-mode-platform", on: ["mf-bg-elevated"], min: 3, why: "fee split graphics" },
  { fg: "mf-referral", on: ["mf-bg-elevated"], min: 3, why: "fee split graphics" },
  { fg: "mf-warning-ring", on: ["mf-bg-elevated"], min: 2, why: "decorative countdown ring next to a text label" },
];

/** Badges draw their text color on a 10% tint of the same color. */
const BADGE_TONES = ["mf-tint", "mf-up", "mf-down", "mf-warning", "mf-mode-creator", "mf-mode-burn", "mf-mode-holders", "mf-mode-floor"];
const BADGE_ALPHA = 0.1;

describe("tinted badge contrast", () => {
  for (const [theme, vars] of Object.entries(themes)) {
    for (const tone of BADGE_TONES) {
      for (const surface of ["mf-bg-elevated", "mf-bg-grouped"]) {
        it(`${theme}: ${tone} badge on ${surface}`, () => {
          const color = parse(vars[tone] as string);
          const background = over({ ...color, a: BADGE_ALPHA }, parse(vars[surface] as string));
          const ratio = contrast(color, background);
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

/**
 * Tinted and destructive buttons deepen their tint to 14% on hover and press
 * (the press itself is shown by scale), so both states must keep the label readable.
 */
const STATE_TONES = ["mf-tint", "mf-down"];
const STATE_ALPHAS = [0.1, 0.14];

describe("tinted control states", () => {
  for (const [theme, vars] of Object.entries(themes)) {
    for (const tone of STATE_TONES) {
      for (const alpha of STATE_ALPHAS) {
        for (const surface of ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"]) {
          it(`${theme}: ${tone} label on ${Math.round(alpha * 100)}% tint over ${surface}`, () => {
            const color = parse(vars[tone] as string);
            const background = over({ ...color, a: alpha }, parse(vars[surface] as string));
            const ratio = contrast(color, background);
            expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    }
  }
});

/** Text drawn on a translucent layer: pill tabs, nested panels, selected cards. */
const LAYERED_TEXT: Array<{ fg: string; layer: string | { tone: string; alpha: number }; surfaces: string[]; why: string }> = [
  { fg: "mf-label-2", layer: "mf-fill-3", surfaces: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"], why: "tab counts and segmented labels" },
  { fg: "mf-label-2", layer: "mf-fill-4", surfaces: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"], why: "nested panels and hovered rows" },
  { fg: "mf-label", layer: "mf-fill-2", surfaces: ["mf-bg", "mf-bg-grouped", "mf-bg-elevated"], why: "hovered pill tabs" },
  { fg: "mf-label-2", layer: { tone: "mf-tint", alpha: 0.08 }, surfaces: ["mf-bg-elevated"], why: "selected option cards" },
];

describe("text on translucent layers", () => {
  for (const [theme, vars] of Object.entries(themes)) {
    for (const { fg, layer, surfaces, why } of LAYERED_TEXT) {
      const layerName = typeof layer === "string" ? layer : `${layer.tone} ${Math.round(layer.alpha * 100)}%`;
      for (const surface of surfaces) {
        it(`${theme}: ${fg} on ${layerName} over ${surface} (${why})`, () => {
          const layerColor = typeof layer === "string" ? parse(vars[layer] as string) : { ...parse(vars[layer.tone] as string), a: layer.alpha };
          const background = over(layerColor, parse(vars[surface] as string));
          const ratio = contrast(parse(vars[fg] as string), background);
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe("design token contrast", () => {
  for (const [theme, vars] of Object.entries(themes)) {
    for (const requirement of requirements) {
      for (const backgroundName of requirement.on) {
        it(`${theme}: ${requirement.fg} on ${backgroundName} (${requirement.why})`, () => {
          const fg = vars[requirement.fg];
          const bg = vars[backgroundName];
          expect(fg, `${requirement.fg} defined`).toBeDefined();
          expect(bg, `${backgroundName} defined`).toBeDefined();
          const background = parse(bg as string);
          expect(background.a).toBe(1);
          const ratio = contrast(parse(fg as string), background);
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(requirement.min);
        });
      }
    }
  }
});
