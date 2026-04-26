const DEFAULT_PUBLIC_API_ORIGIN = "http://localhost:3001";

function normalizePublicApiOrigin(value?: string | null) {
  const normalized = value?.trim();
  const origin = normalized || DEFAULT_PUBLIC_API_ORIGIN;

  return origin.replace(/\/+$/, "").replace(/\/api(?:\/.*)?$/, "");
}

export function getPublicApiOrigin() {
  return normalizePublicApiOrigin(process.env.NEXT_PUBLIC_API_URL);
}

export function buildPublicApiUrl(path: string) {
  const normalizedPath = path
    ? path.startsWith("/")
      ? path
      : `/${path}`
    : "";

  return `${getPublicApiOrigin()}${normalizedPath}`;
}
