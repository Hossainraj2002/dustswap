const DEFAULT_APP_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://dustswap.xyz",
  "https://www.dustswap.xyz",
  "https://dustswap.wtf",
  "https://www.dustswap.wtf",
  "https://app.dustswap.wtf",
  "https://dustswap.vercel.app",
  "https://dustswap-web.vercel.app",
];

const APP_ORIGIN_ENV_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "APP_URL",
  "PUBLIC_APP_URL",
  "WEB_URL",
  "FRONTEND_URL",
  "CORS_ORIGINS",
  "ALLOWED_ORIGINS",
  "ALLOWED_APP_ORIGINS",
];

function splitEnvList(value?: string | null) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function withDefaultProtocol(value: string) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return value.startsWith("localhost") || value.startsWith("127.0.0.1")
    ? `http://${value}`
    : `https://${value}`;
}

function toOrigin(value: string) {
  try {
    return new URL(withDefaultProtocol(value)).origin;
  } catch {
    return null;
  }
}

export function getHostFromUrl(value?: string | null) {
  if (!value) {
    return null;
  }

  try {
    return new URL(withDefaultProtocol(value.trim())).host.toLowerCase();
  } catch {
    return null;
  }
}

function getConfiguredOrigins() {
  return APP_ORIGIN_ENV_KEYS.flatMap((key) => splitEnvList(process.env[key]))
    .map(toOrigin)
    .filter((value): value is string => Boolean(value));
}

export function getAllowedAppOrigins() {
  return Array.from(new Set([...DEFAULT_APP_ORIGINS, ...getConfiguredOrigins()]));
}

export function getAllowedAppDomains() {
  return Array.from(
    new Set(
      getAllowedAppOrigins()
        .map(getHostFromUrl)
        .filter((value): value is string => Boolean(value))
    )
  );
}

export function isAllowedAppOrigin(origin?: string | null) {
  if (!origin) {
    return undefined;
  }

  const normalizedOrigin = toOrigin(origin);
  const host = getHostFromUrl(origin);

  if (
    normalizedOrigin &&
    (getAllowedAppOrigins().includes(normalizedOrigin) ||
      (host ? getAllowedAppDomains().includes(host) : false))
  ) {
    return normalizedOrigin;
  }

  return undefined;
}

export function isAllowedAppDomain(domain?: string | null) {
  const host = getHostFromUrl(domain);
  return Boolean(host && getAllowedAppDomains().includes(host));
}
