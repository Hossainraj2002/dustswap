import { isAuthed, unauthorized, jsonResponse, getRepo, getBranch, getGithubToken } from "../../_lib/auth.js";

const CONTENT_PREFIX = "docs/docs/";

function ghHeaders(env, needsWrite) {
  const headers = {
    "User-Agent": "dustswap-docs-admin",
    Accept: "application/vnd.github+json",
  };
  const token = getGithubToken(env);
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (needsWrite) return null;
  return headers;
}

function isValidPath(path) {
  return (
    typeof path === "string" &&
    path.startsWith(CONTENT_PREFIX) &&
    path.endsWith(".md") &&
    !path.includes("..")
  );
}

// utf8 string -> base64
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// base64 -> utf8 string
function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// GET /api/admin/file?path=docs/docs/foo.md -> { content, sha }
export async function onRequestGet({ request, env }) {
  if (!(await isAuthed(request, env))) return unauthorized();

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!isValidPath(path)) {
    return jsonResponse({ error: "Invalid or missing path" }, 400);
  }

  const repo = getRepo(env);
  const branch = getBranch(env);
  const headers = ghHeaders(env, false);

  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}?ref=${branch}`,
    { headers }
  );

  if (res.status === 404) {
    // New file - not yet on GitHub
    return jsonResponse({ content: "", sha: null, isNew: true });
  }

  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `GitHub API error (${res.status})`, details: text }, 502);
  }

  const data = await res.json();
  return jsonResponse({ content: fromBase64(data.content), sha: data.sha, isNew: false });
}

// PUT /api/admin/file  body: { path, content, sha, message }
export async function onRequestPut({ request, env }) {
  if (!(await isAuthed(request, env))) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const { path, content, sha, message } = body || {};
  if (!isValidPath(path) || typeof content !== "string") {
    return jsonResponse({ error: "Invalid path or content" }, 400);
  }

  const headers = ghHeaders(env, true);
  if (!headers) {
    return jsonResponse(
      {
        error:
          "GITHUB_TOKEN is not configured on this Cloudflare Pages project. " +
          "Add a GitHub Personal Access Token (Contents: Read & Write on the dustswap repo) " +
          "as an environment variable named GITHUB_TOKEN, then redeploy.",
      },
      501
    );
  }

  const repo = getRepo(env);
  const branch = getBranch(env);

  const payload = {
    message: message || `docs admin: update ${path}`,
    content: toBase64(content),
    branch,
  };
  if (sha) payload.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `GitHub API error (${res.status})`, details: text }, 502);
  }

  const data = await res.json();
  return jsonResponse({ ok: true, sha: data.content && data.content.sha });
}

// DELETE /api/admin/file  body: { path, sha, message }
export async function onRequestDelete({ request, env }) {
  if (!(await isAuthed(request, env))) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const { path, sha, message } = body || {};
  if (!isValidPath(path) || !sha) {
    return jsonResponse({ error: "Invalid path or missing sha" }, 400);
  }

  const headers = ghHeaders(env, true);
  if (!headers) {
    return jsonResponse(
      {
        error:
          "GITHUB_TOKEN is not configured on this Cloudflare Pages project. " +
          "Add a GitHub Personal Access Token (Contents: Read & Write on the dustswap repo) " +
          "as an environment variable named GITHUB_TOKEN, then redeploy.",
      },
      501
    );
  }

  const repo = getRepo(env);
  const branch = getBranch(env);

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message || `docs admin: delete ${path}`,
      sha,
      branch,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `GitHub API error (${res.status})`, details: text }, 502);
  }

  return jsonResponse({ ok: true });
}
