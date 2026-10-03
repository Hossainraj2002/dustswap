// SYNCED from apps/memefun/src/core/validation.ts by scripts/sync-shared.ts. Edit the original, then run pnpm sync-shared.
/**
 * Launch-form validation. Messages are written for the person filling the
 * form: they say what is wrong and how to fix it.
 */

export interface FieldResult {
  ok: boolean;
  value: string;
  error?: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

export const NAME_MAX = 32;
export const TICKER_MIN = 2;
export const TICKER_MAX = 10;
export const DESCRIPTION_MAX = 280;

export function validateName(input: string): FieldResult {
  const value = input.replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, value, error: "Enter a name." };
  if (CONTROL_CHARS.test(value)) return { ok: false, value, error: "Remove hidden or control characters." };
  if (value.length > NAME_MAX) return { ok: false, value, error: `Use ${NAME_MAX} characters or fewer.` };
  return { ok: true, value };
}

export function normalizeTicker(input: string): string {
  return input.replace(/^\$+/, "").replace(/\s+/g, "").toUpperCase();
}

export function validateTicker(input: string): FieldResult {
  const value = normalizeTicker(input);
  if (!value) return { ok: false, value, error: "Enter a ticker." };
  if (!/^[A-Z0-9]+$/.test(value)) return { ok: false, value, error: "Use letters A to Z and numbers only." };
  if (value.length < TICKER_MIN) return { ok: false, value, error: `Use at least ${TICKER_MIN} characters.` };
  if (value.length > TICKER_MAX) return { ok: false, value, error: `Use ${TICKER_MAX} characters or fewer.` };
  return { ok: true, value };
}

export function validateDescription(input: string): FieldResult {
  const value = input.trim();
  if (CONTROL_CHARS.test(value.replace(/[\n\r\t]/g, ""))) {
    return { ok: false, value, error: "Remove hidden or control characters." };
  }
  if (value.length > DESCRIPTION_MAX) {
    return { ok: false, value, error: `Use ${DESCRIPTION_MAX} characters or fewer.` };
  }
  return { ok: true, value };
}

/** Accepts "@handle", "handle", or an x.com / twitter.com profile URL. */
export function validateXHandle(input: string): FieldResult {
  const raw = input.trim();
  if (!raw) return { ok: true, value: "" };
  const match = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i) ?? raw.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (!match?.[1]) return { ok: false, value: raw, error: "Use an X handle like @memefun or an x.com link." };
  return { ok: true, value: match[1] };
}

/** Accepts "t.me/name", "@name" or "name". */
export function validateTelegram(input: string): FieldResult {
  const raw = input.trim();
  if (!raw) return { ok: true, value: "" };
  const match = raw.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/i) ?? raw.match(/^@?([A-Za-z0-9_]{5,32})$/);
  if (!match?.[1]) return { ok: false, value: raw, error: "Use a Telegram link like t.me/yourgroup." };
  return { ok: true, value: match[1] };
}

export function validateWebsite(input: string): FieldResult {
  const raw = input.trim();
  if (!raw) return { ok: true, value: "" };
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:") return { ok: false, value: raw, error: "Use an https link." };
    if (!url.hostname.includes(".") || url.username || url.password) {
      return { ok: false, value: raw, error: "Enter a full website address." };
    }
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, value: raw, error: "Enter a full website address." };
  }
}

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function validateImageFile(file: { size: number; type: string }): FieldResult {
  if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) {
    return { ok: false, value: "", error: "Use a PNG, JPG, WebP or GIF image." };
  }
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, value: "", error: "Use an image under 4 MB." };
  return { ok: true, value: "" };
}
