import { isAuthed, unauthorized, jsonResponse, getRepo, getBranch, getGithubToken } from "../../_lib/auth.js";

const CONTENT_PREFIX = "docs/docs/";

function ghHeaders(env) {
  const headers = {
    "User-Agent": "dustswap-docs-admin",
    Accept: "application/vnd.github+json",
  };
  const token = getGithubToken(env);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// GET -> list every markdown file under docs/docs/ in the repo
export async function onRequestGet({ request, env }) {
  if (!(await isAuthed(request, env))) return unauthorized();

  const repo = getRepo(env);
  const branch = getBranch(env);

  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(treeUrl, { headers: ghHeaders(env) });

  if (!res.ok) {
    const text = await res.text();
    return jsonResponse(
      { error: `GitHub API error (${res.status})`, details: text },
      502
    );
  }

  const data = await res.json();
  const files = (data.tree || [])
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith(CONTENT_PREFIX) &&
        item.path.endsWith(".md")
    )
    .map((item) => ({
      path: item.path,
      displayPath: item.path.slice(CONTENT_PREFIX.length),
    }))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));

  return jsonResponse({ files, truncated: !!data.truncated });
}
