const fs = require('node:fs/promises');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const PAGES = new Set(['index.html', 'mobile-controls.js', 'world.js']);

module.exports = function staticFiles(root) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }); res.end(); return;
    }
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const relative = url === '/' ? 'index.html' : url.slice(1);
      const parts = relative.split('/');
      const ext = path.extname(relative).toLowerCase();
      if (!url.startsWith('/') || url.includes('\\') || url.includes('\0')
          || parts.some(p => !p || p.startsWith('.')) || !TYPES[ext]
          || !(PAGES.has(relative) || ['assets', 'vendor'].includes(parts[0]))) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const resolved = await fs.realpath(path.join(root, relative));
      const publicRoot = PAGES.has(relative) ? root : path.join(root, parts[0]);
      if (!resolved.startsWith(publicRoot + path.sep)) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const data = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      res.writeHead(error instanceof URIError ? 400 : 404);
      res.end('Not found');
    }
  };
};
