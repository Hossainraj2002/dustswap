// Shared auth helpers for the docs admin panel.
// The admin password is NOT stored in the repo — it must be set as the
// ADMIN_PASSWORD environment variable on the Cloudflare Pages project
// (Settings -> Environment variables). Until it's set, /admin login is
// disabled (no password will match).

export const COOKIE_NAME = "docs_admin_session";

export function getPassword(env) {
  return (env && env.ADMIN_PASSWORD) || "";
}

export function getRepo(env) {
  return (env && env.GITHUB_REPO) || "Hossainraj2002/dustswap";
}

export function getBranch(env) {
  return (env && env.GITHUB_BRANCH) || "main";
}

export function getGithubToken(env) {
  return (env && env.GITHUB_TOKEN) || "";
}

// Derive a session token from the password. Not cryptographically strong,
// but sufficient to keep casual visitors out of a personal admin tool.
export async function expectedToken(env) {
  const data = new TextEncoder().encode("docs-admin:" + getPassword(env));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export async function isAuthed(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  return token === (await expectedToken(env));
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
