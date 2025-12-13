/**
 * Integration tests for failback functionality
 * Tests the complete failback flow with mocked fetch
 *
 * Run with: node tests/integration-failback-test.mjs
 */

import { strict as assert } from 'assert';

// Polyfill browser globals for Node.js environment
if (typeof self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof performance === 'undefined') {
  const { performance } = await import('perf_hooks');
  globalThis.performance = performance;
}

// ============================================
// Test Utilities
// ============================================

let passed = 0;
let failed = 0;

async function test(name, fn) {
  console.log(`\nTest: ${name}`);
  try {
    await fn();
    console.log('  ✓ Passed');
    passed++;
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
    if (e.stack) {
      console.log(`    ${e.stack.split('\n').slice(1, 3).join('\n    ')}`);
    }
    failed++;
  }
}

// ============================================
// Mock Fetch System
// ============================================

class MockFetchSystem {
  constructor() {
    this.responses = new Map();
    this.requestLog = [];
    this.defaultResponse = { ok: true, status: 200, body: 'default' };
  }

  configure(urlPattern, response) {
    this.responses.set(urlPattern, response);
  }

  clearLog() {
    this.requestLog = [];
  }

  getRequestCount(urlPattern) {
    return this.requestLog.filter((r) => r.url.includes(urlPattern)).length;
  }

  async fetch(url, options = {}) {
    this.requestLog.push({ url, options, timestamp: Date.now() });

    // Find matching response
    let response = this.defaultResponse;
    for (const [pattern, resp] of this.responses) {
      if (url.includes(pattern)) {
        response = resp;
        break;
      }
    }

    // Handle delay
    if (response.delay) {
      await new Promise((r) => setTimeout(r, response.delay));
    }

    // Handle timeout (throw AbortError)
    if (response.timeout) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Handle network error
    if (response.networkError) {
      throw new Error('Network error');
    }

    return {
      ok:
        response.ok !== false &&
        response.status >= 200 &&
        response.status < 300,
      status: response.status || 200,
      statusText: response.statusText || 'OK',
      text: async () => response.body || '',
      json: async () => JSON.parse(response.body || '{}'),
    };
  }
}

// ============================================
// Testable FailbackLoader
// ============================================

class TestableFailbackLoader {
  constructor(config = {}) {
    this.hosts = config.hosts || [];
    this.originalUrl = '';
    this.failbackAttempt = 0;
    this.consecutiveOriginalFailures = 0;
    this.permanentFailbackMode = false;
    this.threshold = config.threshold || 2;

    // Recovery settings
    this.fragmentsSinceLastProbe = 0;
    this.probeEveryNFragments = config.probeEveryNFragments || 6;
    this.minBufferForRecovery = config.minBufferForRecovery || 40;
    this.isProbeInProgress = false;
    this.lastSuccessfulOriginalUrl = null;

    // Mock systems
    this.mockBufferAhead = 0;
    this.mockFetch = config.mockFetch || new MockFetchSystem();

    // Callbacks
    this.onFailback = config.onFailback || (() => {});
    this.onSuccess = config.onSuccess || (() => {});
    this.onRecoveryAttempt = config.onRecoveryAttempt || (() => {});
  }

  setMockBuffer(seconds) {
    this.mockBufferAhead = seconds;
  }

  getFailbackUrl(attempt) {
    if (attempt >= this.hosts.length) return null;
    try {
      const url = new URL(this.originalUrl);
      url.hostname = this.hosts[attempt];
      url.protocol = 'https:';
      return url.toString();
    } catch {
      return null;
    }
  }

  async load(url) {
    this.originalUrl = url;
    this.failbackAttempt = 0;

    // In permanent failback mode, skip original
    if (this.permanentFailbackMode) {
      const failbackUrl = this.getFailbackUrl(0);
      if (failbackUrl) {
        this.failbackAttempt = 1;
        return this.tryLoad(failbackUrl);
      }
    }

    return this.tryLoad(url);
  }

  async tryLoad(url) {
    try {
      const response = await this.mockFetch.fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Success!
      return this.handleSuccess(url);
    } catch (error) {
      return this.handleError(url, error);
    }
  }

  handleSuccess(url) {
    // Track original URL for recovery
    if (this.failbackAttempt === 0) {
      this.lastSuccessfulOriginalUrl = this.originalUrl;
    }

    // Reset failure counter on original source success
    if (this.failbackAttempt === 0 && !this.permanentFailbackMode) {
      this.consecutiveOriginalFailures = 0;
    }

    // CDN Recovery logic
    if (this.permanentFailbackMode) {
      this.fragmentsSinceLastProbe++;

      if (this.fragmentsSinceLastProbe >= this.probeEveryNFragments) {
        this.fragmentsSinceLastProbe = 0;
        // Don't await - fire and forget
        this.tryRecoverToOriginalCDN();
      }
    }

    this.onSuccess(url, this.failbackAttempt > 0, this.failbackAttempt);
    return { success: true, url, attempt: this.failbackAttempt };
  }

  handleError(url, error) {
    // Track failures on original source
    if (this.failbackAttempt === 0 && !this.permanentFailbackMode) {
      this.consecutiveOriginalFailures++;

      if (this.consecutiveOriginalFailures >= this.threshold) {
        this.permanentFailbackMode = true;
      }
    }

    // Try failback
    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);
    if (failbackUrl && failbackUrl !== url) {
      this.failbackAttempt++;
      this.onFailback(this.originalUrl, failbackUrl, this.failbackAttempt);
      return this.tryLoad(failbackUrl);
    }

    // All failed
    return {
      success: false,
      error: error.message,
      attempts: this.failbackAttempt + 1,
    };
  }

  async tryRecoverToOriginalCDN() {
    if (this.isProbeInProgress) return;
    if (!this.permanentFailbackMode) return;
    if (!this.lastSuccessfulOriginalUrl) return;

    // Check buffer before
    if (this.mockBufferAhead < this.minBufferForRecovery) {
      this.onRecoveryAttempt('skipped-buffer-low');
      return;
    }

    this.isProbeInProgress = true;
    this.onRecoveryAttempt('start');

    try {
      const response = await this.mockFetch.fetch(
        this.lastSuccessfulOriginalUrl,
      );

      // Re-check conditions after async
      if (!this.permanentFailbackMode) {
        this.onRecoveryAttempt('aborted-not-permanent');
        return;
      }

      if (this.mockBufferAhead < this.minBufferForRecovery) {
        this.onRecoveryAttempt('aborted-buffer-dropped');
        return;
      }

      if (response.ok) {
        this.resetFromPermanentMode();
        this.onRecoveryAttempt('success');
      } else {
        this.onRecoveryAttempt('failed-http-' + response.status);
      }
    } catch (e) {
      this.onRecoveryAttempt('failed-' + e.message);
    } finally {
      this.isProbeInProgress = false;
    }
  }

  resetFromPermanentMode() {
    if (this.permanentFailbackMode) {
      this.permanentFailbackMode = false;
      this.consecutiveOriginalFailures = this.threshold - 1; // First fail returns to permanent
      this.fragmentsSinceLastProbe = 0;
    }
  }

  resetAll() {
    this.consecutiveOriginalFailures = 0;
    this.permanentFailbackMode = false;
    this.fragmentsSinceLastProbe = 0;
    this.isProbeInProgress = false;
    this.lastSuccessfulOriginalUrl = null;
  }

  getState() {
    return {
      consecutiveFailures: this.consecutiveOriginalFailures,
      permanentMode: this.permanentFailbackMode,
      fragmentsSinceLastProbe: this.fragmentsSinceLastProbe,
      isProbeInProgress: this.isProbeInProgress,
    };
  }
}

// ============================================
// Tests
// ============================================

console.log('===== Integration Tests for Failback =====\n');

// ----------------------------------------
// Test 1: Basic failback on primary failure
// ----------------------------------------
await test('Basic failback: primary fails, backup succeeds', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 503, ok: false });
  mockFetch.configure('backup.cdn.com', {
    status: 200,
    ok: true,
    body: 'backup-data',
  });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    mockFetch,
  });

  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, true, 'Should succeed via failback');
  assert.equal(result.attempt, 1, 'Should be attempt #1 (failback)');
  assert.equal(
    mockFetch.getRequestCount('primary.cdn.com'),
    1,
    'Should hit primary once',
  );
  assert.equal(
    mockFetch.getRequestCount('backup.cdn.com'),
    1,
    'Should hit backup once',
  );
});

// ----------------------------------------
// Test 2: No failback when primary succeeds
// ----------------------------------------
await test('No failback when primary succeeds', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', {
    status: 200,
    ok: true,
    body: 'primary-data',
  });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    mockFetch,
  });

  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, true);
  assert.equal(result.attempt, 0, 'Should be attempt #0 (primary)');
  assert.equal(mockFetch.getRequestCount('primary.cdn.com'), 1);
  assert.equal(
    mockFetch.getRequestCount('backup.cdn.com'),
    0,
    'Should NOT hit backup',
  );
});

// ----------------------------------------
// Test 3: Permanent failback mode activation
// ----------------------------------------
await test('Permanent failback mode activates after 2 failures', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    threshold: 2,
    mockFetch,
  });

  // First failure
  await loader.load('https://primary.cdn.com/seg1.ts');
  assert.equal(loader.getState().consecutiveFailures, 1);
  assert.equal(loader.getState().permanentMode, false);

  // Second failure -> permanent mode
  await loader.load('https://primary.cdn.com/seg2.ts');
  assert.equal(loader.getState().consecutiveFailures, 2);
  assert.equal(loader.getState().permanentMode, true);
});

// ----------------------------------------
// Test 4: Permanent mode skips primary
// ----------------------------------------
await test('Permanent mode skips primary CDN', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    threshold: 2,
    mockFetch,
  });

  // Force permanent mode
  loader.permanentFailbackMode = true;
  loader.consecutiveOriginalFailures = 2;

  mockFetch.clearLog();
  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, true);
  assert.equal(
    mockFetch.getRequestCount('primary.cdn.com'),
    0,
    'Should NOT hit primary',
  );
  assert.equal(
    mockFetch.getRequestCount('backup.cdn.com'),
    1,
    'Should hit backup directly',
  );
});

// ----------------------------------------
// Test 5: Recovery probe triggers after N fragments
// ----------------------------------------
await test('Recovery probe triggers after N fragments', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 200, ok: true });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  let recoveryAttempts = [];
  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 3, // Probe every 3 fragments
    minBufferForRecovery: 40,
    mockFetch,
    onRecoveryAttempt: (status) => recoveryAttempts.push(status),
  });

  // Force permanent mode
  loader.permanentFailbackMode = true;
  loader.consecutiveOriginalFailures = 2;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(50); // Enough buffer

  // Load 3 fragments
  for (let i = 0; i < 3; i++) {
    await loader.load(`https://primary.cdn.com/seg${i}.ts`);
  }

  // Wait for async probe
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(recoveryAttempts.includes('start'), 'Should start recovery');
  assert.ok(recoveryAttempts.includes('success'), 'Should succeed recovery');
});

// ----------------------------------------
// Test 6: Recovery skipped when buffer too low
// ----------------------------------------
await test('Recovery skipped when buffer too low', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  let recoveryAttempts = [];
  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 2,
    minBufferForRecovery: 40,
    mockFetch,
    onRecoveryAttempt: (status) => recoveryAttempts.push(status),
  });

  loader.permanentFailbackMode = true;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(20); // NOT enough buffer

  // Load fragments
  for (let i = 0; i < 3; i++) {
    await loader.load(`https://primary.cdn.com/seg${i}.ts`);
  }

  await new Promise((r) => setTimeout(r, 50));

  assert.ok(
    !recoveryAttempts.includes('start'),
    'Should NOT start recovery with low buffer',
  );
  assert.ok(
    recoveryAttempts.includes('skipped-buffer-low'),
    'Should report buffer too low',
  );
});

// ----------------------------------------
// Test 7: Recovery success resets state correctly
// ----------------------------------------
await test('Recovery success sets failures to threshold-1', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 200, ok: true });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 1, // Immediate probe
    minBufferForRecovery: 40,
    threshold: 2,
    mockFetch,
  });

  loader.permanentFailbackMode = true;
  loader.consecutiveOriginalFailures = 2;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(50);

  // Trigger recovery
  await loader.load('https://primary.cdn.com/seg1.ts');
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(
    loader.getState().permanentMode,
    false,
    'Should exit permanent mode',
  );
  assert.equal(
    loader.getState().consecutiveFailures,
    1,
    'Should set failures to threshold-1',
  );
});

// ----------------------------------------
// Test 8: First failure after recovery returns to permanent
// ----------------------------------------
await test('First failure after recovery returns to permanent mode', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    threshold: 2,
    mockFetch,
  });

  // Simulate state after recovery (not in permanent, but failures = threshold-1)
  loader.permanentFailbackMode = false;
  loader.consecutiveOriginalFailures = 1; // threshold - 1

  // Primary fails
  await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(loader.getState().consecutiveFailures, 2);
  assert.equal(
    loader.getState().permanentMode,
    true,
    'Should return to permanent mode',
  );
});

// ----------------------------------------
// Test 9: Concurrent probe protection
// ----------------------------------------
await test('Concurrent probes are blocked', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 200, ok: true, delay: 100 });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  let recoveryAttempts = [];
  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 1,
    minBufferForRecovery: 40,
    mockFetch,
    onRecoveryAttempt: (status) => recoveryAttempts.push(status),
  });

  loader.permanentFailbackMode = true;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(50);

  // Trigger multiple probes simultaneously
  loader.tryRecoverToOriginalCDN();
  loader.tryRecoverToOriginalCDN();
  loader.tryRecoverToOriginalCDN();

  await new Promise((r) => setTimeout(r, 200));

  // Should only have one 'start'
  const starts = recoveryAttempts.filter((r) => r === 'start');
  assert.equal(starts.length, 1, 'Should only start one probe');
});

// ----------------------------------------
// Test 10: Success on primary resets failure counter
// ----------------------------------------
await test('Success on primary resets failure counter', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    threshold: 2,
    mockFetch,
  });

  // Simulate one failure
  loader.consecutiveOriginalFailures = 1;

  await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(
    loader.getState().consecutiveFailures,
    0,
    'Should reset to 0 on success',
  );
});

// ----------------------------------------
// Test 11: All failbacks exhausted returns error
// ----------------------------------------
await test('Returns error when all failbacks exhausted', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 500, ok: false });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    mockFetch,
  });

  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, false);
  assert.equal(result.attempts, 2, 'Should try primary + 1 backup');
});

// ----------------------------------------
// Test 12: Multiple backup hosts tried in order
// ----------------------------------------
await test('Multiple backup hosts tried in order', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup1.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup2.cdn.com', { status: 200, ok: true });

  let failbackEvents = [];
  const loader = new TestableFailbackLoader({
    hosts: ['backup1.cdn.com', 'backup2.cdn.com'],
    mockFetch,
    onFailback: (orig, fb, attempt) => failbackEvents.push({ fb, attempt }),
  });

  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, true);
  assert.equal(result.attempt, 2, 'Should succeed on second backup');
  assert.equal(failbackEvents.length, 2, 'Should have 2 failback events');
  assert.ok(
    failbackEvents[0].fb.includes('backup1'),
    'First failback to backup1',
  );
  assert.ok(
    failbackEvents[1].fb.includes('backup2'),
    'Second failback to backup2',
  );
});

// ----------------------------------------
// Test 13: Network error triggers failback
// ----------------------------------------
await test('Network error triggers failback', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { networkError: true });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    mockFetch,
  });

  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, true);
  assert.equal(result.attempt, 1, 'Should failback on network error');
});

// ----------------------------------------
// Test 14: Timeout triggers failback
// ----------------------------------------
await test('Timeout triggers failback', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { timeout: true });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    mockFetch,
  });

  const result = await loader.load('https://primary.cdn.com/segment.ts');

  assert.equal(result.success, true);
  assert.equal(result.attempt, 1, 'Should failback on timeout');
});

// ----------------------------------------
// Test 15: Recovery aborted if buffer drops during probe
// ----------------------------------------
await test('Recovery aborted if buffer drops during probe', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 200, ok: true, delay: 50 });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  let recoveryAttempts = [];
  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 1,
    minBufferForRecovery: 40,
    mockFetch,
    onRecoveryAttempt: (status) => recoveryAttempts.push(status),
  });

  loader.permanentFailbackMode = true;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(50); // Start with enough buffer

  // Start recovery
  const probePromise = loader.tryRecoverToOriginalCDN();

  // Simulate buffer drop during probe (e.g., user seeked)
  await new Promise((r) => setTimeout(r, 20));
  loader.setMockBuffer(10); // Buffer dropped!

  await probePromise;

  assert.ok(recoveryAttempts.includes('start'), 'Should start');
  assert.ok(
    recoveryAttempts.includes('aborted-buffer-dropped'),
    'Should abort due to buffer drop',
  );
  assert.equal(
    loader.getState().permanentMode,
    true,
    'Should stay in permanent mode',
  );
});

// ----------------------------------------
// Test 16: Recovery probe fails - stays in permanent mode
// ----------------------------------------
await test('Recovery probe failure keeps permanent mode', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  let recoveryAttempts = [];
  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 1,
    minBufferForRecovery: 40,
    mockFetch,
    onRecoveryAttempt: (status) => recoveryAttempts.push(status),
  });

  loader.permanentFailbackMode = true;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(50);

  // Trigger recovery
  await loader.load('https://primary.cdn.com/seg1.ts');
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(recoveryAttempts.includes('start'), 'Should start probe');
  assert.ok(
    recoveryAttempts.some((r) => r.startsWith('failed-')),
    'Should report failure',
  );
  assert.equal(
    loader.getState().permanentMode,
    true,
    'Should stay in permanent mode',
  );
});

// ----------------------------------------
// Test 17: Fragment counter resets after probe
// ----------------------------------------
await test('Fragment counter resets after probe attempt', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    probeEveryNFragments: 3,
    minBufferForRecovery: 40,
    mockFetch,
  });

  loader.permanentFailbackMode = true;
  loader.lastSuccessfulOriginalUrl = 'https://primary.cdn.com/segment.ts';
  loader.setMockBuffer(50);

  // Load 3 fragments to trigger probe
  for (let i = 0; i < 3; i++) {
    await loader.load(`https://primary.cdn.com/seg${i}.ts`);
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(
    loader.getState().fragmentsSinceLastProbe,
    0,
    'Counter should reset after probe',
  );

  // Load 2 more fragments
  await loader.load('https://primary.cdn.com/seg3.ts');
  await loader.load('https://primary.cdn.com/seg4.ts');

  assert.equal(
    loader.getState().fragmentsSinceLastProbe,
    2,
    'Counter should increment',
  );
});

// ----------------------------------------
// Test 18: URL transformation preserves path and query
// ----------------------------------------
await test('Failback URL preserves path and query params', async () => {
  const mockFetch = new MockFetchSystem();
  mockFetch.configure('primary.cdn.com', { status: 500, ok: false });
  mockFetch.configure('backup.cdn.com', { status: 200, ok: true });

  let failbackUrl = null;
  const loader = new TestableFailbackLoader({
    hosts: ['backup.cdn.com'],
    mockFetch,
    onFailback: (orig, fb) => {
      failbackUrl = fb;
    },
  });

  await loader.load(
    'https://primary.cdn.com/path/to/segment.ts?token=abc&quality=hd',
  );

  assert.ok(failbackUrl, 'Should have failback URL');
  const parsed = new URL(failbackUrl);
  assert.equal(parsed.hostname, 'backup.cdn.com');
  assert.equal(parsed.pathname, '/path/to/segment.ts');
  assert.equal(parsed.searchParams.get('token'), 'abc');
  assert.equal(parsed.searchParams.get('quality'), 'hd');
});

// ----------------------------------------
// Test 19: 206 Partial Content Detection (Browser Cache Range Issue)
// This simulates the scenario from histoo.json where browser cached
// partial data and sent Range request that broke failback
// ----------------------------------------
await test('206 Partial Content from browser cache triggers failback', async () => {
  /**
   * Scenario:
   * 1. Browser has 15592 bytes cached from a previous partial download
   * 2. Browser auto-adds Range: bytes=15592-15592 header
   * 3. Server returns HTTP 206 with Content-Range: bytes 15592-15592/2624292
   * 4. Content-Length is 1 byte (only returning the requested byte)
   * 5. Our loader should detect this and trigger failback
   */

  class Mock206XHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.response = null;
      this.responseType = '';
      this.responseURL = '';
      this._headers = new Map();
      this._responseHeaders = new Map();
      this._url = '';

      this.onreadystatechange = null;
      this.onprogress = null;
      this.onerror = null;
    }

    open(method, url) {
      this._url = url;
      this.responseURL = url;
      this.readyState = 1;
    }

    setRequestHeader(name, value) {
      this._headers.set(name.toLowerCase(), value);
    }

    getResponseHeader(name) {
      return this._responseHeaders.get(name.toLowerCase()) || null;
    }

    send() {
      // Simulate browser adding Range header from cache (we didn't request this!)
      // Note: In real browser, this happens automatically based on cached partial data

      setTimeout(() => {
        if (this._url.includes('cdn.original.com')) {
          // Simulate the 206 response like in histoo.json
          this.status = 206;
          this.statusText = 'Partial Content';
          this.response = new ArrayBuffer(1); // Only 1 byte!
          this._responseHeaders.set(
            'content-range',
            'bytes 15592-15592/2624292',
          );
          this._responseHeaders.set('content-length', '1');

          this.readyState = 2;
          this.onreadystatechange?.();
          this.readyState = 4;
          this.onreadystatechange?.();
        } else if (this._url.includes('failback.example.com')) {
          // Failback server returns full file (no cache issue)
          this.status = 200;
          this.statusText = 'OK';
          this.response = new ArrayBuffer(2624292); // Full file
          this._responseHeaders.set('content-length', '2624292');

          this.readyState = 2;
          this.onreadystatechange?.();
          this.readyState = 4;
          this.onreadystatechange?.();
        }
      }, 10);
    }

    abort() {
      this.readyState = 4;
    }
  }

  // Import the actual FailbackLoader (named export, not default)
  const { FailbackLoader, getFailbackState, destroyFailbackState } =
    await import('../dist/hls.mjs');

  // Save and mock XMLHttpRequest
  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Mock206XHR;

  let failbackCalled = false;
  let failbackUrls = [];

  const config = {
    failbackConfig: {
      staticHosts: ['failback.example.com'],
      onFailback: (orig, fb, attempt) => {
        failbackCalled = true;
        failbackUrls.push({ orig, fb, attempt });
      },
    },
  };

  const loader = new FailbackLoader(config);

  const context = {
    url: 'https://cdn.original.com/video/p_1_00.ts',
    frag: null,
    part: null,
    responseType: 'arraybuffer',
    headers: {},
    rangeStart: 0, // We did NOT request a range
    rangeEnd: 0, // We did NOT request a range
  };

  const loaderConfig = {
    loadPolicy: {
      maxTimeToFirstByteMs: 10000,
      maxLoadTimeMs: 60000,
    },
    maxRetry: 0,
    retryDelay: 0,
    maxRetryDelay: 0,
  };

  await new Promise((resolve, reject) => {
    const callbacks = {
      onSuccess: (response, stats, ctx, xhr) => {
        try {
          // Should succeed from failback host
          assert.ok(
            response.url.includes('failback.example.com'),
            `Expected failback URL, got: ${response.url}`,
          );

          // Failback should have been called
          assert.ok(failbackCalled, 'Failback should have been triggered');

          // Should have detected the 206 and failbacked
          assert.equal(
            failbackUrls.length,
            1,
            'Should have exactly 1 failback',
          );
          assert.ok(
            failbackUrls[0].orig.includes('cdn.original.com'),
            'Original should be cdn.original.com',
          );
          assert.ok(
            failbackUrls[0].fb.includes('failback.example.com'),
            'Failback should be failback.example.com',
          );

          // Check that failure was counted
          const state = getFailbackState(config);
          assert.equal(
            state.consecutiveFailures,
            1,
            'Should count as 1 failure',
          );

          resolve();
        } catch (e) {
          reject(e);
        }
      },
      onError: (error) => {
        reject(new Error(`Unexpected error: ${error.text || error.code}`));
      },
      onTimeout: () => {
        reject(new Error('Unexpected timeout'));
      },
      onAbort: () => {},
      onProgress: () => {},
    };

    loader.load(context, loaderConfig, callbacks);
  });

  // Cleanup
  globalThis.XMLHttpRequest = originalXHR;
  destroyFailbackState(config);
  loader.destroy();
});

// ----------------------------------------
// Test 20: Legitimate 206 (we requested range) should NOT failback
// ----------------------------------------
await test('Legitimate 206 (we requested range) should NOT failback', async () => {
  class Mock206XHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.response = null;
      this.responseURL = '';
      this._responseHeaders = new Map();
      this._url = '';
      this.onreadystatechange = null;
      this.onprogress = null;
      this.onerror = null;
    }

    open(method, url) {
      this._url = url;
      this.responseURL = url;
      this.readyState = 1;
    }

    setRequestHeader() {}

    getResponseHeader(name) {
      return this._responseHeaders.get(name.toLowerCase()) || null;
    }

    send() {
      setTimeout(() => {
        // Return 206 - but this is legitimate because context has rangeEnd
        this.status = 206;
        this.response = new ArrayBuffer(1000);
        this._responseHeaders.set('content-range', 'bytes 0-999/2624292');
        this._responseHeaders.set('content-length', '1000');

        this.readyState = 2;
        this.onreadystatechange?.();
        this.readyState = 4;
        this.onreadystatechange?.();
      }, 10);
    }

    abort() {}
  }

  const { FailbackLoader, destroyFailbackState } = await import(
    '../dist/hls.mjs'
  );

  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Mock206XHR;

  let failbackCalled = false;

  const config = {
    failbackConfig: {
      staticHosts: ['failback.example.com'],
      onFailback: () => {
        failbackCalled = true;
      },
    },
  };

  const loader = new FailbackLoader(config);

  const context = {
    url: 'https://cdn.original.com/video/segment.ts',
    frag: null,
    part: null,
    responseType: 'arraybuffer',
    headers: {},
    rangeStart: 0,
    rangeEnd: 1000, // WE requested a range
  };

  const loaderConfig = {
    loadPolicy: {
      maxTimeToFirstByteMs: 10000,
      maxLoadTimeMs: 60000,
    },
    maxRetry: 0,
    retryDelay: 0,
    maxRetryDelay: 0,
  };

  await new Promise((resolve, reject) => {
    const callbacks = {
      onSuccess: (response) => {
        try {
          // Should succeed from original CDN (not failback)
          assert.ok(
            response.url.includes('cdn.original.com'),
            `Expected original URL, got: ${response.url}`,
          );
          assert.ok(!failbackCalled, 'Failback should NOT have been triggered');
          resolve();
        } catch (e) {
          reject(e);
        }
      },
      onError: (error) => {
        reject(new Error(`Unexpected error: ${error.text}`));
      },
      onTimeout: () => reject(new Error('Timeout')),
      onAbort: () => {},
      onProgress: () => {},
    };

    loader.load(context, loaderConfig, callbacks);
  });

  globalThis.XMLHttpRequest = originalXHR;
  destroyFailbackState(config);
  loader.destroy();
});

// ----------------------------------------
// Test 21: 206 detection leads to permanent failback mode after threshold
// ----------------------------------------
await test('206 detection counts toward permanent failback mode', async () => {
  let requestCount = 0;

  class Mock206XHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.response = null;
      this.responseURL = '';
      this._responseHeaders = new Map();
      this._url = '';
      this.onreadystatechange = null;
      this.onprogress = null;
      this.onerror = null;
    }

    open(method, url) {
      this._url = url;
      this.responseURL = url;
      this.readyState = 1;
    }

    setRequestHeader() {}

    getResponseHeader(name) {
      return this._responseHeaders.get(name.toLowerCase()) || null;
    }

    send() {
      requestCount++;
      setTimeout(() => {
        if (this._url.includes('cdn.original.com')) {
          // Always return 206 partial (simulating persistent cache issue)
          this.status = 206;
          this.response = new ArrayBuffer(1);
          this._responseHeaders.set('content-range', 'bytes 100-100/1000000');
          this._responseHeaders.set('content-length', '1');
        } else {
          // Failback works
          this.status = 200;
          this.response = new ArrayBuffer(1000);
        }

        this.readyState = 2;
        this.onreadystatechange?.();
        this.readyState = 4;
        this.onreadystatechange?.();
      }, 10);
    }

    abort() {}
  }

  const { FailbackLoader, getFailbackState, destroyFailbackState } =
    await import('../dist/hls.mjs');

  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Mock206XHR;

  const config = {
    failbackConfig: {
      staticHosts: ['failback.example.com'],
    },
  };

  const createContext = (url) => ({
    url,
    frag: null,
    part: null,
    responseType: 'arraybuffer',
    headers: {},
    rangeStart: 0,
    rangeEnd: 0,
  });

  const loaderConfig = {
    loadPolicy: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 60000 },
    maxRetry: 0,
    retryDelay: 0,
    maxRetryDelay: 0,
  };

  const loadSegment = (url) =>
    new Promise((resolve, reject) => {
      const loader = new FailbackLoader(config);
      loader.load(createContext(url), loaderConfig, {
        onSuccess: (response) => {
          loader.destroy();
          resolve(response);
        },
        onError: (error) => {
          loader.destroy();
          reject(new Error(error.text));
        },
        onTimeout: () => {
          loader.destroy();
          reject(new Error('Timeout'));
        },
        onAbort: () => {},
        onProgress: () => {},
      });
    });

  // First segment - 206 detected, failback, count = 1
  requestCount = 0;
  await loadSegment('https://cdn.original.com/seg1.ts');
  let state = getFailbackState(config);
  assert.equal(
    state.consecutiveFailures,
    1,
    'Should have 1 failure after first 206',
  );
  assert.equal(
    state.permanentMode,
    false,
    'Should NOT be in permanent mode yet',
  );
  assert.equal(
    requestCount,
    2,
    'Should have 2 requests (original 206 + failback)',
  );

  // Second segment - 206 detected, failback, count = 2 -> permanent mode
  requestCount = 0;
  await loadSegment('https://cdn.original.com/seg2.ts');
  state = getFailbackState(config);
  assert.equal(state.consecutiveFailures, 2, 'Should have 2 failures');
  assert.equal(state.permanentMode, true, 'Should BE in permanent mode now');
  assert.equal(
    requestCount,
    2,
    'Should have 2 requests (original 206 + failback)',
  );

  // Third segment - should skip original entirely (permanent mode)
  requestCount = 0;
  await loadSegment('https://cdn.original.com/seg3.ts');
  assert.equal(
    requestCount,
    1,
    'Should have only 1 request (direct to failback)',
  );

  globalThis.XMLHttpRequest = originalXHR;
  destroyFailbackState(config);
});

// ----------------------------------------
// Summary
// ----------------------------------------

console.log('\n===== Test Summary =====\n');
console.log(`Total: ${passed + failed} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}

console.log('All integration tests passed!');
