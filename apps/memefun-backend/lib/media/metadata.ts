import { parseIpfsUri } from "../cid";
import {
  validateDescription,
  validateName,
  validateTelegram,
  validateTicker,
  validateWebsite,
  validateXHandle,
} from "../../shared/core/validation";

/**
 * Coin metadata, the JSON behind each coin's ERC-7572 `contractURI`. The fields the app shows are
 * validated with the launch form's own rules (shared/core/validation.ts), so the API accepts
 * exactly what the form accepts.
 */
export interface CoinMetadata {
  name: string;
  symbol: string;
  description: string;
  /** `ipfs://<cid>` of the 512 px WebP the API produced. */
  image: string;
  external_link?: string;
  links: { x?: string; telegram?: string; website?: string };
}

export interface MetadataInput {
  name: string;
  symbol: string;
  description?: string;
  image: string;
  x?: string;
  telegram?: string;
  website?: string;
}

export type MetadataResult = { ok: true; metadata: CoinMetadata } | { ok: false; errors: Record<string, string> };

export function buildMetadata(input: MetadataInput): MetadataResult {
  const errors: Record<string, string> = {};
  const name = validateName(input.name ?? "");
  const symbol = validateTicker(input.symbol ?? "");
  const description = validateDescription(input.description ?? "");
  const x = validateXHandle(input.x ?? "");
  const telegram = validateTelegram(input.telegram ?? "");
  const website = validateWebsite(input.website ?? "");
  for (const [field, result] of Object.entries({ name, symbol, description, x, telegram, website })) {
    if (!result.ok) errors[field] = result.error ?? "Invalid value.";
  }
  if (!parseIpfsUri(input.image ?? "")) errors.image = "Upload an image first.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const links: CoinMetadata["links"] = {};
  if (x.value) links.x = x.value;
  if (telegram.value) links.telegram = telegram.value;
  if (website.value) links.website = website.value;
  return {
    ok: true,
    metadata: {
      name: name.value,
      symbol: symbol.value,
      description: description.value,
      image: input.image.trim(),
      ...(website.value ? { external_link: website.value } : {}),
      links,
    },
  };
}

/** Canonical bytes: fixed key order, so the same metadata always has the same CID. */
export function encodeMetadata(metadata: CoinMetadata): Uint8Array {
  const ordered = {
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    image: metadata.image,
    ...(metadata.external_link ? { external_link: metadata.external_link } : {}),
    links: {
      ...(metadata.links.x ? { x: metadata.links.x } : {}),
      ...(metadata.links.telegram ? { telegram: metadata.links.telegram } : {}),
      ...(metadata.links.website ? { website: metadata.links.website } : {}),
    },
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** Only `ipfs://` and `https://` images are ever shown; anything else (data:, http:, javascript:) is dropped. */
export function safeImageUri(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const trimmed = value.trim();
  if (parseIpfsUri(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** What the app may show from metadata it did not create. Name and symbol always come from chain. */
export interface SanitizedMetadata {
  description: string;
  image?: string;
  external_link?: string;
  links: CoinMetadata["links"];
}

/**
 * Metadata fetched for a coin launched outside our API: anything may be in it. Keeps only the
 * fields the app shows, each passed through the same validation as our own form; a field that
 * fails is dropped rather than failing the whole document.
 */
export function sanitizeMetadata(json: unknown): SanitizedMetadata {
  const doc = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const links = typeof doc.links === "object" && doc.links !== null ? (doc.links as Record<string, unknown>) : {};
  const str = (value: unknown) => (typeof value === "string" ? value : "");

  const description = validateDescription(str(doc.description).slice(0, 2_000));
  const x = validateXHandle(str(links.x ?? doc.twitter));
  const telegram = validateTelegram(str(links.telegram ?? doc.telegram));
  const website = validateWebsite(str(links.website ?? doc.external_link ?? doc.website));

  const out: SanitizedMetadata = { description: description.ok ? description.value : "", links: {} };
  const image = safeImageUri(doc.image);
  if (image) out.image = image;
  if (x.ok && x.value) out.links.x = x.value;
  if (telegram.ok && telegram.value) out.links.telegram = telegram.value;
  if (website.ok && website.value) {
    out.links.website = website.value;
    out.external_link = website.value;
  }
  return out;
}
