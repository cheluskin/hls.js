import {
  fetchDnsTxt,
  fetchFailbackHosts,
  clearDnsCache,
} from '../../../src/utils/dns-txt-resolver';

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

      // First provider fails, second succeeds (parallel requests)
      self.fetch = sinon.stub();
      self.fetch.onFirstCall().resolves({ ok: false });
      self.fetch.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal(['success-host']);
      // Both providers are called in parallel
      expect(self.fetch.called).to.be.true;
    });

    it('should return empty array when all providers fail', async function () {
      self.fetch = sinon.stub().resolves({ ok: false });

      const result = await fetchDnsTxt('test.example.com');

      expect(result).to.deep.equal([]);
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
});
