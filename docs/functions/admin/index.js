const PAGE = `<!DOCTYPE html>
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
</script>
</body>
</html>`;

export async function onRequestGet() {
  return new Response(PAGE, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
