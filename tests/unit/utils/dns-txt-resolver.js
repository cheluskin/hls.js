import { expect } from 'chai';
import sinon from 'sinon';
import {
  fetchDnsTxt,
  fetchFailbackHosts,
  clearDnsCache,
  expireNegativeDnsCache,
  getDohProviders,
  setDohProviders,
  NEGATIVE_DNS_CACHE_TTL_MS,
} from '../../../src/utils/dns-txt-resolver';
import { preloadFailbackHosts } from '../../../src/utils/failback-host-resolver';

describe('dns-txt-resolver', function () {
  let originalFetch;

  beforeEach(function () {
    // Clear DNS cache before each test
    clearDnsCache();
    // Save original fetch
    originalFetch = self.fetch;
  });

  afterEach(function () {
    // Restore original fetch
    self.fetch = originalFetch;
    setDohProviders();
  });

  describe('fetchDnsTxt', function () {
    it('should fetch TXT records from DNS-over-HTTPS', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [
          { type: 16, data: '"host1.example.com"' },
          { type: 16, data: '"host2.example.com"' },
        ],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal(['host1.example.com', 'host2.example.com']);
      // Parallel requests to all providers
      expect(self.fetch.called).to.be.true;
      expect(self.fetch.firstCall.args[0]).to.include('test.example.com');
      expect(self.fetch.firstCall.args[0]).to.include('type=TXT');
    });

    it('should remove surrounding quotes from TXT data', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: '"quoted-value"' }],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal(['quoted-value']);
    });

    it('should handle unquoted TXT data', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: 'unquoted-value' }],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal(['unquoted-value']);
    });

    it('should cache DNS results permanently', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: '"cached-host"' }],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // First call
      const result1 = await fetchDnsTxt('cached.example.com');
      const callCountAfterFirst = self.fetch.callCount;
      // Second call - should use cache
      const result2 = await fetchDnsTxt('cached.example.com');

      expect(result1).to.deep.equal(['cached-host']);
      expect(result2).to.deep.equal(['cached-host']);
      // Second call should use cache, so callCount should not increase
      expect(self.fetch.callCount).to.equal(callCountAfterFirst);
    });

    it('should filter only TXT records (type 16)', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [
          { type: 1, data: '192.168.1.1' }, // A record
          { type: 16, data: '"txt-record"' }, // TXT record
          { type: 28, data: '::1' }, // AAAA record
        ],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal(['txt-record']);
    });

    it('should succeed when at least one provider succeeds', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: '"success-host"' }],
      };

      self.fetch = sinon.stub().callsFake((url) => {
        if (String(url).includes('dns.google')) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        });
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal(['success-host']);
      expect(self.fetch.called).to.be.true;
      expect(self.fetch.callCount).to.equal(getDohProviders().length);
    });

    it('should query overridden DoH providers', async function () {
      setDohProviders(['https://doh.test.example/resolve']);
      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () =>
          Promise.resolve({
            Status: 0,
            Answer: [{ type: 16, data: '"custom.example.com"' }],
          }),
      });

      const result = await fetchDnsTxt('custom-doh.example.com');

      expect(result).to.deep.equal(['custom.example.com']);
      expect(self.fetch.callCount).to.equal(1);
      expect(self.fetch.firstCall.args[0]).to.include('doh.test.example');
    });

    it('should return empty array when all providers fail and cache empty result', async function () {
      self.fetch = sinon.stub().resolves({ ok: false });

      const result1 = await fetchDnsTxt('test.example.com');
      const callCountAfterFirst = self.fetch.callCount;

      const result2 = await fetchDnsTxt('test.example.com');

      expect(result1).to.deep.equal([]);
      expect(result2).to.deep.equal([]);
      expect(self.fetch.callCount).to.equal(callCountAfterFirst);
    });

    it('should retry a negative DNS lookup after the TTL expires', async function () {
      const start = Date.now();
      const nowStub = sinon.stub(Date, 'now').returns(start);
      try {
        self.fetch = sinon.stub().resolves({ ok: false });

        const result1 = await fetchDnsTxt('neg-ttl.example.com');
        expect(result1).to.deep.equal([]);
        const callCountAfterFail = self.fetch.callCount;

        nowStub.returns(start + NEGATIVE_DNS_CACHE_TTL_MS - 1);
        const stillCached = await fetchDnsTxt('neg-ttl.example.com');
        expect(stillCached).to.deep.equal([]);
        expect(self.fetch.callCount).to.equal(callCountAfterFail);

        nowStub.returns(start + NEGATIVE_DNS_CACHE_TTL_MS + 1);
        self.fetch = sinon.stub().resolves({
          ok: true,
          json: () =>
            Promise.resolve({
              Status: 0,
              Answer: [{ type: 16, data: '"recovered.example.com"' }],
            }),
        });

        const recovered = await fetchDnsTxt('neg-ttl.example.com');
        expect(recovered).to.deep.equal(['recovered.example.com']);
      } finally {
        nowStub.restore();
      }
    });

    it('should return empty array on network error', async function () {
      self.fetch = sinon.stub().rejects(new Error('Network error'));

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal([]);
    });

    it('should return empty array when no TXT records found', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [], // No answers
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal([]);
    });

    it('should return empty array when Status is not 0', async function () {
      const mockResponse = {
        Status: 3, // NXDOMAIN
        Answer: [],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal([]);
    });

    it('should send correct Accept header', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: '"test"' }],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchDnsTxt('test.example.com');

      const fetchOptions = self.fetch.firstCall.args[1];
      expect(fetchOptions.headers.Accept).to.equal('application/dns-json');
    });
  });

  describe('fetchFailbackHosts', function () {
    it('should fetch failback hosts from DNS', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [
          { type: 16, data: '"failback1.example.com"' },
          { type: 16, data: '"failback2.example.com"' },
        ],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchFailbackHosts('fb.example.com');

      expect(result).to.deep.equal([
        'failback1.example.com',
        'failback2.example.com',
      ]);
    });

    it('should use default domain when not specified', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: '"default-host"' }],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchFailbackHosts();

      expect(self.fetch.firstCall.args[0]).to.include('fb.turoktv.com');
    });

    it('should filter out empty records', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [
          { type: 16, data: '"valid-host"' },
          { type: 16, data: '""' }, // Empty string
          { type: 16, data: '"   "' }, // Only whitespace
          { type: 16, data: '"another-host"' },
        ],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchFailbackHosts('test.example.com');

      expect(result).to.deep.equal(['valid-host', 'another-host']);
    });
  });

  describe('clearDnsCache', function () {
    it('should clear the DNS cache', async function () {
      const mockResponse = {
        Status: 0,
        Answer: [{ type: 16, data: '"host"' }],
      };

      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // First call populates cache
      await fetchDnsTxt('test.example.com');
      const callCountAfterFirst = self.fetch.callCount;

      // Clear cache
      clearDnsCache();

      // Second call should fetch again
      await fetchDnsTxt('test.example.com');
      // Call count should increase after cache clear
      expect(self.fetch.callCount).to.be.greaterThan(callCountAfterFirst);
    });
  });

  describe('preloadFailbackHosts after negative DNS', function () {
    it('should pick up DNS hosts after the negative cache expires', async function () {
      self.fetch = sinon.stub().resolves({ ok: false });

      const fallbackHosts = await preloadFailbackHosts(
        'preload-neg-ttl.example.com',
      );
      expect(fallbackHosts).to.be.an('array');

      expireNegativeDnsCache();
      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () =>
          Promise.resolve({
            Status: 0,
            Answer: [{ type: 16, data: '"recovered-host.example.com"' }],
          }),
      });

      const recovered = await preloadFailbackHosts(
        'preload-neg-ttl.example.com',
      );
      expect(recovered).to.deep.equal(['recovered-host.example.com']);
    });

    it('should keep a positive host cache when only negative DNS entries expire', async function () {
      self.fetch = sinon.stub().resolves({
        ok: true,
        json: () =>
          Promise.resolve({
            Status: 0,
            Answer: [{ type: 16, data: '"keep-me.example.com"' }],
          }),
      });

      const positive = await preloadFailbackHosts('positive-keep.example.com');
      expect(positive).to.deep.equal(['keep-me.example.com']);

      self.fetch = sinon.stub().resolves({ ok: false });
      await preloadFailbackHosts('negative-drop.example.com');
      const fetchCountAfterNegative = self.fetch.callCount;

      expireNegativeDnsCache();

      const stillPositive = await preloadFailbackHosts(
        'positive-keep.example.com',
      );
      expect(stillPositive).to.deep.equal(['keep-me.example.com']);
      expect(self.fetch.callCount).to.equal(fetchCountAfterNegative);
    });
  });
});
