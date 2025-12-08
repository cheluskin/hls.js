#!/usr/bin/env node
/**
 * RKN Blocking Simulator Server
 *
 * Proxies requests to real CDN but can simulate various blocking methods:
 * - reset: Immediately destroy connection
 * - timeout: Never respond
 * - 403: Return HTTP 403 Forbidden
 * - dns: Close connection after short delay (simulates DNS failure)
 * - slow-403: Wait 2-5 seconds then return 403
 * - partial: Send headers + some bytes, then stall (simulates real CDN stall)
 *
 * Usage:
 *   node demo/blocking-server.mjs [port] [mode]
 *   node demo/blocking-server.mjs 8081 reset
 *
 * The server listens on two ports:
 *   - Main port (default 8081): "Blocked" CDN - applies blocking
 *   - Control port (main+1): API for changing blocking mode
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = parseInt(process.argv[2]) || 8081;
const CONTROL_PORT = PORT + 1;
const REAL_CDN = 'test-streams.mux.dev';

let blockingMode = process.argv[3] || 'reset';
let blockingEnabled = true;
let requestCount = 0;

// ANSI colors for console
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  const time = new Date().toLocaleTimeString();
  console.log(`${colors[color]}[${time}] ${msg}${colors.reset}`);
}

// ============================================
// Blocking Simulator
// ============================================

async function handleBlockedRequest(req, res) {
  requestCount++;
  const reqId = requestCount;
  const path = req.url;

  log(`[#${reqId}] Blocked request: ${path}`, 'red');
  log(`[#${reqId}] Mode: ${blockingMode}`, 'yellow');

  if (!blockingEnabled) {
    log(`[#${reqId}] Blocking disabled, proxying...`, 'green');
    return proxyToRealCdn(req, res, reqId);
  }

  const mode = blockingMode === 'mixed' ? getRandomMode() : blockingMode;

  switch (mode) {
    case 'reset':
      // Simulate connection reset - destroy socket immediately
      log(`[#${reqId}] Simulating CONNECTION RESET`, 'red');
      req.socket.destroy();
      break;

    case 'timeout':
      // Never respond - connection hangs
      log(`[#${reqId}] Simulating TIMEOUT (no response)`, 'red');
      // Do nothing - let it hang until client timeout
      break;

    case '403':
      // Instant 403 response
      log(`[#${reqId}] Simulating 403 FORBIDDEN`, 'red');
      res.writeHead(403, {
        'Content-Type': 'text/html',
        'X-Block-Reason': 'Simulated RKN block',
      });
      res.end(`
<!DOCTYPE html>
<html>
<head><title>403 Forbidden</title></head>
<body>
<h1>Access Denied</h1>
<p>This resource is blocked by your ISP.</p>
<p>Request: ${path}</p>
</body>
</html>
      `);
      break;

    case 'dns':
      // Short delay then reset (simulates DNS failure timing)
      log(`[#${reqId}] Simulating DNS FAILURE`, 'red');
      await sleep(50 + Math.random() * 150);
      req.socket.destroy();
      break;

    case 'slow-403':
      // DPI inspection delay then 403
      const delay = 2000 + Math.random() * 3000;
      log(`[#${reqId}] Simulating SLOW 403 (${Math.round(delay)}ms)`, 'red');
      await sleep(delay);
      if (!res.writableEnded) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Blocked after DPI inspection');
      }
      break;

    case 'partial':
      // Simulates real CDN stall behavior - sends headers and some data, then stops
      // This is exactly what happens with blocked CDNs in Russia
      const bytesToSend = 1024 + Math.floor(Math.random() * 4096); // 1-5 KB
      const totalSize = 1000000; // Pretend it's 1MB file
      log(
        `[#${reqId}] Simulating PARTIAL response (${bytesToSend} bytes then stall)`,
        'red'
      );

      // Send headers like a real video segment
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': totalSize.toString(),
        'Accept-Ranges': 'bytes',
      });

      // Send some bytes (random data simulating video)
      const partialData = Buffer.alloc(bytesToSend);
      for (let i = 0; i < bytesToSend; i++) {
        partialData[i] = Math.floor(Math.random() * 256);
      }
      res.write(partialData);
      log(
        `[#${reqId}] Sent ${bytesToSend} bytes, now stalling forever...`,
        'yellow'
      );
      // Don't end the response - let it hang (simulating stalled CDN)
      // The connection will stay open until client timeout/abort
      break;

    default:
      log(`[#${reqId}] Unknown mode: ${mode}`, 'red');
      req.socket.destroy();
  }
}

function getRandomMode() {
  const modes = ['reset', 'timeout', '403', 'dns', 'slow-403', 'partial'];
  return modes[Math.floor(Math.random() * modes.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// Proxy to Real CDN
// ============================================

function proxyToRealCdn(req, res, reqId) {
  const targetUrl = `https://${REAL_CDN}${req.url}`;
  log(`[#${reqId}] Proxying to: ${targetUrl}`, 'cyan');

  const proxyReq = https.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: REAL_CDN,
      },
    },
    (proxyRes) => {
      log(
        `[#${reqId}] Response: ${proxyRes.statusCode} (${proxyRes.headers['content-length'] || '?'} bytes)`,
        'green'
      );
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    log(`[#${reqId}] Proxy error: ${err.message}`, 'red');
    if (!res.writableEnded) {
      res.writeHead(502);
      res.end('Proxy error');
    }
  });

  req.pipe(proxyReq);
}

// ============================================
// Control API Server
// ============================================

const controlServer = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);

  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        mode: blockingMode,
        enabled: blockingEnabled,
        requestCount,
        port: PORT,
      })
    );
    return;
  }

  if (url.pathname === '/mode' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.mode) {
          blockingMode = data.mode;
          log(`Mode changed to: ${blockingMode}`, 'magenta');
        }
        if (typeof data.enabled === 'boolean') {
          blockingEnabled = data.enabled;
          log(
            `Blocking ${blockingEnabled ? 'enabled' : 'disabled'}`,
            'magenta'
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            mode: blockingMode,
            enabled: blockingEnabled,
          })
        );
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/reset-stats') {
    requestCount = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ============================================
// Main "Blocked CDN" Server
// ============================================

const blockedServer = http.createServer((req, res) => {
  // CORS for video requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  handleBlockedRequest(req, res);
});

// ============================================
// Start Servers
// ============================================

blockedServer.listen(PORT, () => {
  log(`========================================`, 'cyan');
  log(`RKN Blocking Simulator`, 'cyan');
  log(`========================================`, 'cyan');
  log(`Blocked CDN:  http://localhost:${PORT}`, 'yellow');
  log(`Control API:  http://localhost:${CONTROL_PORT}`, 'yellow');
  log(`Current mode: ${blockingMode}`, 'yellow');
  log(``, 'reset');
  log(`Blocking modes:`, 'reset');
  log(`  reset    - Connection reset (instant)`, 'reset');
  log(`  timeout  - Never respond (hang forever)`, 'reset');
  log(`  403      - HTTP 403 Forbidden (instant)`, 'reset');
  log(`  dns      - DNS failure simulation`, 'reset');
  log(`  slow-403 - 403 after 2-5 sec delay`, 'reset');
  log(`  partial  - Send headers + 1-5KB, then stall`, 'reset');
  log(`  mixed    - Random mode per request`, 'reset');
  log(``, 'reset');
  log(`Control API:`, 'reset');
  log(`  GET  /status      - Current status`, 'reset');
  log(`  POST /mode        - {"mode": "...", "enabled": bool}`, 'reset');
  log(`  POST /reset-stats - Reset request counter`, 'reset');
  log(`========================================`, 'cyan');
});

controlServer.listen(CONTROL_PORT, () => {
  log(`Control server ready on port ${CONTROL_PORT}`, 'green');
});
