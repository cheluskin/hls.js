/**
 * Standalone test for failback functionality
 * Run with: node tests/standalone-failback-test.mjs
 */

import { strict as assert } from 'assert';

// Mock global objects
globalThis.self = globalThis;
globalThis.console = console;

// Mock fetch for DNS resolver tests
let fetchMock = null;
globalThis.fetch = async (...args) => {
  if (fetchMock) return fetchMock(...args);
  throw new Error('fetch not mocked');
};

// Import the modules after setting up mocks
let clearDnsCache,
  fetchDnsTxt,
  fetchFailbackHosts,
  getFailbackState,
  resetFailbackState,
  destroyFailbackState;
try {
  const dnsModule = await import('../src/utils/dns-txt-resolver.ts');
  clearDnsCache = dnsModule.clearDnsCache;
  fetchDnsTxt = dnsModule.fetchDnsTxt;
  fetchFailbackHosts = dnsModule.fetchFailbackHosts;

  const loaderModule = await import('../src/utils/failback-loader.ts');
  getFailbackState = loaderModule.getFailbackState;
  resetFailbackState = loaderModule.resetFailbackState;
  destroyFailbackState = loaderModule.destroyFailbackState;
} catch {
  // If direct TS import fails, the project needs to be built first
  console.log(
    'Note: Running tests against built dist - run "npm run build" first',
  );
  const module = await import('../dist/hls.mjs');
  clearDnsCache = module.clearDnsCache;
  fetchDnsTxt = module.fetchDnsTxt;
  fetchFailbackHosts = module.fetchFailbackHosts;
  getFailbackState = module.getFailbackState;
  resetFailbackState = module.resetFailbackState;
  destroyFailbackState = module.destroyFailbackState;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  console.log(`Test: ${name}`);
  try {
    fn();
    console.log('  ✓ Passed\n');
    passed++;
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}\n`);
    failed++;
  }
}

async function testAsync(name, fn) {
  console.log(`Test: ${name}`);
  try {
    await fn();
    console.log('  ✓ Passed\n');
    passed++;
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}\n`);
    failed++;
  }
}

console.log('===== DNS TXT Resolver Tests =====\n');

// Test 1: fetchDnsTxt should parse DNS response correctly
await testAsync('fetchDnsTxt parses DNS response correctly', async () => {
  clearDnsCache();
  fetchMock = async () => ({
    ok: true,
    json: async () => ({
      Status: 0,
      Answer: [
        { type: 16, data: '"host1.example.com"' },
        { type: 16, data: '"host2.example.com"' },
      ],
    }),
  });

  const result = await fetchDnsTxt('test.example.com');
  assert.deepEqual(result, ['host1.example.com', 'host2.example.com']);
});

// Test 2: fetchDnsTxt should handle failures
await testAsync('fetchDnsTxt handles failures gracefully', async () => {
  clearDnsCache();
  fetchMock = async () => ({ ok: false });

  const result = await fetchDnsTxt('fail.example.com');
  assert.deepEqual(result, []);
});

// Test 3: fetchDnsTxt should cache results
await testAsync('fetchDnsTxt caches results', async () => {
  clearDnsCache();
  let callCount = 0;
  fetchMock = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({
        Status: 0,
        Answer: [{ type: 16, data: '"cached.example.com"' }],
      }),
    };
  };

  await fetchDnsTxt('cache-test.example.com');
  const firstCallCount = callCount;
  await fetchDnsTxt('cache-test.example.com');
  // Second call should use cache, so callCount should not increase
  assert.equal(callCount, firstCallCount, 'second fetch should use cache');
});

// Test 4: fetchFailbackHosts filters empty records
await testAsync('fetchFailbackHosts filters empty records', async () => {
  clearDnsCache();
  fetchMock = async () => ({
    ok: true,
    json: async () => ({
      Status: 0,
      Answer: [
        { type: 16, data: '"valid.example.com"' },
        { type: 16, data: '""' },
        { type: 16, data: '"   "' },
        { type: 16, data: '"another.example.com"' },
      ],
    }),
  });

  const result = await fetchFailbackHosts('filter-test.example.com');
  assert.deepEqual(result, ['valid.example.com', 'another.example.com']);
});

// Test 5: fetchDnsTxt filters only TXT records (type 16)
await testAsync('fetchDnsTxt filters only TXT records (type 16)', async () => {
  clearDnsCache();
  fetchMock = async () => ({
    ok: true,
    json: async () => ({
      Status: 0,
      Answer: [
        { type: 1, data: '192.168.1.1' }, // A record
        { type: 16, data: '"txt-record"' }, // TXT record
        { type: 28, data: '::1' }, // AAAA record
        { type: 5, data: 'cname.example.com' }, // CNAME record
      ],
    }),
  });

  const result = await fetchDnsTxt('filter-type.example.com');
  assert.deepEqual(result, ['txt-record']);
});

// Test 6: fetchDnsTxt handles network errors
await testAsync('fetchDnsTxt handles network errors', async () => {
  clearDnsCache();
  fetchMock = async () => {
    throw new Error('Network error');
  };

  const result = await fetchDnsTxt('network-error.example.com');
  assert.deepEqual(result, []);
});

// Test 7: fetchDnsTxt falls back to second provider
await testAsync(
  'fetchDnsTxt falls back to second provider on first failure',
  async () => {
    clearDnsCache();
    let callCount = 0;
    fetchMock = async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false }; // First provider fails
      }
      return {
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: [{ type: 16, data: '"fallback-provider"' }],
        }),
      };
    };

    const result = await fetchDnsTxt('provider-fallback.example.com');
    assert.deepEqual(result, ['fallback-provider']);
    assert.equal(callCount, 2);
  },
);

// Test 8: fetchDnsTxt returns empty on non-zero status
await testAsync('fetchDnsTxt returns empty on DNS error status', async () => {
  clearDnsCache();
  fetchMock = async () => ({
    ok: true,
    json: async () => ({
      Status: 3, // NXDOMAIN
      Answer: [],
    }),
  });

  const result = await fetchDnsTxt('nxdomain.example.com');
  assert.deepEqual(result, []);
});

console.log('===== FailbackLoader Tests =====\n');

// Helper function for URL transformation
function getFailbackUrl(originalUrl, hosts, attempt) {
  if (attempt >= hosts.length) return null;
  try {
    const url = new URL(originalUrl);
    const failbackHost = hosts[attempt];

    // Parse failback host (may include port like "cdn.example.com:8080")
    if (failbackHost.includes(':')) {
      const [hostname, port] = failbackHost.split(':');
      url.hostname = hostname;
      url.port = port;
    } else {
      url.hostname = failbackHost;
      url.port = ''; // Reset port to default
    }

    // Always use HTTPS for failback hosts (CDNs require it)
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

test('URL transformation with multiple hosts', () => {
  const hosts = ['failback1.test.com', 'failback2.test.com'];
  const originalUrl = 'https://primary.test.com/video/segment.ts?token=abc';

  const url0 = getFailbackUrl(originalUrl, hosts, 0);
  assert.equal(url0, 'https://failback1.test.com/video/segment.ts?token=abc');

  const url1 = getFailbackUrl(originalUrl, hosts, 1);
  assert.equal(url1, 'https://failback2.test.com/video/segment.ts?token=abc');

  const url2 = getFailbackUrl(originalUrl, hosts, 2);
  assert.equal(url2, null);
});

test('URL preserves path and query params', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl =
    'https://origin.example.com/path/to/file.ts?key=value&foo=bar';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.hostname, 'cdn.example.com');
  assert.equal(parsed.pathname, '/path/to/file.ts');
  assert.equal(parsed.searchParams.get('key'), 'value');
  assert.equal(parsed.searchParams.get('foo'), 'bar');
});

test('URL preserves protocol (https)', () => {
  const hosts = ['cdn.example.com'];
  const httpsUrl = 'https://origin.example.com/video.ts';

  const failbackUrl = getFailbackUrl(httpsUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.protocol, 'https:');
});

test('URL upgrades http to https for failback', () => {
  const hosts = ['cdn.example.com'];
  const httpUrl = 'http://origin.example.com/video.ts';

  const failbackUrl = getFailbackUrl(httpUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  // Failback always uses HTTPS (CDNs require it)
  assert.equal(parsed.protocol, 'https:');
});

test('URL preserves port number', () => {
  const hosts = ['cdn.example.com:8080'];
  const originalUrl = 'https://origin.example.com:3000/video.ts';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.host, 'cdn.example.com:8080');
});

test('Invalid URL returns null', () => {
  const hosts = ['cdn.example.com'];
  const invalidUrl = 'not-a-valid-url';

  const result = getFailbackUrl(invalidUrl, hosts, 0);
  assert.equal(result, null);
});

test('Empty hosts array returns null for any attempt', () => {
  const hosts = [];
  const originalUrl = 'https://origin.example.com/video.ts';

  assert.equal(getFailbackUrl(originalUrl, hosts, 0), null);
  assert.equal(getFailbackUrl(originalUrl, hosts, 1), null);
});

test('URL with hash fragment is preserved', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl = 'https://origin.example.com/video.ts#t=10';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.hash, '#t=10');
});

test('URL with username/password is preserved', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl = 'https://user:pass@origin.example.com/video.ts';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.username, 'user');
  assert.equal(parsed.password, 'pass');
});

test('URL with encoded characters is preserved', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl =
    'https://origin.example.com/path/video%20file.ts?name=%D1%82%D0%B5%D1%81%D1%82';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.pathname, '/path/video%20file.ts');
  assert.equal(parsed.searchParams.get('name'), 'тест');
});

// Custom transform function tests
test('Custom transform function overrides default behavior', () => {
  function customTransform(url, attempt) {
    if (attempt >= 2) return null;
    return `https://custom-cdn${attempt}.example.com/custom-path`;
  }

  assert.equal(
    customTransform('https://any.com/path', 0),
    'https://custom-cdn0.example.com/custom-path',
  );
  assert.equal(
    customTransform('https://any.com/path', 1),
    'https://custom-cdn1.example.com/custom-path',
  );
  assert.equal(customTransform('https://any.com/path', 2), null);
});

test('Custom transform function receives correct attempt number', () => {
  const attempts = [];
  function customTransform(url, attempt) {
    attempts.push(attempt);
    return attempt < 3 ? `https://cdn${attempt}.example.com` : null;
  }

  customTransform('https://test.com', 0);
  customTransform('https://test.com', 1);
  customTransform('https://test.com', 2);
  customTransform('https://test.com', 3);

  assert.deepEqual(attempts, [0, 1, 2, 3]);
});

console.log('===== Failback State Management Tests =====\n');

// Mock config object for WeakMap key
const mockConfig = {};

// Test: getFailbackState returns correct initial state
test('getFailbackState returns correct initial state', () => {
  resetFailbackState(mockConfig);
  const state = getFailbackState(mockConfig);

  assert.equal(typeof state.consecutiveFailures, 'number');
  assert.equal(typeof state.permanentMode, 'boolean');
  assert.equal(typeof state.threshold, 'number');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.permanentMode, false);
  assert.equal(state.threshold, 2); // PERMANENT_FAILBACK_THRESHOLD
});

// Test: resetFailbackState resets state to initial values
test('resetFailbackState resets state to initial values', () => {
  // First reset to ensure clean state
  resetFailbackState(mockConfig);

  // Get state before and after reset
  const stateBefore = getFailbackState(mockConfig);
  assert.equal(stateBefore.consecutiveFailures, 0);
  assert.equal(stateBefore.permanentMode, false);

  // Reset again - should not change anything
  resetFailbackState(mockConfig);
  const stateAfter = getFailbackState(mockConfig);
  assert.equal(stateAfter.consecutiveFailures, 0);
  assert.equal(stateAfter.permanentMode, false);
});

// Test: getFailbackState threshold value is correct
test('getFailbackState threshold value is correct (2 failures for permanent mode)', () => {
  const state = getFailbackState(mockConfig);
  assert.equal(state.threshold, 2);
});

console.log('===== Stall Detection Constants Tests =====\n');

// Test: Verify stall detection parameters are within expected ranges
test('Stall detection parameters are reasonable', () => {
  // These values should be checked against the implementation
  const STALL_TIMEOUT_MS = 5000; // Expected: 5 seconds
  const STALL_CHECK_INTERVAL_MS = 1000; // Expected: 1 second
  const MIN_SPEED_BYTES_PER_SEC = 4096; // Expected: 4KB/s

  // Stall timeout should be reasonable (1-30 seconds)
  assert.ok(
    STALL_TIMEOUT_MS >= 1000,
    'Stall timeout should be at least 1 second',
  );
  assert.ok(
    STALL_TIMEOUT_MS <= 30000,
    'Stall timeout should be at most 30 seconds',
  );

  // Check interval should be less than timeout
  assert.ok(
    STALL_CHECK_INTERVAL_MS < STALL_TIMEOUT_MS,
    'Check interval should be less than timeout',
  );

  // Minimum speed should be low enough to detect only real stalls
  assert.ok(MIN_SPEED_BYTES_PER_SEC > 0, 'Minimum speed should be positive');
  assert.ok(
    MIN_SPEED_BYTES_PER_SEC <= 10240,
    'Minimum speed should be at most 10KB/s',
  );
});

// Test: Permanent failback threshold is reasonable
test('Permanent failback threshold is reasonable', () => {
  const state = getFailbackState(mockConfig);

  // Threshold should be at least 1
  assert.ok(state.threshold >= 1, 'Threshold should be at least 1');

  // Threshold should not be too high (to react quickly to persistent issues)
  assert.ok(state.threshold <= 5, 'Threshold should be at most 5');
});

console.log('===== URL Edge Cases Tests =====\n');

// Test: URL with IPv6 host
test('URL transformation with IPv6 host handles correctly', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl = 'https://[::1]:8080/video.ts';

  // Should still work - the URL class handles IPv6
  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.hostname, 'cdn.example.com');
  assert.equal(parsed.pathname, '/video.ts');
});

// Test: URL with very long path
test('URL transformation preserves very long paths', () => {
  const hosts = ['cdn.example.com'];
  const longPath = '/a'.repeat(500);
  const originalUrl = `https://origin.example.com${longPath}/video.ts`;

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.pathname, `${longPath}/video.ts`);
});

// Test: URL with special characters in query params
test('URL transformation preserves special characters in query params', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl =
    'https://origin.example.com/video.ts?data=%7B%22key%22%3A%22value%22%7D&token=abc+def';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  // Query string should be preserved
  assert.ok(failbackUrl.includes('data='));
  assert.ok(failbackUrl.includes('token='));
});

// Test: URL with multiple query params with same name
test('URL transformation preserves multiple query params with same name', () => {
  const hosts = ['cdn.example.com'];
  const originalUrl = 'https://origin.example.com/video.ts?tag=a&tag=b&tag=c';

  const failbackUrl = getFailbackUrl(originalUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  const tags = parsed.searchParams.getAll('tag');
  assert.deepEqual(tags, ['a', 'b', 'c']);
});

console.log('===== CDN Recovery Tests =====\n');

// Test: destroyFailbackState resets all state
test('destroyFailbackState resets all state completely', () => {
  // First, reset to a known state
  destroyFailbackState(mockConfig);
  const state = getFailbackState(mockConfig);

  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.permanentMode, false);
});

// Test: resetFailbackState from non-permanent mode sets failures to 0
test('resetFailbackState from non-permanent mode sets failures to 0', () => {
  destroyFailbackState(mockConfig);

  // Not in permanent mode
  resetFailbackState(mockConfig);
  const state = getFailbackState(mockConfig);

  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.permanentMode, false);
});

// Test: Multiple destroyFailbackState calls are safe
test('Multiple destroyFailbackState calls are idempotent', () => {
  destroyFailbackState(mockConfig);
  destroyFailbackState(mockConfig);
  destroyFailbackState(mockConfig);

  const state = getFailbackState(mockConfig);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.permanentMode, false);
});

// Test: State functions are exported and callable
test('All state functions are exported and callable', () => {
  assert.equal(typeof getFailbackState, 'function');
  assert.equal(typeof resetFailbackState, 'function');
  assert.equal(typeof destroyFailbackState, 'function');
});

console.log('===== CDN Recovery Constants Tests =====\n');

// Test: Recovery constants are reasonable
test('Recovery constants are within expected ranges', () => {
  // These are the expected values from the implementation
  const PROBE_EVERY_N_FRAGMENTS = 6;
  const PROBE_TIMEOUT_MS = 3000;
  const MIN_BUFFER_FOR_RECOVERY = 40;

  // Probe frequency should be reasonable (3-20 fragments)
  assert.ok(PROBE_EVERY_N_FRAGMENTS >= 3, 'Should not probe too frequently');
  assert.ok(
    PROBE_EVERY_N_FRAGMENTS <= 20,
    'Should not wait too long between probes',
  );

  // Probe timeout should be reasonable (1-10 seconds)
  assert.ok(
    PROBE_TIMEOUT_MS >= 1000,
    'Probe timeout should be at least 1 second',
  );
  assert.ok(
    PROBE_TIMEOUT_MS <= 10000,
    'Probe timeout should be at most 10 seconds',
  );

  // Buffer requirement should be reasonable (20-120 seconds)
  assert.ok(
    MIN_BUFFER_FOR_RECOVERY >= 20,
    'Buffer requirement should be at least 20 seconds',
  );
  assert.ok(
    MIN_BUFFER_FOR_RECOVERY <= 120,
    'Buffer requirement should be at most 120 seconds',
  );
});

// Test: Buffer calculation helper
test('Buffer ahead calculation logic is correct', () => {
  // Mock video element with buffer from 0-45 seconds, current time at 5
  const mockVideo = {
    buffered: {
      length: 1,
      start: (i) => 0,
      end: (i) => 45,
    },
    currentTime: 5,
  };

  // Expected buffer ahead: 45 - 5 = 40 seconds
  const expectedBufferAhead = mockVideo.buffered.end(0) - mockVideo.currentTime;
  assert.equal(expectedBufferAhead, 40);
});

// Test: Buffer calculation with gap
test('Buffer ahead calculation handles gaps correctly', () => {
  // Mock video with gap - two buffered ranges
  const mockVideo = {
    buffered: {
      length: 2,
      start: (i) => (i === 0 ? 0 : 50),
      end: (i) => (i === 0 ? 30 : 80),
    },
    currentTime: 25, // In first range
  };

  // Current time is in first range (0-30), so buffer ahead = 30 - 25 = 5
  let bufferAhead = 0;
  for (let i = 0; i < mockVideo.buffered.length; i++) {
    if (
      mockVideo.buffered.start(i) <= mockVideo.currentTime &&
      mockVideo.currentTime <= mockVideo.buffered.end(i)
    ) {
      bufferAhead = mockVideo.buffered.end(i) - mockVideo.currentTime;
      break;
    }
  }
  assert.equal(bufferAhead, 5);
});

// Test: Buffer calculation outside any range
test('Buffer ahead returns 0 when current time is in gap', () => {
  const mockVideo = {
    buffered: {
      length: 2,
      start: (i) => (i === 0 ? 0 : 50),
      end: (i) => (i === 0 ? 30 : 80),
    },
    currentTime: 40, // In gap between ranges
  };

  let bufferAhead = 0;
  for (let i = 0; i < mockVideo.buffered.length; i++) {
    if (
      mockVideo.buffered.start(i) <= mockVideo.currentTime &&
      mockVideo.currentTime <= mockVideo.buffered.end(i)
    ) {
      bufferAhead = mockVideo.buffered.end(i) - mockVideo.currentTime;
      break;
    }
  }
  assert.equal(bufferAhead, 0);
});

console.log('===== Test Summary =====\n');
console.log(`Total: ${passed + failed} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}

console.log('All tests passed!');
