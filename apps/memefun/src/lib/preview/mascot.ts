/**
 * Procedural mascot art for preview coins: a sticker-style character built
 * from a seeded set of bodies, ears, eyes, mouths and hats. Deterministic, so
 * a coin always gets the same face. Preview only; real coins use the image the
 * creator uploads.
 */
import { createRng, pick } from "./random";

const BACKGROUNDS = ["#FFD60A", "#FF9F0A", "#FF6B6B", "#FF8FAB", "#BF5AF2", "#5E5CE6", "#64D2FF", "#66D4CF", "#30D158", "#0052FF", "#1C1C1E", "#F2EDE4", "#A7C7FF", "#FFB4A2"];
const BODIES = ["#34C759", "#FFCC00", "#FF9500", "#FF3B30", "#AF52DE", "#5AC8FA", "#4D8BFF", "#A2845E", "#FFFFFF", "#C7C7CC", "#FF2D55", "#00C7BE", "#FFE0B2", "#7D5A50"];
const INK = "#1d1d1f";

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) + amount * 255);
  const g = clamp(((n >> 8) & 255) + amount * 255);
  const b = clamp((n & 255) + amount * 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function ears(kind: string, body: string): string {
  const s = `fill="${body}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"`;
  switch (kind) {
    case "cat":
      return `<path d="M30 52 L36 22 L56 40 Z" ${s}/><path d="M90 52 L84 22 L64 40 Z" ${s}/>`;
    case "round":
      return `<circle cx="32" cy="40" r="13" ${s}/><circle cx="88" cy="40" r="13" ${s}/>`;
    case "bunny":
      return `<ellipse cx="44" cy="26" rx="8" ry="22" ${s}/><ellipse cx="76" cy="26" rx="8" ry="22" ${s}/>`;
    case "antenna":
      return `<path d="M60 40 L60 16" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/><circle cx="60" cy="14" r="7" fill="#FF3B30" stroke="${INK}" stroke-width="3.5"/>`;
    case "horns":
      return `<path d="M36 46 Q24 28 34 16 Q40 32 48 40 Z" fill="#F2F2F7" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><path d="M84 46 Q96 28 86 16 Q80 32 72 40 Z" fill="#F2F2F7" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`;
    case "sprout":
      return `<path d="M60 40 Q58 24 60 18" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M60 22 Q46 8 36 18 Q48 28 60 22 Z" fill="#34C759" stroke="${INK}" stroke-width="3"/><path d="M60 22 Q74 8 84 18 Q72 28 60 22 Z" fill="#30D158" stroke="${INK}" stroke-width="3"/>`;
    default:
      return "";
  }
}

function bodyShape(kind: string, body: string): string {
  const s = `fill="${body}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"`;
  switch (kind) {
    case "round":
      return `<circle cx="60" cy="74" r="40" ${s}/>`;
    case "tall":
      return `<rect x="26" y="34" width="68" height="100" rx="34" ${s}/>`;
    case "pear":
      return `<path d="M60 32 C82 32 90 52 96 78 C102 104 86 128 60 128 C34 128 18 104 24 78 C30 52 38 32 60 32 Z" ${s}/>`;
    default:
      return `<ellipse cx="60" cy="78" rx="44" ry="40" ${s}/>`;
  }
}

function eyesFor(kind: string, rng: () => number): string {
  const spread = 15 + rng() * 6;
  const y = 68 + rng() * 4;
  const look = (rng() - 0.5) * 4;
  const left = 60 - spread;
  const right = 60 + spread;
  switch (kind) {
    case "shades":
      return `<path d="M${left - 13} ${y - 6} H${right + 13}" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/><rect x="${left - 12}" y="${y - 7}" width="24" height="14" rx="5" fill="${INK}"/><rect x="${right - 12}" y="${y - 7}" width="24" height="14" rx="5" fill="${INK}"/><path d="M${left - 6} ${y - 3} l6 0" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" opacity="0.8"/><path d="M${right - 6} ${y - 3} l6 0" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" opacity="0.8"/>`;
    case "sleepy":
      return `<path d="M${left - 8} ${y} q8 6 16 0" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M${right - 8} ${y} q8 6 16 0" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
    case "laser":
      return `<circle cx="${left}" cy="${y}" r="9" fill="#FFFFFF" stroke="${INK}" stroke-width="3"/><circle cx="${right}" cy="${y}" r="9" fill="#FFFFFF" stroke="${INK}" stroke-width="3"/><circle cx="${left}" cy="${y}" r="5" fill="#FF3B30"/><circle cx="${right}" cy="${y}" r="5" fill="#FF3B30"/><circle cx="${left}" cy="${y}" r="9" fill="#FF3B30" opacity="0.25"/><circle cx="${right}" cy="${y}" r="9" fill="#FF3B30" opacity="0.25"/>`;
    case "cyclops":
      return `<circle cx="60" cy="${y - 2}" r="15" fill="#FFFFFF" stroke="${INK}" stroke-width="3.5"/><circle cx="${60 + look}" cy="${y - 1}" r="7" fill="${INK}"/><circle cx="${62 + look}" cy="${y - 4}" r="2.5" fill="#FFFFFF"/>`;
    case "stars":
      return [left, right]
        .map((cx) => `<path d="M${cx} ${y - 10} l3 6.5 7 1 -5 5 1.2 7 -6.2 -3.4 -6.2 3.4 1.2 -7 -5 -5 7 -1 z" fill="#FFD60A" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`)
        .join("");
    default: {
      const r = 8 + rng() * 3;
      const pupil = r * (0.45 + rng() * 0.15);
      return [left, right]
        .map((cx) => `<circle cx="${cx}" cy="${y}" r="${r}" fill="#FFFFFF" stroke="${INK}" stroke-width="3"/><circle cx="${cx + look}" cy="${y + 1}" r="${pupil}" fill="${INK}"/><circle cx="${cx + look + pupil * 0.4}" cy="${y - pupil * 0.3}" r="${pupil * 0.35}" fill="#FFFFFF"/>`)
        .join("");
    }
  }
}

function mouthFor(kind: string): string {
  switch (kind) {
    case "grin":
      return `<path d="M44 90 Q60 106 76 90 Z" fill="#FFFFFF" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><path d="M52 92 v6 M60 93 v7 M68 92 v6" stroke="${INK}" stroke-width="2"/>`;
    case "o":
      return `<ellipse cx="60" cy="94" rx="6" ry="7.5" fill="${INK}"/>`;
    case "flat":
      return `<path d="M50 93 H70" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`;
    case "tongue":
      return `<path d="M46 89 Q60 101 74 89" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M58 95 q4 12 10 0" fill="#FF6B8B" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`;
    case "smirk":
      return `<path d="M48 94 Q62 98 74 88" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
    default:
      return `<path d="M47 89 Q60 101 73 89" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
  }
}

function hatFor(kind: string, rng: () => number): string {
  switch (kind) {
    case "party": {
      const color = pick(rng, ["#FF2D55", "#5E5CE6", "#FFCC00", "#00C7BE"]);
      return `<path d="M60 4 L76 40 H44 Z" fill="${color}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><path d="M53 22 L66 26 M49 32 L71 37" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/><circle cx="60" cy="5" r="5" fill="#FFFFFF" stroke="${INK}" stroke-width="3"/>`;
    }
    case "crown":
      return `<path d="M38 42 L40 18 L50 30 L60 14 L70 30 L80 18 L82 42 Z" fill="#FFCC00" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><circle cx="60" cy="33" r="3.5" fill="#FF3B30"/>`;
    case "beanie":
      return `<path d="M30 46 Q30 16 60 16 Q90 16 90 46 Z" fill="#FF3B30" stroke="${INK}" stroke-width="3.5"/><rect x="27" y="40" width="66" height="11" rx="5.5" fill="#FFFFFF" stroke="${INK}" stroke-width="3.5"/><circle cx="60" cy="13" r="6" fill="#FFFFFF" stroke="${INK}" stroke-width="3"/>`;
    case "cap":
      return `<path d="M32 46 Q32 20 60 20 Q86 20 88 44 Z" fill="#0052FF" stroke="${INK}" stroke-width="3.5"/><path d="M86 44 Q104 44 108 50 L84 50 Z" fill="#0052FF" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`;
    case "halo":
      return `<ellipse cx="60" cy="18" rx="22" ry="6" fill="none" stroke="#FFD60A" stroke-width="5"/>`;
    default:
      return "";
  }
}

/** SVG markup for a seeded mascot, 120x120. */
export function mascotSvg(seed: number): string {
  const rng = createRng(seed);
  const background = pick(rng, BACKGROUNDS);
  let body = pick(rng, BODIES);
  if (body.toLowerCase() === background.toLowerCase()) body = pick(rng, BODIES.filter((c) => c !== body));
  const bodyKind = pick(rng, ["blob", "blob", "round", "tall", "pear"]);
  const earKind = pick(rng, ["none", "cat", "round", "bunny", "antenna", "horns", "sprout", "none"]);
  const eyeKind = pick(rng, ["round", "round", "round", "shades", "sleepy", "laser", "cyclops", "stars"]);
  const mouthKind = pick(rng, ["smile", "grin", "o", "flat", "tongue", "smirk", "smile"]);
  const hatKind = earKind === "none" ? pick(rng, ["none", "none", "party", "crown", "beanie", "cap", "halo"]) : "none";
  const blush = rng() > 0.5;
  const highlight = shade(background, 0.12);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${highlight}"/><stop offset="1" stop-color="${background}"/></linearGradient><clipPath id="c"><circle cx="60" cy="60" r="60"/></clipPath></defs><g clip-path="url(#c)"><rect width="120" height="120" fill="url(#g)"/>${ears(earKind, body)}${bodyShape(bodyKind, body)}${blush ? `<circle cx="38" cy="84" r="6" fill="#FF6B8B" opacity="0.45"/><circle cx="82" cy="84" r="6" fill="#FF6B8B" opacity="0.45"/>` : ""}${eyesFor(eyeKind, rng)}${mouthFor(mouthKind)}${hatFor(hatKind, rng)}</g></svg>`;
}

export function mascotDataUri(seed: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvg(seed))}`;
}
