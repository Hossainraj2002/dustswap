/**
 * Coinbase offers tokenized stocks only outside the United States, so stock pairs are closed to
 * visitors from the US and its territories. The middleware stores the visitor's country (from
 * Cloudflare) in a cookie; pages stay static and read it on the client.
 */
export const COUNTRY_COOKIE = "mf-country";

const RESTRICTED = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);

export function isStockRestrictedCountry(country: string | null | undefined): boolean {
  return Boolean(country && RESTRICTED.has(country.toUpperCase()));
}

export function readCountryCookie(cookie: string = typeof document === "undefined" ? "" : document.cookie): string | null {
  for (const part of cookie.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COUNTRY_COOKIE && value && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  }
  return null;
}
