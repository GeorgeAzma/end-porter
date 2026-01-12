import http from 'http';
import fs from 'fs';

const PORT = process.env.PORT || 3003;
const GUI_PORT = process.env.GUI_PORT || 3004;
const MAPPINGS_FILE = 'endpoint_port_mappings.json';

// Load mappings: { "/endpoint": port }
let mappings = fs.existsSync(MAPPINGS_FILE) ? JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8')) : {};

// small debug logger controlled by VERBOSE or DEBUG env var
const VERBOSE = process.env.VERBOSE === '1' || process.env.DEBUG === '1';
function dbg(...args) { if (VERBOSE) console.log(...args); }

function canonicalizeEndpoint(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function isValidEndpoint(endpoint) {
  return /^\/[a-z0-9-_]+$/.test(endpoint) && endpoint !== '/gui';
}

function saveMappings() {
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
}

// Check if a port is online by making a test request
function checkPortStatus(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/',
      method: 'HEAD',
      timeout: 2000
    }, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Get status for all mappings
async function getMappingsWithStatus() {
  const result = {};
  for (const [endpoint, port] of Object.entries(mappings)) {
    const online = await checkPortStatus(port);
    result[endpoint] = { port, online };
  }
  return result;
}

const html = fs.readFileSync('index.html', 'utf8');

// Find which endpoint a request belongs to (by path or referer)
function findEndpoint(path, referer) {
  const sortedEndpoints = Object.keys(mappings).sort((a, b) => b.length - a.length);
  
  // First, check if path directly matches an endpoint
  for (const endpoint of sortedEndpoints) {
    if (path === endpoint || path.startsWith(endpoint + '/')) {
      return { endpoint, port: mappings[endpoint], matchedByPath: true };
    }
  }
  
  // If not, check referer to see which app the request came from
  if (referer) {
    try {
      const refUrl = new URL(referer);
      for (const endpoint of sortedEndpoints) {
        if (refUrl.pathname === endpoint || refUrl.pathname.startsWith(endpoint + '/')) {
          return { endpoint, port: mappings[endpoint], matchedByPath: false };
        }
      }
    } catch {}
  }
  
  return null;
}

// === PROXY SERVER (exposed to tunnel) ===
const proxyServer = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const path = parsedUrl.pathname;
  const referer = req.headers.referer || req.headers.referrer || '';
  
  dbg(`[Proxy] ${req.method} ${path}`);

  // Block GUI access on proxy server entirely
  if (path === '/gui' || path.startsWith('/gui/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Find which app this request belongs to
  const match = findEndpoint(path, referer);
  
  if (match) {
    const { endpoint, port, matchedByPath } = match;
    const targetPath = matchedByPath ? (path.slice(endpoint.length) || '/') : path;
    const targetUrl = `http://localhost:${port}${targetPath}${parsedUrl.search || ''}`;
    
    dbg(`  → Proxying to :${port}${targetPath}${matchedByPath ? '' : ' (via referer)'}`);
    
    const proxyReq = http.request(targetUrl, { method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway - Is app running on port ' + port + '?');
    });
    req.pipe(proxyReq);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// === GUI SERVER (localhost only, different port) ===
const guiServer = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${GUI_PORT}`);
  const path = parsedUrl.pathname;
  
  dbg(`[GUI] ${req.method} ${path}`);

  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (path === '/get' && req.method === 'GET') {
    getMappingsWithStatus().then(status => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    });
    return;
  }

  if (path === '/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.action === 'add') {
          const endpoint = canonicalizeEndpoint(data.endpoint);
          if (!endpoint || !isValidEndpoint(endpoint)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid endpoint');
            return;
          }
          const port = parseInt(data.port);
          if (isNaN(port) || port < 1 || port > 65535) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid port');
            return;
          }
          mappings[endpoint] = port;
        } else if (data.action === 'delete') {
          const endpoint = canonicalizeEndpoint(data.endpoint);
          if (!endpoint) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid endpoint');
            return;
          }
          delete mappings[endpoint];
        } else if (data.action === 'rename') {
          const oldEndpoint = canonicalizeEndpoint(data.oldEndpoint);
          const newEndpoint = canonicalizeEndpoint(data.newEndpoint);
          if (!oldEndpoint || !newEndpoint || !isValidEndpoint(newEndpoint)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid endpoint');
            return;
          }
          if (!mappings.hasOwnProperty(oldEndpoint)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Old endpoint not found');
            return;
          }
          mappings[newEndpoint] = mappings[oldEndpoint];
          delete mappings[oldEndpoint];
        }
        saveMappings();
        res.writeHead(200);
        res.end('OK');
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

proxyServer.listen(PORT, '127.0.0.1', () => console.log(`Proxy listening on localhost:${PORT} (for cloudflared)`));
guiServer.listen(GUI_PORT, '127.0.0.1', () => console.log(`GUI listening on localhost:${GUI_PORT} (admin only)`));
