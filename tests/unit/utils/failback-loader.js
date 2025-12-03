import FailbackLoader, {
  preloadFailbackHosts,
} from '../../../src/utils/failback-loader';

describe('FailbackLoader', function () {
  let loader;
  let mockConfig;
  let mockContext;
  let mockLoaderConfig;
  let mockCallbacks;
  let xhrInstances;
  let originalXMLHttpRequest;
  let originalFetch;
  let clock;

  // Mock XMLHttpRequest
  class MockXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.response = null;
      this.responseURL = '';
      this.responseType = '';
      this.onreadystatechange = null;
      this.onprogress = null;
      this._headers = {};
      this._requestHeaders = {};
      xhrInstances.push(this);
    }

    open(method, url) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
    }

    setRequestHeader(name, value) {
      this._requestHeaders[name] = value;
    }

    getResponseHeader(name) {
      return this._headers[name] || null;
    }

    send() {
      // Simulate async behavior - test will trigger state changes
    }

    abort() {
      this.readyState = 4;
      this.status = 0;
    }

    // Helper methods for tests
    _simulateSuccess(data, status = 200) {
      this.readyState = 2;
      if (this.onreadystatechange) this.onreadystatechange();

      this.readyState = 4;
      this.status = status;
      this.statusText = 'OK';
      this.response = data;
      this.responseURL = this._url;
      if (this.onreadystatechange) this.onreadystatechange();
    }

    _simulateError(status, statusText = 'Error') {
      this.readyState = 2;
      if (this.onreadystatechange) this.onreadystatechange();

      this.readyState = 4;
      this.status = status;
      this.statusText = statusText;
      this.response = null;
      if (this.onreadystatechange) this.onreadystatechange();
    }

    _simulateProgress(loaded, total) {
      if (this.onprogress) {
        this.onprogress({ loaded, total, lengthComputable: total > 0 });
      }
    }
  }

  beforeEach(function () {
    // Setup fake timers
    clock = sinon.useFakeTimers();

    // Track XHR instances
    xhrInstances = [];

    // Save and replace XMLHttpRequest
    originalXMLHttpRequest = self.XMLHttpRequest;
    self.XMLHttpRequest = MockXMLHttpRequest;

    // Save and replace fetch for DNS resolver
    originalFetch = self.fetch;
    self.fetch = sinon.stub().resolves({
      ok: true,
      json: () =>
        Promise.resolve({
          Status: 0,
          Answer: [
            { type: 16, data: '"failback1.test.com"' },
            { type: 16, data: '"failback2.test.com"' },
          ],
        }),
    });

    // Create mock config
    mockConfig = {
      failbackConfig: {
        staticHosts: ['failback1.test.com', 'failback2.test.com'],
      },
    };

    // Create mock context
    mockContext = {
      url: 'https://primary.test.com/video/segment.ts',
      responseType: 'arraybuffer',
      headers: { 'X-Custom': 'header' },
    };

    // Create mock loader config
    mockLoaderConfig = {
      loadPolicy: {
        maxTimeToFirstByteMs: 5000,
        maxLoadTimeMs: 30000,
      },
    };

    // Create mock callbacks
    mockCallbacks = {
      onSuccess: sinon.stub(),
      onError: sinon.stub(),
      onTimeout: sinon.stub(),
      onAbort: sinon.stub(),
      onProgress: sinon.stub(),
    };

    loader = new FailbackLoader(mockConfig);
  });

  afterEach(function () {
    clock.restore();
    self.XMLHttpRequest = originalXMLHttpRequest;
    self.fetch = originalFetch;
    if (loader) {
      loader.destroy();
    }
  });

  describe('constructor', function () {
    it('should create loader with config', function () {
      expect(loader).to.be.instanceOf(FailbackLoader);
      expect(loader.stats).to.exist;
      expect(loader.context).to.be.null;
    });

    it('should initialize stats', function () {
      expect(loader.stats.loaded).to.equal(0);
      expect(loader.stats.aborted).to.be.false;
    });

    it('should handle missing failbackConfig', function () {
      const loaderWithoutConfig = new FailbackLoader({});
      expect(loaderWithoutConfig).to.be.instanceOf(FailbackLoader);
    });
  });

  describe('load', function () {
    it('should load from primary URL', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      expect(xhrInstances).to.have.lengthOf(1);
      expect(xhrInstances[0]._url).to.equal(
        'https://primary.test.com/video/segment.ts',
      );
      expect(xhrInstances[0]._method).to.equal('GET');
    });

    it('should set custom headers', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      expect(xhrInstances[0]._requestHeaders['X-Custom']).to.equal('header');
    });

    it('should set Range header when rangeEnd is specified', function () {
      const contextWithRange = {
        ...mockContext,
        rangeStart: 100,
        rangeEnd: 200,
      };

      loader.load(contextWithRange, mockLoaderConfig, mockCallbacks);

      expect(xhrInstances[0]._requestHeaders.Range).to.equal('bytes=100-199');
    });

    it('should throw if loader is used twice', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      xhrInstances[0]._simulateSuccess(new ArrayBuffer(100));

      expect(() => {
        loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      }).to.throw('Loader can only be used once.');
    });

    it('should record loading start time', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      expect(loader.stats.loading.start).to.be.greaterThan(0);
    });
  });

  describe('successful load', function () {
    it('should call onSuccess callback on successful load', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      const mockData = new ArrayBuffer(1000);
      xhrInstances[0]._simulateSuccess(mockData);

      expect(mockCallbacks.onSuccess.calledOnce).to.be.true;
      const [response, stats, context] = mockCallbacks.onSuccess.firstCall.args;
      expect(response.data).to.equal(mockData);
      expect(response.code).to.equal(200);
      expect(stats.loaded).to.equal(1000);
      expect(context).to.equal(mockContext);
    });

    it('should call onProgress callback', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      const mockData = new ArrayBuffer(1000);
      xhrInstances[0]._simulateSuccess(mockData);

      expect(mockCallbacks.onProgress.calledOnce).to.be.true;
    });

    it('should calculate bandwidth estimate', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Advance time a bit to have a non-zero duration
      clock.tick(100);

      const mockData = new ArrayBuffer(1000);
      xhrInstances[0]._simulateSuccess(mockData);

      expect(loader.stats.bwEstimate).to.be.greaterThan(0);
    });

    it('should update stats on progress', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0]._simulateProgress(500, 1000);

      expect(loader.stats.loaded).to.equal(500);
      expect(loader.stats.total).to.equal(1000);
    });
  });

  describe('failback behavior', function () {
    it('should try failback URL on primary failure', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // First request fails
      xhrInstances[0]._simulateError(500);

      // Should create new XHR for failback
      expect(xhrInstances).to.have.lengthOf(2);
      expect(xhrInstances[1]._url).to.equal(
        'https://failback1.test.com/video/segment.ts',
      );
    });

    it('should try second failback URL when first failback fails', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Primary fails
      xhrInstances[0]._simulateError(500);
      // First failback fails
      xhrInstances[1]._simulateError(500);

      // Should create new XHR for second failback
      expect(xhrInstances).to.have.lengthOf(3);
      expect(xhrInstances[2]._url).to.equal(
        'https://failback2.test.com/video/segment.ts',
      );
    });

    it('should call onError when all failback attempts fail', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // All attempts fail
      xhrInstances[0]._simulateError(500);
      xhrInstances[1]._simulateError(500);
      xhrInstances[2]._simulateError(500);

      expect(mockCallbacks.onError.calledOnce).to.be.true;
      const [error] = mockCallbacks.onError.firstCall.args;
      expect(error.code).to.equal(500);
    });

    it('should succeed on failback after primary failure', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Primary fails
      xhrInstances[0]._simulateError(500);

      // Failback succeeds
      const mockData = new ArrayBuffer(100);
      xhrInstances[1]._simulateSuccess(mockData);

      expect(mockCallbacks.onSuccess.calledOnce).to.be.true;
      expect(mockCallbacks.onError.called).to.be.false;
    });

    it('should call onFailback callback when failback is triggered', function () {
      const onFailbackStub = sinon.stub();
      mockConfig.failbackConfig.onFailback = onFailbackStub;
      loader = new FailbackLoader(mockConfig);

      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Primary fails
      xhrInstances[0]._simulateError(500);

      expect(onFailbackStub.calledOnce).to.be.true;
      const [originalUrl, failbackUrl, attempt] = onFailbackStub.firstCall.args;
      expect(originalUrl).to.equal(mockContext.url);
      expect(failbackUrl).to.include('failback1.test.com');
      expect(attempt).to.equal(1);
    });

    it('should call onAllFailed callback when all attempts fail', function () {
      const onAllFailedStub = sinon.stub();
      mockConfig.failbackConfig.onAllFailed = onAllFailedStub;
      loader = new FailbackLoader(mockConfig);

      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // All attempts fail
      xhrInstances[0]._simulateError(500);
      xhrInstances[1]._simulateError(500);
      xhrInstances[2]._simulateError(500);

      expect(onAllFailedStub.calledOnce).to.be.true;
      const [originalUrl, attempts] = onAllFailedStub.firstCall.args;
      expect(originalUrl).to.equal(mockContext.url);
      expect(attempts).to.equal(3);
    });

    it('should handle 404 errors as failures', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0]._simulateError(404, 'Not Found');

      // Should trigger failback
      expect(xhrInstances).to.have.lengthOf(2);
    });

    it('should handle various HTTP error codes', function () {
      const errorCodes = [400, 403, 404, 500, 502, 503, 504];

      errorCodes.forEach((code, index) => {
        loader = new FailbackLoader(mockConfig);
        loader.load(mockContext, mockLoaderConfig, mockCallbacks);

        xhrInstances[xhrInstances.length - 1]._simulateError(code);

        // Should trigger failback (new XHR created)
        expect(xhrInstances.length).to.be.greaterThan(index + 1);
      });
    });
  });

  describe('timeout behavior', function () {
    it('should trigger timeout after maxTimeToFirstByteMs', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Advance past timeout
      clock.tick(5001);

      // Should try failback
      expect(xhrInstances).to.have.lengthOf(2);
    });

    it('should trigger failback on timeout', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Advance past timeout
      clock.tick(5001);

      expect(xhrInstances[1]._url).to.include('failback1.test.com');
    });

    it('should call onTimeout when all failback attempts timeout', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // All attempts timeout
      clock.tick(5001); // Primary timeout
      clock.tick(5001); // Failback 1 timeout
      clock.tick(5001); // Failback 2 timeout

      expect(mockCallbacks.onTimeout.calledOnce).to.be.true;
    });

    it('should extend timeout after first byte received', function () {
      const config = {
        loadPolicy: {
          maxTimeToFirstByteMs: 1000,
          maxLoadTimeMs: 10000,
        },
      };

      loader.load(mockContext, config, mockCallbacks);

      // Simulate first byte received before initial timeout
      clock.tick(500);
      xhrInstances[0].readyState = 2;
      xhrInstances[0].onreadystatechange();

      // Now we should have extended timeout (maxLoadTimeMs)
      // Advancing past initial timeout should not trigger failback
      clock.tick(600);
      expect(xhrInstances).to.have.lengthOf(1);

      // Complete the request
      xhrInstances[0]._simulateSuccess(new ArrayBuffer(100));
      expect(mockCallbacks.onSuccess.calledOnce).to.be.true;
    });
  });

  describe('abort', function () {
    it('should abort current request', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      loader.abort();

      expect(loader.stats.aborted).to.be.true;
    });

    it('should call onAbort callback', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      loader.abort();

      expect(mockCallbacks.onAbort.calledOnce).to.be.true;
    });

    it('should not process responses after abort', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      loader.abort();

      // Try to simulate success after abort
      xhrInstances[0]._simulateSuccess(new ArrayBuffer(100));

      expect(mockCallbacks.onSuccess.called).to.be.false;
    });
  });

  describe('destroy', function () {
    it('should clean up resources', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      loader.destroy();

      expect(loader.context).to.be.null;
    });

    it('should abort pending request', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      loader.destroy();

      expect(loader.stats.aborted).to.be.true;
    });
  });

  describe('custom transform function', function () {
    it('should use custom transformUrl function', function () {
      mockConfig.failbackConfig.transformUrl = (url, attempt) => {
        return `https://custom-cdn${attempt}.example.com/path`;
      };
      loader = new FailbackLoader(mockConfig);

      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Primary fails
      xhrInstances[0]._simulateError(500);

      expect(xhrInstances[1]._url).to.equal(
        'https://custom-cdn0.example.com/path',
      );
    });

    it('should stop failback when transformUrl returns null', function () {
      mockConfig.failbackConfig.transformUrl = (url, attempt) => {
        if (attempt >= 1) return null;
        return `https://only-one-failback.example.com/path`;
      };
      loader = new FailbackLoader(mockConfig);

      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Primary fails
      xhrInstances[0]._simulateError(500);
      // First failback fails
      xhrInstances[1]._simulateError(500);

      // Should call onError since no more failbacks
      expect(mockCallbacks.onError.calledOnce).to.be.true;
    });
  });

  describe('getResponseHeader', function () {
    it('should return response header', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0]._headers['Content-Type'] = 'video/mp2t';
      xhrInstances[0]._simulateSuccess(new ArrayBuffer(100));

      expect(loader.getResponseHeader('Content-Type')).to.equal('video/mp2t');
    });

    it('should return null for non-existent header', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);
      xhrInstances[0]._simulateSuccess(new ArrayBuffer(100));

      expect(loader.getResponseHeader('X-Non-Existent')).to.be.null;
    });

    it('should return null when no loader exists', function () {
      expect(loader.getResponseHeader('Content-Type')).to.be.null;
    });
  });

  describe('getCacheAge', function () {
    it('should return null', function () {
      expect(loader.getCacheAge()).to.be.null;
    });
  });

  describe('URL parsing', function () {
    it('should preserve path when changing host', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0]._simulateError(500);

      const failbackUrl = new URL(xhrInstances[1]._url);
      expect(failbackUrl.pathname).to.equal('/video/segment.ts');
    });

    it('should preserve protocol when changing host', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0]._simulateError(500);

      const failbackUrl = new URL(xhrInstances[1]._url);
      expect(failbackUrl.protocol).to.equal('https:');
    });

    it('should preserve query parameters when changing host', function () {
      const contextWithQuery = {
        ...mockContext,
        url: 'https://primary.test.com/video/segment.ts?token=abc123',
      };

      loader.load(contextWithQuery, mockLoaderConfig, mockCallbacks);
      xhrInstances[0]._simulateError(500);

      const failbackUrl = new URL(xhrInstances[1]._url);
      expect(failbackUrl.searchParams.get('token')).to.equal('abc123');
    });

    it('should handle invalid URLs gracefully', function () {
      const contextWithInvalidUrl = {
        ...mockContext,
        url: 'not-a-valid-url',
      };

      loader.load(contextWithInvalidUrl, mockLoaderConfig, mockCallbacks);
      xhrInstances[0]._simulateError(500);

      // Should call onError since URL parsing failed
      expect(mockCallbacks.onError.calledOnce).to.be.true;
    });
  });

  describe('preloadFailbackHosts', function () {
    it('should preload hosts from DNS', async function () {
      const hosts = await preloadFailbackHosts();

      expect(hosts).to.be.an('array');
      expect(hosts.length).to.be.greaterThan(0);
    });

    it('should cache preloaded hosts', async function () {
      const hosts1 = await preloadFailbackHosts();
      const hosts2 = await preloadFailbackHosts();

      expect(hosts1).to.equal(hosts2); // Same reference due to caching
    });
  });

  describe('edge cases', function () {
    it('should handle empty response data', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0].readyState = 4;
      xhrInstances[0].status = 200;
      xhrInstances[0].response = null;
      xhrInstances[0].onreadystatechange();

      // Should trigger failback since response is null
      expect(xhrInstances).to.have.lengthOf(2);
    });

    it('should handle rapid successive loads with new loader instances', function () {
      const loader1 = new FailbackLoader(mockConfig);
      const loader2 = new FailbackLoader(mockConfig);

      loader1.load(mockContext, mockLoaderConfig, mockCallbacks);
      loader2.load(mockContext, mockLoaderConfig, mockCallbacks);

      expect(xhrInstances).to.have.lengthOf(2);

      // Both should work independently
      xhrInstances[0]._simulateSuccess(new ArrayBuffer(100));
      xhrInstances[1]._simulateSuccess(new ArrayBuffer(200));

      expect(mockCallbacks.onSuccess.calledTwice).to.be.true;

      loader1.destroy();
      loader2.destroy();
    });

    it('should handle missing loaderConfig', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      // Destroy and check it doesn't crash on state change
      loader.destroy();

      // Manually trigger state change after destroy
      if (xhrInstances[0].onreadystatechange) {
        xhrInstances[0].onreadystatechange();
      }

      // Should not crash - just return silently
    });

    it('should handle status 0 (network error) as failure', function () {
      loader.load(mockContext, mockLoaderConfig, mockCallbacks);

      xhrInstances[0]._simulateError(0, '');

      // Should trigger failback
      expect(xhrInstances).to.have.lengthOf(2);
    });
  });
});
