/* ══════════════════════════════════════════════════════════════════════════
   Troop 3 — content Worker
   ─────────────────────────────────────────────────────────────────────────
   The only thing on the internet that can write to the site's repository.
   The browser never sees the GitHub token; it sends the editor's password and
   the new file, and this Worker decides whether to commit it.

   Endpoints
     POST /save     { password, path, content, message, confirmShrink }
     POST /upload   { password, filename, contentBase64 }
     GET  /content?path=data/meetings.json
     GET  /health

   Secrets (wrangler secret put ...)
     GITHUB_TOKEN        a fine-grained PAT with Contents: read & write on the repo
     EDIT_PASSWORD       the leadership password
     PATROL_PASSWORDS    optional JSON: { "<password>": "<patrol-slug>", ... }

   Vars (wrangler.toml)
     GITHUB_REPO         "owner/repo"
     GITHUB_BRANCH       "main"
     ALLOWED_ORIGINS     comma-separated list of sites allowed to call this
   ═════════════════════════════════════════════════════════════════════════ */

const API = 'https://api.github.com';
const UA = 'troop3-content-worker';

/* Which files the editor is allowed to touch, and nothing else. A path that
   does not match one of these is rejected before anything else happens. */
const CONTENT_PATHS = [
  /^data\/(site|meetings|events|leadership|trails|resources|eagles)\.json$/,
  /^data\/patrols\/index\.json$/,
  /^data\/patrols\/[a-z0-9-]{1,40}\.json$/
];

const UPLOAD_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'];
const MAX_UPLOAD = 8 * 1024 * 1024;      // 8 MB

/* A save that removes more than this is refused unless it is confirmed twice.
   Full-file writes are the only thing this Worker does, so a bad read on the
   client is the one failure mode that could quietly empty the site. */
const SHRINK_RATIO = 0.6;                 // keeping less than 60% is suspicious
const SHRINK_ABSOLUTE = 5;                // or losing more than 5 entries

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'troop3-content-worker' }, 200, cors);
      }
      if (url.pathname === '/content' && request.method === 'GET') {
        return await handleContent(url, env, cors);
      }
      if (url.pathname === '/save' && request.method === 'POST') {
        return await handleSave(request, env, cors);
      }
      if (url.pathname === '/upload' && request.method === 'POST') {
        return await handleUpload(request, env, cors);
      }
      return json({ ok: false, error: 'Not found' }, 404, cors);
    } catch (err) {
      // Never leak internals to the browser; the detail goes to the Worker log.
      console.error('worker error', err && err.stack || err);
      return json({ ok: false, error: 'Server error' }, 500, cors);
    }
  }
};

/* ─────────────────────────────────────────────────────────── auth ──────── */

/** Constant-time-ish comparison, so a wrong password cannot be found by timing. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** → { role: 'admin' } | { role: 'patrol', slug } | null */
function identify(password, env) {
  if (!password) return null;
  if (env.EDIT_PASSWORD && sameSecret(password, env.EDIT_PASSWORD)) return { role: 'admin' };

  if (env.PATROL_PASSWORDS) {
    let table;
    try { table = JSON.parse(env.PATROL_PASSWORDS); } catch { table = null; }
    if (table) {
      for (const [pw, slug] of Object.entries(table)) {
        if (sameSecret(password, pw)) return { role: 'patrol', slug: String(slug) };
      }
    }
  }
  return null;
}

function mayWrite(who, path) {
  if (!who) return false;
  if (who.role === 'admin') return true;
  // A patrol leader can edit exactly one file: their own patrol.
  return path === `data/patrols/${who.slug}.json`;
}

/* ─────────────────────────────────────────────────────────── read ──────── */

async function handleContent(url, env, cors) {
  const path = url.searchParams.get('path') || '';
  if (!allowedPath(path)) return json({ ok: false, error: 'Path not allowed' }, 400, cors);

  const file = await ghGet(path, env);
  if (!file) return json({ ok: false, error: 'Not found' }, 404, cors);
  return json({ ok: true, path, sha: file.sha, content: file.text }, 200, cors);
}

/* ─────────────────────────────────────────────────────────── save ──────── */

async function handleSave(request, env, cors) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'Bad request body' }, 400, cors);

  const { password, path, content, message, confirmShrink } = body;

  const who = identify(password, env);
  if (!who) return json({ ok: false, error: 'Wrong password' }, 401, cors);

  if (!allowedPath(path)) return json({ ok: false, error: 'That file cannot be edited here' }, 400, cors);
  if (!mayWrite(who, path)) return json({ ok: false, error: 'Not allowed to edit that file' }, 403, cors);

  if (typeof content !== 'string' || content.length > 2 * 1024 * 1024) {
    return json({ ok: false, error: 'Content missing or too large' }, 400, cors);
  }

  // It must be valid JSON, and it must be an object — never a bare array or null.
  let parsed;
  try { parsed = JSON.parse(content); } catch {
    return json({ ok: false, error: 'That is not valid JSON' }, 400, cors);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ ok: false, error: 'Top level must be an object' }, 400, cors);
  }

  const current = await ghGet(path, env);
  if (!current) {
    // Creating a brand new content file is not something the editor does.
    return json({ ok: false, error: 'That file does not exist in the repository' }, 404, cors);
  }

  /* The shrink guard. This is the check that protects against a browser that
     read nothing and is about to publish nothing over everything. */
  let before = null;
  try { before = countEntries(JSON.parse(current.text)); } catch { before = null; }
  if (before !== null) {
    const after = countEntries(parsed);
    const lost = before - after;
    if (lost > 0 && (lost > SHRINK_ABSOLUTE || (before > 0 && after / before < SHRINK_RATIO))) {
      if (!confirmShrink) {
        return json({
          ok: false,
          error: `Refused: this would remove ${lost} of ${before} entries from ${path}. ` +
                 `If that is really what you want, confirm it in the editor and try again.`,
          needsConfirm: true, before, after
        }, 409, cors);
      }
    }
  }

  if (current.text === content) return json({ ok: true, unchanged: true, sha: current.sha }, 200, cors);

  const commit = await ghPut(path, content, current.sha,
    (message || `Content: ${path}`).slice(0, 120), env);

  return json({ ok: true, sha: commit.content && commit.content.sha, commit: commit.commit && commit.commit.sha }, 200, cors);
}

/** Every array in the file, added up. A blunt instrument, and that is the point. */
function countEntries(obj) {
  let n = 0;
  for (const k of Object.keys(obj || {})) if (Array.isArray(obj[k])) n += obj[k].length;
  return n;
}

function allowedPath(path) {
  return typeof path === 'string' && CONTENT_PATHS.some((re) => re.test(path));
}

/* ───────────────────────────────────────────────────────── upload ──────── */

async function handleUpload(request, env, cors) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'Bad request body' }, 400, cors);

  const who = identify(body.password, env);
  if (!who || who.role !== 'admin') {
    return json({ ok: false, error: 'Not allowed' }, 403, cors);
  }

  const name = slugFilename(body.filename || '');
  if (!name) return json({ ok: false, error: 'Bad filename' }, 400, cors);

  const ext = name.split('.').pop().toLowerCase();
  if (!UPLOAD_EXT.includes(ext)) {
    return json({ ok: false, error: `Only ${UPLOAD_EXT.join(', ')} can be uploaded` }, 400, cors);
  }

  const b64 = String(body.contentBase64 || '').replace(/^data:[^,]+,/, '');
  if (!b64) return json({ ok: false, error: 'No file' }, 400, cors);
  if (b64.length * 0.75 > MAX_UPLOAD) {
    return json({ ok: false, error: 'That file is larger than 8 MB' }, 400, cors);
  }

  const dir = ext === 'pdf' ? 'files' : 'img/uploads';
  const path = `${dir}/${name}`;
  const existing = await ghGet(path, env, true);

  await ghPutRaw(path, b64, existing ? existing.sha : null, `Upload: ${name}`, env);
  return json({ ok: true, path: `/${path}` }, 200, cors);
}

function slugFilename(raw) {
  const parts = String(raw).toLowerCase().split('.');
  if (parts.length < 2) return '';
  const ext = parts.pop().replace(/[^a-z0-9]/g, '');
  const stem = parts.join('-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return stem && ext ? `${stem}.${ext}` : '';
}

/* ─────────────────────────────────────────────────────────── GitHub ────── */

function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA
  };
}

async function ghGet(path, env, quiet) {
  const url = `${API}/repos/${env.GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  if (!r.ok) {
    if (quiet) return null;
    throw new Error(`GitHub read ${r.status}`);
  }
  const j = await r.json();
  return { sha: j.sha, text: decodeBase64(j.content || '') };
}

async function ghPut(path, text, sha, message, env) {
  return ghPutRaw(path, encodeBase64(text), sha, message, env);
}

async function ghPutRaw(path, base64, sha, message, env) {
  const url = `${API}/repos/${env.GITHUB_REPO}/contents/${encodePath(path)}`;
  const payload = {
    message,
    content: base64.replace(/\s+/g, ''),
    branch: env.GITHUB_BRANCH || 'main'
  };
  if (sha) payload.sha = sha;

  const r = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const detail = await r.text();
    console.error('GitHub write failed', r.status, detail.slice(0, 400));
    // 409 from GitHub means the sha was stale — somebody else saved first.
    throw new Error(r.status === 409
      ? 'Someone else saved this file while you were editing. Reload the editor and redo your change.'
      : `GitHub write ${r.status}`);
  }
  return r.json();
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/* ───────────────────────────────────────────────── Google Calendar ────── */

/* Deliberately not here. The calendar sync runs in GitHub Actions
   (`.github/workflows/gcal-sync.yml` → `scripts/gcal_sync.py`), because it has
   to read as well as write, and it needs a Google service account key. Keeping
   it out of the Worker means this file has exactly one job and exactly one
   credential. A commit from the editor lands in the repo, the workflow sees it
   and reconciles both sides. Nothing to do here. */

/* ────────────────────────────────────────────────────────── plumbing ───── */

async function readJson(request) {
  try {
    const t = await request.text();
    if (t.length > 3 * 1024 * 1024) return null;
    return JSON.parse(t);
  } catch { return null; }
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok && origin ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
