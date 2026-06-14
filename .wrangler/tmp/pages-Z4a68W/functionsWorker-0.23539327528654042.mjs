var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../.wrangler/tmp/bundle-P04gxY/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// _lib/auth.js
var COOKIE_NAME = "docs_admin_session";
var DEFAULT_PASSWORD = "Raj5298Raj@";
function getPassword(env) {
  return env && env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
}
__name(getPassword, "getPassword");
function getRepo(env) {
  return env && env.GITHUB_REPO || "Hossainraj2002/dustswap";
}
__name(getRepo, "getRepo");
function getBranch(env) {
  return env && env.GITHUB_BRANCH || "main";
}
__name(getBranch, "getBranch");
function getGithubToken(env) {
  return env && env.GITHUB_TOKEN || "";
}
__name(getGithubToken, "getGithubToken");
async function expectedToken(env) {
  const data = new TextEncoder().encode("docs-admin:" + getPassword(env));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(expectedToken, "expectedToken");
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
__name(parseCookies, "parseCookies");
async function isAuthed(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  return token === await expectedToken(env);
}
__name(isAuthed, "isAuthed");
function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" }
  });
}
__name(unauthorized, "unauthorized");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");

// api/admin/auth.js
async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  if (!body || body.password !== getPassword(env)) {
    return jsonResponse({ error: "Incorrect password" }, 401);
  }
  const token = await expectedToken(env);
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(onRequestPost, "onRequestPost");
async function onRequestDelete() {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
__name(onRequestDelete, "onRequestDelete");

// api/admin/file.js
var CONTENT_PREFIX = "docs/docs/";
function ghHeaders(env, needsWrite) {
  const headers = {
    "User-Agent": "dustswap-docs-admin",
    Accept: "application/vnd.github+json"
  };
  const token = getGithubToken(env);
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (needsWrite) return null;
  return headers;
}
__name(ghHeaders, "ghHeaders");
function isValidPath(path) {
  return typeof path === "string" && path.startsWith(CONTENT_PREFIX) && path.endsWith(".md") && !path.includes("..");
}
__name(isValidPath, "isValidPath");
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
__name(toBase64, "toBase64");
function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
__name(fromBase64, "fromBase64");
async function onRequestGet({ request, env }) {
  if (!await isAuthed(request, env)) return unauthorized();
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
    return jsonResponse({ content: "", sha: null, isNew: true });
  }
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `GitHub API error (${res.status})`, details: text }, 502);
  }
  const data = await res.json();
  return jsonResponse({ content: fromBase64(data.content), sha: data.sha, isNew: false });
}
__name(onRequestGet, "onRequestGet");
async function onRequestPut({ request, env }) {
  if (!await isAuthed(request, env)) return unauthorized();
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
        error: "GITHUB_TOKEN is not configured on this Cloudflare Pages project. Add a GitHub Personal Access Token (Contents: Read & Write on the dustswap repo) as an environment variable named GITHUB_TOKEN, then redeploy."
      },
      501
    );
  }
  const repo = getRepo(env);
  const branch = getBranch(env);
  const payload = {
    message: message || `docs admin: update ${path}`,
    content: toBase64(content),
    branch
  };
  if (sha) payload.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `GitHub API error (${res.status})`, details: text }, 502);
  }
  const data = await res.json();
  return jsonResponse({ ok: true, sha: data.content && data.content.sha });
}
__name(onRequestPut, "onRequestPut");
async function onRequestDelete2({ request, env }) {
  if (!await isAuthed(request, env)) return unauthorized();
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
        error: "GITHUB_TOKEN is not configured on this Cloudflare Pages project. Add a GitHub Personal Access Token (Contents: Read & Write on the dustswap repo) as an environment variable named GITHUB_TOKEN, then redeploy."
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
      branch
    })
  });
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `GitHub API error (${res.status})`, details: text }, 502);
  }
  return jsonResponse({ ok: true });
}
__name(onRequestDelete2, "onRequestDelete");

// api/admin/files.js
var CONTENT_PREFIX2 = "docs/docs/";
function ghHeaders2(env) {
  const headers = {
    "User-Agent": "dustswap-docs-admin",
    Accept: "application/vnd.github+json"
  };
  const token = getGithubToken(env);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
__name(ghHeaders2, "ghHeaders");
async function onRequestGet2({ request, env }) {
  if (!await isAuthed(request, env)) return unauthorized();
  const repo = getRepo(env);
  const branch = getBranch(env);
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(treeUrl, { headers: ghHeaders2(env) });
  if (!res.ok) {
    const text = await res.text();
    return jsonResponse(
      { error: `GitHub API error (${res.status})`, details: text },
      502
    );
  }
  const data = await res.json();
  const files = (data.tree || []).filter(
    (item) => item.type === "blob" && item.path.startsWith(CONTENT_PREFIX2) && item.path.endsWith(".md")
  ).map((item) => ({
    path: item.path,
    displayPath: item.path.slice(CONTENT_PREFIX2.length)
  })).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  return jsonResponse({ files, truncated: !!data.truncated });
}
__name(onRequestGet2, "onRequestGet");

// admin/index.js
var PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Dustswap Docs Admin</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #161922;
    --border: #2a2e3a;
    --text: #e6e8ef;
    --muted: #9aa1b1;
    --accent: #5b8cff;
    --danger: #ff5b6e;
    --ok: #3ddc97;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
  }

  /* Login screen */
  #login {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #login .box {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    width: 320px;
  }
  #login h1 { margin: 0 0 16px; font-size: 18px; }
  #login input {
    width: 100%;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #0c0e14;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 12px;
  }
  #login button, .btn {
    width: 100%;
    padding: 10px 12px;
    border-radius: 8px;
    border: none;
    background: var(--accent);
    color: white;
    font-size: 14px;
    cursor: pointer;
  }
  #login .err { color: var(--danger); font-size: 13px; margin-top: 8px; min-height: 18px; }

  /* App layout */
  #app { display: none; height: 100vh; }
  #app.show { display: flex; }
  #sidebar {
    width: 300px;
    border-right: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #sidebar header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  #sidebar header h2 { font-size: 14px; margin: 0; }
  #sidebar header button {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  #filelist { flex: 1; overflow: auto; padding: 8px; }
  .group { margin-bottom: 6px; }
  .group > .gname {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    padding: 6px 8px 2px;
  }
  .file {
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file:hover { background: #1f2330; }
  .file.active { background: var(--accent); color: white; }
  #newfile {
    margin: 8px;
    padding: 8px;
    font-size: 12px;
    border: 1px dashed var(--border);
    border-radius: 6px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #topbar {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  #topbar .path { font-size: 13px; color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #topbar button {
    border: none;
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  #saveBtn { background: var(--accent); color: white; }
  #deleteBtn { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  #logoutBtn { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  #editorWrap { flex: 1; padding: 0; display: flex; }
  #editor {
    flex: 1;
    border: none;
    resize: none;
    background: #0c0e14;
    color: var(--text);
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
    padding: 20px;
    outline: none;
  }
  #status {
    padding: 8px 20px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    min-height: 16px;
  }
  #status.ok { color: var(--ok); }
  #status.err { color: var(--danger); }
  #empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 14px;
  }
</style>
</head>
<body>
  <div id="login">
    <div class="box">
      <h1>Dustswap Docs Admin</h1>
      <input type="password" id="password" placeholder="Admin password" autofocus />
      <button id="loginBtn">Unlock</button>
      <div class="err" id="loginErr"></div>
    </div>
  </div>

  <div id="app">
    <div id="sidebar">
      <header>
        <h2>docs/docs</h2>
        <button id="logoutBtn2">Log out</button>
      </header>
      <button id="newfile">+ New page</button>
      <div id="filelist">Loading...</div>
    </div>
    <div id="main">
      <div id="empty">Select a page from the left, or create a new one.</div>
      <div id="topbar" style="display:none">
        <div class="path" id="currentPath"></div>
        <button id="saveBtn">Save & Commit</button>
        <button id="deleteBtn">Delete</button>
        <button id="logoutBtn">Log out</button>
      </div>
      <div id="editorWrap" style="display:none">
        <textarea id="editor" spellcheck="false"></textarea>
      </div>
      <div id="status"></div>
    </div>
  </div>

<script>
(function () {
  var state = { path: null, sha: null, isNew: false, files: [] };

  var loginEl = document.getElementById('login');
  var appEl = document.getElementById('app');
  var loginBtn = document.getElementById('loginBtn');
  var passwordEl = document.getElementById('password');
  var loginErr = document.getElementById('loginErr');
  var filelistEl = document.getElementById('filelist');
  var editorEl = document.getElementById('editor');
  var statusEl = document.getElementById('status');
  var currentPathEl = document.getElementById('currentPath');
  var topbarEl = document.getElementById('topbar');
  var editorWrapEl = document.getElementById('editorWrap');
  var emptyEl = document.getElementById('empty');

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = kind || '';
  }

  function showApp() {
    loginEl.style.display = 'none';
    appEl.className = 'show';
    loadFiles();
  }

  function showLogin(err) {
    loginEl.style.display = 'flex';
    appEl.className = '';
    if (err) loginErr.textContent = err;
  }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    if (res.status === 401) { showLogin(''); throw new Error('Unauthorized'); }
    return res;
  }

  async function loadFiles() {
    try {
      var res = await api('/api/admin/files');
      var data = await res.json();
      if (!res.ok) { setStatus(data.error || 'Failed to load files', 'err'); return; }
      state.files = data.files || [];
      renderFiles();
    } catch (e) {
      // unauthorized already handled
    }
  }

  function renderFiles() {
    filelistEl.innerHTML = '';
    var groups = {};
    state.files.forEach(function (f) {
      var parts = f.displayPath.split('/');
      var group = parts.length > 1 ? parts[0] : '(root)';
      (groups[group] = groups[group] || []).push(f);
    });
    Object.keys(groups).sort().forEach(function (group) {
      var g = document.createElement('div');
      g.className = 'group';
      var name = document.createElement('div');
      name.className = 'gname';
      name.textContent = group;
      g.appendChild(name);
      groups[group].forEach(function (f) {
        var item = document.createElement('div');
        item.className = 'file' + (f.path === state.path ? ' active' : '');
        item.textContent = f.displayPath.split('/').pop();
        item.title = f.displayPath;
        item.onclick = function () { openFile(f.path); };
        g.appendChild(item);
      });
      filelistEl.appendChild(g);
    });
  }

  async function openFile(path) {
    setStatus('Loading ' + path + '...');
    try {
      var res = await api('/api/admin/file?path=' + encodeURIComponent(path));
      var data = await res.json();
      if (!res.ok) { setStatus(data.error || 'Failed to load file', 'err'); return; }
      state.path = path;
      state.sha = data.sha;
      state.isNew = !!data.isNew;
      editorEl.value = data.content;
      currentPathEl.textContent = path + (state.isNew ? '  (new, not yet saved)' : '');
      topbarEl.style.display = 'flex';
      editorWrapEl.style.display = 'flex';
      emptyEl.style.display = 'none';
      setStatus('');
      renderFiles();
    } catch (e) {}
  }

  async function saveFile() {
    if (!state.path) return;
    setStatus('Saving...');
    try {
      var res = await api('/api/admin/file', {
        method: 'PUT',
        body: JSON.stringify({
          path: state.path,
          content: editorEl.value,
          sha: state.sha,
          message: 'docs admin: update ' + state.path,
        }),
      });
      var data = await res.json();
      if (!res.ok) { setStatus(data.error || 'Save failed', 'err'); return; }
      state.sha = data.sha || state.sha;
      state.isNew = false;
      currentPathEl.textContent = state.path;
      setStatus('Saved and committed to GitHub.', 'ok');
      if (!state.files.find(function (f) { return f.path === state.path; })) {
        await loadFiles();
      }
    } catch (e) {}
  }

  async function deleteFile() {
    if (!state.path) return;
    if (!confirm('Delete ' + state.path + '? This commits a deletion to GitHub.')) return;
    if (state.isNew) {
      state.path = null;
      topbarEl.style.display = 'none';
      editorWrapEl.style.display = 'none';
      emptyEl.style.display = 'flex';
      return;
    }
    setStatus('Deleting...');
    try {
      var res = await api('/api/admin/file', {
        method: 'DELETE',
        body: JSON.stringify({ path: state.path, sha: state.sha, message: 'docs admin: delete ' + state.path }),
      });
      var data = await res.json();
      if (!res.ok) { setStatus(data.error || 'Delete failed', 'err'); return; }
      setStatus('Deleted.', 'ok');
      state.path = null;
      topbarEl.style.display = 'none';
      editorWrapEl.style.display = 'none';
      emptyEl.style.display = 'flex';
      await loadFiles();
    } catch (e) {}
  }

  function newFile() {
    var rel = prompt('New page path (relative to docs/docs/), e.g. dustsweep/my-new-page.md');
    if (!rel) return;
    rel = rel.replace(/^\\/+/, '');
    if (!rel.endsWith('.md')) rel += '.md';
    state.path = 'docs/docs/' + rel;
    state.sha = null;
    state.isNew = true;
    editorEl.value = '# ' + rel.split('/').pop().replace(/\\.md$/, '').replace(/-/g, ' ') + '\\n\\nWrite your content here.\\n';
    currentPathEl.textContent = state.path + '  (new, not yet saved)';
    topbarEl.style.display = 'flex';
    editorWrapEl.style.display = 'flex';
    emptyEl.style.display = 'none';
    setStatus('New file - click Save & Commit to create it on GitHub.');
  }

  loginBtn.onclick = async function () {
    loginErr.textContent = '';
    try {
      var res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordEl.value }),
      });
      if (!res.ok) { loginErr.textContent = 'Incorrect password.'; return; }
      showApp();
    } catch (e) {
      loginErr.textContent = 'Login failed.';
    }
  };
  passwordEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') loginBtn.click(); });

  document.getElementById('saveBtn').onclick = saveFile;
  document.getElementById('deleteBtn').onclick = deleteFile;
  document.getElementById('newfile').onclick = newFile;

  async function logout() {
    await fetch('/api/admin/auth', { method: 'DELETE' });
    showLogin('');
  }
  document.getElementById('logoutBtn').onclick = logout;
  document.getElementById('logoutBtn2').onclick = logout;

  // Check existing session
  fetch('/api/admin/files').then(function (res) {
    if (res.status === 401) { showLogin(''); } else { showApp(); }
  }).catch(function () { showLogin(''); });
})();
<\/script>
</body>
</html>`;
async function onRequestGet3() {
  return new Response(PAGE, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
__name(onRequestGet3, "onRequestGet");

// ../../.wrangler/tmp/pages-Z4a68W/functionsRoutes-0.8378570912746928.mjs
var routes = [
  {
    routePath: "/api/admin/auth",
    mountPath: "/api/admin",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete]
  },
  {
    routePath: "/api/admin/auth",
    mountPath: "/api/admin",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/api/admin/file",
    mountPath: "/api/admin",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete2]
  },
  {
    routePath: "/api/admin/file",
    mountPath: "/api/admin",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/admin/file",
    mountPath: "/api/admin",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut]
  },
  {
    routePath: "/api/admin/files",
    mountPath: "/api/admin",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/admin",
    mountPath: "/admin",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet3]
  }
];

// ../../../../.npm/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../../.wrangler/tmp/bundle-P04gxY/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../../.wrangler/tmp/bundle-P04gxY/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.23539327528654042.mjs.map
