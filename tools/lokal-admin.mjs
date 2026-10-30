// Lokaler Server ohne Login-Seite: http://localhost:8787/admin.html
// Start:  FLARCHAT_PASSWORD='dein Passwort' node tools/lokal-admin.mjs
// Das Passwort steht nur im Terminal (nie in einer Datei). Der Server hört nur auf diesem Computer (127.0.0.1).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const USER = (process.env.FLARCHAT_USER || 'bela_owner').trim().toLowerCase();
const PASSWORD = process.env.FLARCHAT_PASSWORD;

const cfg = await readFile(join(ROOT, 'js/config.js'), 'utf8');
const SUPABASE_URL = cfg.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const ANON_KEY = cfg.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)[1];
const STORAGE_KEY = 'sb-' + new URL(SUPABASE_URL).hostname.split('.')[0] + '-auth-token';

if (!PASSWORD) {
  console.error('Bitte zuerst das Passwort im Terminal setzen:\n  FLARCHAT_PASSWORD=\'dein Passwort\' node tools/lokal-admin.mjs');
  process.exit(1);
}

async function login() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${USER}@flarchat.local`, password: PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Login fehlgeschlagen: ' + (data.msg || data.error_description || res.status));
  return data;
}

let session = await login();
setInterval(async () => { try { session = await login(); } catch (e) { console.error(e.message); } }, 30 * 60 * 1000);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === '/') path = '/index.html';
    if (path === '/sw.js') { res.writeHead(404); return res.end(); }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT + '/') || file.includes('/supabase/') || file.includes('/tools/') || file.includes('/.git')) {
      res.writeHead(403); return res.end('Nicht erlaubt');
    }
    let body = await readFile(file);
    const type = TYPES[extname(file)] || 'application/octet-stream';
    if (extname(file) === '.html') {
      const inject = `<script>try{localStorage.setItem(${JSON.stringify(STORAGE_KEY)},${JSON.stringify(JSON.stringify(session))})}catch(e){}</script>`;
      body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + inject));
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Nicht gefunden');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Fertig, eingeloggt als @${USER}.\nAdmin-Panel: http://localhost:${PORT}/admin.html\nApp:         http://localhost:${PORT}/`);
});
