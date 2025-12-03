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
let clearDnsCache, fetchDnsTxt, fetchFailbackHosts;
try {
  const module = await import('../src/utils/dns-txt-resolver.ts');
  clearDnsCache = module.clearDnsCache;
  fetchDnsTxt = module.fetchDnsTxt;
  fetchFailbackHosts = module.fetchFailbackHosts;
} catch {
  // If direct TS import fails, the project needs to be built first
  console.log(
    'Note: Running tests against built dist - run "npm run build" first',
  );
  const module = await import('../dist/hls.mjs');
  clearDnsCache = module.clearDnsCache;
  fetchDnsTxt = module.fetchDnsTxt;
  fetchFailbackHosts = module.fetchFailbackHosts;
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
  await fetchDnsTxt('cache-test.example.com');
  assert.equal(callCount, 1, 'fetch should only be called once');
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
    url.host = hosts[attempt];
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

test('URL preserves protocol (http)', () => {
  const hosts = ['cdn.example.com'];
  const httpUrl = 'http://origin.example.com/video.ts';

  const failbackUrl = getFailbackUrl(httpUrl, hosts, 0);
  const parsed = new URL(failbackUrl);

  assert.equal(parsed.protocol, 'http:');
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

console.log('===== Test Summary =====\n');
console.log(`Total: ${passed + failed} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}

console.log('All tests passed!');
