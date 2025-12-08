/* eslint-disable no-console */
/**
 * Service Worker for simulating Roskomnadzor-style blocking
 *
 * Blocking modes:
 * - reset: Connection reset (net::ERR_CONNECTION_RESET)
 * - timeout: Request hangs indefinitely
 * - 403: HTTP 403 Forbidden
 * - dns: DNS resolution failure simulation
 * - mixed: Random mix of all types
 */

const BLOCKED_HOST = 'blocked-cdn.test';

// Blocking mode is set via postMessage from the page
let blockingMode = 'reset';
let blockingEnabled = true;

self.addEventListener('message', (event) => {
  if (event.data.type === 'SET_BLOCKING_MODE') {
    blockingMode = event.data.mode;
    console.log('[SW] Blocking mode set to:', blockingMode);
  }
  if (event.data.type === 'SET_BLOCKING_ENABLED') {
    blockingEnabled = event.data.enabled;
    console.log('[SW] Blocking enabled:', blockingEnabled);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept requests to our blocked test host
  if (url.host !== BLOCKED_HOST) {
    return;
  }

  if (!blockingEnabled) {
    // Pass through to network (will fail anyway since host doesn't exist)
    return;
  }

  console.log(
    '[SW] Intercepting blocked request:',
    url.pathname,
    'mode:',
    blockingMode
  );

  event.respondWith(simulateBlocking(event.request, url));
});

async function simulateBlocking(request, url) {
  const mode = blockingMode === 'mixed' ? getRandomMode() : blockingMode;

  switch (mode) {
    case 'reset':
      // Simulate connection reset - throw network error
      throw new TypeError('Failed to fetch (simulated connection reset)');

    case 'timeout':
      // Simulate infinite timeout - never resolve
      return new Promise(() => {
        // Never resolves - simulates hanging connection
        console.log('[SW] Simulating timeout for:', url.pathname);
      });

    case '403':
      // Simulate HTTP 403 Forbidden (ISP block page)
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Access Denied</title></head>
<body>
<h1>403 Forbidden</h1>
<p>Access to this resource is blocked by your ISP.</p>
<p>Requested URL: ${url.href}</p>
</body>
</html>`,
        {
          status: 403,
          statusText: 'Forbidden',
          headers: {
            'Content-Type': 'text/html',
            'X-Block-Reason': 'Simulated ISP block',
          },
        }
      );

    case 'dns':
      // Simulate DNS failure - similar to reset but with slight delay
      await sleep(100 + Math.random() * 200);
      throw new TypeError('Failed to fetch (simulated DNS failure)');

    case 'slow-403':
      // Simulate slow 403 (DPI inspection delay)
      await sleep(2000 + Math.random() * 3000);
      return new Response('Blocked', {
        status: 403,
        statusText: 'Forbidden',
      });

    default:
      throw new TypeError('Failed to fetch (unknown blocking mode)');
  }
}

function getRandomMode() {
  const modes = ['reset', 'timeout', '403', 'dns', 'slow-403'];
  return modes[Math.floor(Math.random() * modes.length)];
}

function sleep(ms) {
  return new Promise((resolve) => self.setTimeout(resolve, ms));
}

// Activate immediately
self.addEventListener('install', () => {
  console.log('[SW] Installing blocking simulator...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Blocking simulator activated');
  event.waitUntil(self.clients.claim());
});
