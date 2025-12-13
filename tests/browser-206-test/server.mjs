/**
 * Test server for 206 Partial Content detection
 *
 * Run with: node tests/browser-206-test/server.mjs
 *
 * Simulates:
 * - Primary CDN that returns 206 partial content (simulating browser cache issue)
 * - Failback CDN that returns full content
 *
 * Supports both MPEG-TS (.ts) and fMP4 (.m4s) formats
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;
const MEDIA_DIR = path.join(__dirname, 'media');

// Load real media files
const mediaFiles = {
  // MPEG-TS segment (renamed to .ts.bin to avoid ESLint treating it as TypeScript)
  'segment.ts': fs.existsSync(path.join(MEDIA_DIR, 'segment.ts.bin'))
    ? fs.readFileSync(path.join(MEDIA_DIR, 'segment.ts.bin'))
    : null,
  // fMP4 init segment
  'init.mp4': fs.existsSync(path.join(MEDIA_DIR, 'init.mp4'))
    ? fs.readFileSync(path.join(MEDIA_DIR, 'init.mp4'))
    : null,
  // fMP4 media segment
  'segment0.m4s': fs.existsSync(path.join(MEDIA_DIR, 'segment0.m4s'))
    ? fs.readFileSync(path.join(MEDIA_DIR, 'segment0.m4s'))
    : null,
};

// Log loaded files
console.log('Loaded media files:');
for (const [name, data] of Object.entries(mediaFiles)) {
  console.log(`  ${name}: ${data ? `${data.length} bytes` : 'NOT FOUND'}`);
}

// Track requests for logging
let requestCount = 0;

// Helper to determine content type
function getContentType(filename) {
  if (filename.endsWith('.ts')) return 'video/mp2t';
  if (filename.endsWith('.m4s')) return 'video/mp4';
  if (filename.endsWith('.mp4')) return 'video/mp4';
  if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  return 'application/octet-stream';
}

// Helper to serve partial (206) response - simulates browser cache issue
function servePartial(res, data, contentType, partialPercent = 50) {
  const totalSize = data.length;
  const partialSize = Math.floor((totalSize * partialPercent) / 100);

  console.log(
    `    [PRIMARY] Returning 206 with ${partialSize}/${totalSize} bytes (${partialPercent}%)`,
  );

  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': partialSize,
    'Content-Range': `bytes 0-${partialSize - 1}/${totalSize}`,
    'Accept-Ranges': 'bytes',
  });
  res.end(data.subarray(0, partialSize));
}

// Helper to serve full (200) response
function serveFull(res, data, contentType) {
  console.log(`    [FAILBACK] Returning full ${data.length} bytes`);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  requestCount++;
  const reqNum = requestCount;

  console.log(`\n[${reqNum}] ${req.method} ${req.url}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, Content-Length',
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve test page
  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Serve HLS.js
  if (req.url === '/hls.mjs') {
    const hlsPath = path.join(__dirname, '../../dist/hls.mjs');
    const hls = fs.readFileSync(hlsPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(hls);
    return;
  }

  // ==========================================
  // MPEG-TS Playlist
  // ==========================================
  if (req.url === '/playlist.m3u8' || req.url === '/playlist-ts.m3u8') {
    const playlist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
http://localhost:${PORT}/primary/segment.ts
#EXT-X-ENDLIST`;
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(playlist);
    return;
  }

  // ==========================================
  // fMP4 Playlist
  // ==========================================
  if (req.url === '/playlist-fmp4.m3u8') {
    const playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="http://localhost:${PORT}/primary/init.mp4"
#EXTINF:2.0,
http://localhost:${PORT}/primary/segment0.m4s
#EXT-X-ENDLIST`;
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(playlist);
    return;
  }

  // ==========================================
  // PRIMARY CDN - Returns 206 Partial Content
  // ==========================================

  // Init segment (always return full - init segments must be complete)
  if (req.url.includes('/primary/init.mp4')) {
    const data = mediaFiles['init.mp4'];
    if (!data) {
      res.writeHead(404);
      res.end('init.mp4 not found');
      return;
    }
    // Init segments always need to be complete
    console.log(
      `    [PRIMARY] Init segment - returning full ${data.length} bytes`,
    );
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': data.length,
    });
    res.end(data);
    return;
  }

  // TS segment - return 206 partial
  if (req.url.includes('/primary/segment.ts')) {
    const data = mediaFiles['segment.ts'];
    if (!data) {
      res.writeHead(404);
      res.end('segment.ts not found');
      return;
    }
    servePartial(res, data, 'video/mp2t', 50);
    return;
  }

  // M4S segment - return 206 partial
  if (
    req.url.includes('/primary/segment0.m4s') ||
    req.url.includes('/primary/segment.m4s')
  ) {
    const data = mediaFiles['segment0.m4s'];
    if (!data) {
      res.writeHead(404);
      res.end('segment0.m4s not found');
      return;
    }
    servePartial(res, data, 'video/mp4', 50);
    return;
  }

  // ==========================================
  // FAILBACK CDN - Returns full content
  // ==========================================

  // Init segment
  if (req.url.includes('/failback/init.mp4')) {
    const data = mediaFiles['init.mp4'];
    if (!data) {
      res.writeHead(404);
      res.end('init.mp4 not found');
      return;
    }
    serveFull(res, data, 'video/mp4');
    return;
  }

  // TS segment
  if (req.url.includes('/failback/segment.ts')) {
    const data = mediaFiles['segment.ts'];
    if (!data) {
      res.writeHead(404);
      res.end('segment.ts not found');
      return;
    }
    serveFull(res, data, 'video/mp2t');
    return;
  }

  // M4S segment
  if (
    req.url.includes('/failback/segment0.m4s') ||
    req.url.includes('/failback/segment.m4s')
  ) {
    const data = mediaFiles['segment0.m4s'];
    if (!data) {
      res.writeHead(404);
      res.end('segment0.m4s not found');
      return;
    }
    serveFull(res, data, 'video/mp4');
    return;
  }

  // 404 for everything else
  console.log(`    [404] Not found`);
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           206 Partial Content Detection Test Server              ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Open in browser: http://localhost:${PORT}/                        ║
║                                                                  ║
║  Available playlists:                                            ║
║    /playlist.m3u8      - MPEG-TS format                          ║
║    /playlist-fmp4.m3u8 - fMP4 format                             ║
║                                                                  ║
║  Test scenario:                                                  ║
║    1. Primary CDN returns 206 partial content                    ║
║    2. Our 206 detection catches this                             ║
║    3. Failback CDN returns full content                          ║
║                                                                  ║
║  Supports both .ts and .m4s segments!                            ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`);
});
