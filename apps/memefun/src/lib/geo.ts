/**
 * Coinbase offers tokenized stocks only outside the United States, so stock pairs are closed to
 * visitors from the US and its territories. The middleware stores the visitor's country (from
 * Cloudflare) in a cookie; pages stay static and read it on the client. Mainnet stock UI stays
 * closed when geography is unavailable. This UI rule does not enforce on-chain geography.
 */
export const COUNTRY_COOKIE = "mf-country";

const RESTRICTED = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);

/** Production stock UI accepts geography only on its Cloudflare-proxied public host. */
export function trustedStockCountry(input: { hostname: string; appUrl: string; cfRay: string | null; country: string | null }): string | null {
  let expectedHost: string;
  try { expectedHost = new URL(input.appUrl).hostname; } catch { return null; }
  if (input.hostname.toLowerCase() !== expectedHost.toLowerCase() || !input.cfRay || !/^[a-f0-9]{16,32}(?:-[a-z]{3})?$/i.test(input.cfRay)) return null;
  return input.country && /^[A-Za-z]{2}$/.test(input.country) && input.country.toUpperCase() !== "XX" ? input.country.toUpperCase() : null;
}

export function isStockRestrictedCountry(country: string | null | undefined, requireKnownCountry = false): boolean {
  if (!country || !/^[A-Za-z]{2}$/.test(country) || country.toUpperCase() === "XX" || country.toUpperCase() === "T1") return requireKnownCountry;
  return RESTRICTED.has(country.toUpperCase());
}

export function readCountryCookie(cookie: string = typeof document === "undefined" ? "" : document.cookie): string | null {
  for (const part of cookie.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COUNTRY_COOKIE && value && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  }
  return null;
}
