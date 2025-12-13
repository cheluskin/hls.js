import chai from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { hlsDefaultConfig, mergeConfig } from '../../../src/config';
import FailbackLoader, {
  destroyFailbackState,
  getFailbackState,
} from '../../../src/utils/failback-loader';
import { logger } from '../../../src/utils/logger';
import type { HlsConfig } from '../../../src/config';
import type {
  FragmentLoaderContext,
  LoaderCallbacks,
  LoaderConfiguration,
} from '../../../src/types/loader';

chai.use(sinonChai);
const expect = chai.expect;

/**
 * Mock XMLHttpRequest that simulates browser behavior
 */
class MockXMLHttpRequest {
  public readyState: number = 0;
  public status: number = 0;
  public statusText: string = '';
  public response: ArrayBuffer | null = null;
  public responseType: string = '';
  public responseURL: string = '';

  private _headers: Map<string, string> = new Map();
  private _responseHeaders: Map<string, string> = new Map();
  private _url: string = '';
  private _aborted: boolean = false;

  public onreadystatechange: (() => void) | null = null;
  public onprogress: ((event: ProgressEvent) => void) | null = null;
  public onerror: (() => void) | null = null;

  // Test control
  public static instances: MockXMLHttpRequest[] = [];
  public static onRequest: ((xhr: MockXMLHttpRequest) => void) | null = null;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string, async?: boolean) {
    this._url = url;
    this.responseURL = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string) {
    this._headers.set(name.toLowerCase(), value);
  }

  getResponseHeader(name: string): string | null {
    return this._responseHeaders.get(name.toLowerCase()) || null;
  }

  send() {
    if (MockXMLHttpRequest.onRequest) {
      MockXMLHttpRequest.onRequest(this);
    }
  }

  abort() {
    this._aborted = true;
    this.readyState = 4;
  }

  // Test helpers
  get url(): string {
    return this._url;
  }

  get requestHeaders(): Map<string, string> {
    return this._headers;
  }

  simulateResponse(
    status: number,
    data: ArrayBuffer | null,
    responseHeaders: Record<string, string> = {},
  ) {
    if (this._aborted) return;

    this.status = status;
    this.statusText =
      status === 200 ? 'OK' : status === 206 ? 'Partial Content' : 'Error';
    this.response = data;

    this._responseHeaders.clear();
    Object.keys(responseHeaders).forEach((key) => {
      this._responseHeaders.set(key.toLowerCase(), responseHeaders[key]);
    });

    // Simulate readyState progression
    this.readyState = 2;
    this.onreadystatechange?.();

    this.readyState = 3;
    if (data && this.onprogress) {
      this.onprogress(
        new ProgressEvent('progress', {
          loaded: data.byteLength,
          total: data.byteLength,
        }),
      );
    }
    this.onreadystatechange?.();

    this.readyState = 4;
    this.onreadystatechange?.();
  }

  simulateNetworkError() {
    if (this._aborted) return;
    this.onerror?.();
  }

  static reset() {
    MockXMLHttpRequest.instances = [];
    MockXMLHttpRequest.onRequest = null;
  }
}

describe('FailbackLoader tests', function () {
  let config: HlsConfig;
  let originalXHR: typeof XMLHttpRequest;
  let clock: sinon.SinonFakeTimers;

  beforeEach(function () {
    // Save original XMLHttpRequest and replace with mock
    originalXHR = (globalThis as any).XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = MockXMLHttpRequest;

    MockXMLHttpRequest.reset();

    // Use fake timers
    clock = sinon.useFakeTimers();

    // Create config with failback settings
    config = mergeConfig(hlsDefaultConfig, {}, logger);
    // Add failbackConfig (not part of official HlsConfig type)
    (config as any).failbackConfig = {
      staticHosts: ['failback.example.com'],
    };
  });

  afterEach(function () {
    // Restore original XMLHttpRequest
    (globalThis as any).XMLHttpRequest = originalXHR;
    clock.restore();
    destroyFailbackState(config);
  });

  describe('206 Partial Content Detection', function () {
    it('should detect browser-initiated Range request and failback', function (done) {
      const loader = new FailbackLoader(config);
      const context: FragmentLoaderContext = {
        url: 'https://cdn.example.com/video/segment.ts',
        frag: null as any,
        part: null,
        responseType: 'arraybuffer',
        headers: {},
        rangeStart: 0,
        rangeEnd: 0,
      };
      const loaderConfig = {
        loadPolicy: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 60000,
        },
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: 0,
      } as unknown as LoaderConfiguration;

      const onSuccess = sinon.spy();
      const onError = sinon.spy();
      const onFailback = sinon.spy();

      // Configure failback callback
      (config as any).failbackConfig.onFailback = onFailback;

      const callbacks: LoaderCallbacks<FragmentLoaderContext> = {
        onSuccess: (response, stats, ctx, xhr) => {
          onSuccess(response);

          // Verify success came from failback host
          expect(response.url).to.include('failback.example.com');
          expect((response.data as ArrayBuffer).byteLength).to.equal(1000);

          // Verify failback was called
          expect(onFailback).to.have.been.calledOnce;
          expect(onFailback.firstCall.args[0]).to.include('cdn.example.com');
          expect(onFailback.firstCall.args[1]).to.include(
            'failback.example.com',
          );

          // Verify failure was counted
          const state = getFailbackState(config);
          expect(state.consecutiveFailures).to.equal(1);

          loader.destroy();
          done();
        },
        onError: (error) => {
          onError(error);
          done(new Error('Should not have called onError'));
        },
        onTimeout: () => {
          done(new Error('Should not have timed out'));
        },
        onAbort: () => {},
        onProgress: () => {},
      };

      // Set up request handler
      let requestCount = 0;
      MockXMLHttpRequest.onRequest = (xhr) => {
        requestCount++;

        if (requestCount === 1) {
          // First request to original CDN
          // Simulate browser adding Range header from cached partial data
          expect(xhr.url).to.include('cdn.example.com');

          // Simulate 206 response with partial data (like in the log)
          // Browser cached 15592 bytes, server returns just 1 byte for range 15592-15592
          self.setTimeout(() => {
            xhr.simulateResponse(
              206,
              new ArrayBuffer(1), // Only 1 byte!
              {
                'Content-Range': 'bytes 15592-15592/2624292',
                'Content-Length': '1',
              },
            );
          }, 10);
        } else if (requestCount === 2) {
          // Second request should go to failback host
          expect(xhr.url).to.include('failback.example.com');

          // Simulate successful response from failback
          self.setTimeout(() => {
            xhr.simulateResponse(200, new ArrayBuffer(1000), {
              'Content-Length': '1000',
            });
          }, 10);
        }
      };

      // Start loading
      loader.load(context, loaderConfig, callbacks);

      // Advance timers to let requests complete
      clock.tick(100);
    });

    it('should NOT trigger failback for legitimate 206 (we requested range)', function (done) {
      const loader = new FailbackLoader(config);
      const context: FragmentLoaderContext = {
        url: 'https://cdn.example.com/video/segment.ts',
        frag: null as any,
        part: null,
        responseType: 'arraybuffer',
        headers: {},
        rangeStart: 0,
        rangeEnd: 1000, // WE are requesting a range
      };
      const loaderConfig = {
        loadPolicy: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 60000,
        },
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: 0,
      } as unknown as LoaderConfiguration;

      const onSuccess = sinon.spy();
      const onFailback = sinon.spy();

      (config as any).failbackConfig.onFailback = onFailback;

      const callbacks: LoaderCallbacks<FragmentLoaderContext> = {
        onSuccess: (response) => {
          onSuccess(response);

          // Should succeed from original CDN (not failback)
          expect(response.url).to.include('cdn.example.com');
          expect(onFailback).to.not.have.been.called;

          loader.destroy();
          done();
        },
        onError: () => {
          done(new Error('Should not have called onError'));
        },
        onTimeout: () => {
          done(new Error('Should not have timed out'));
        },
        onAbort: () => {},
        onProgress: () => {},
      };

      MockXMLHttpRequest.onRequest = (xhr) => {
        // Return 206 - but this is legitimate because we requested a range
        self.setTimeout(() => {
          xhr.simulateResponse(206, new ArrayBuffer(1000), {
            'Content-Range': 'bytes 0-999/2624292',
            'Content-Length': '1000',
          });
        }, 10);
      };

      loader.load(context, loaderConfig, callbacks);
      clock.tick(100);
    });

    it('should enter permanent failback mode after threshold failures', function (done) {
      const loader1 = new FailbackLoader(config);
      const context: FragmentLoaderContext = {
        url: 'https://cdn.example.com/video/segment1.ts',
        frag: null as any,
        part: null,
        responseType: 'arraybuffer',
        headers: {},
        rangeStart: 0,
        rangeEnd: 0,
      };
      const loaderConfig = {
        loadPolicy: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 60000,
        },
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: 0,
      } as unknown as LoaderConfiguration;

      let requestCount = 0;
      let phase = 1;

      MockXMLHttpRequest.onRequest = (xhr) => {
        requestCount++;

        if (phase === 1) {
          // First segment - first failure
          if (requestCount === 1) {
            // 206 on original
            self.setTimeout(() => {
              xhr.simulateResponse(206, new ArrayBuffer(1), {
                'Content-Range': 'bytes 100-100/1000000',
              });
            }, 10);
          } else if (requestCount === 2) {
            // Failback succeeds
            self.setTimeout(() => {
              xhr.simulateResponse(200, new ArrayBuffer(1000), {});
            }, 10);
          }
        } else if (phase === 2) {
          // Second segment - second failure, should trigger permanent mode
          if (requestCount === 3) {
            // 206 on original again
            self.setTimeout(() => {
              xhr.simulateResponse(206, new ArrayBuffer(1), {
                'Content-Range': 'bytes 200-200/1000000',
              });
            }, 10);
          } else if (requestCount === 4) {
            // Failback succeeds
            self.setTimeout(() => {
              xhr.simulateResponse(200, new ArrayBuffer(1000), {});
            }, 10);
          }
        } else if (phase === 3) {
          // Third segment - should go directly to failback (permanent mode)
          if (requestCount === 5) {
            // Should be failback host, not original!
            expect(xhr.url).to.include('failback.example.com');
            self.setTimeout(() => {
              xhr.simulateResponse(200, new ArrayBuffer(1000), {});
            }, 10);
          }
        }
      };

      const callbacks1: LoaderCallbacks<FragmentLoaderContext> = {
        onSuccess: () => {
          // First segment done
          const state1 = getFailbackState(config);
          expect(state1.consecutiveFailures).to.equal(1);
          expect(state1.permanentMode).to.be.false;

          loader1.destroy();
          phase = 2;

          // Load second segment with new loader
          const loader2 = new FailbackLoader(config);
          const context2 = {
            ...context,
            url: 'https://cdn.example.com/video/segment2.ts',
          };

          const callbacks2: LoaderCallbacks<FragmentLoaderContext> = {
            onSuccess: () => {
              // Second segment done - should be in permanent mode now
              const state2 = getFailbackState(config);
              expect(state2.consecutiveFailures).to.equal(2);
              expect(state2.permanentMode).to.be.true;

              loader2.destroy();
              phase = 3;

              // Load third segment - should skip original entirely
              const loader3 = new FailbackLoader(config);
              const context3 = {
                ...context,
                url: 'https://cdn.example.com/video/segment3.ts',
              };

              const callbacks3: LoaderCallbacks<FragmentLoaderContext> = {
                onSuccess: () => {
                  // Third segment done
                  // requestCount should be 5, meaning we skipped original
                  expect(requestCount).to.equal(5);

                  loader3.destroy();
                  done();
                },
                onError: () => done(new Error('Segment 3 error')),
                onTimeout: () => done(new Error('Segment 3 timeout')),
                onAbort: () => {},
                onProgress: () => {},
              };

              loader3.load(context3, loaderConfig, callbacks3);
              clock.tick(100);
            },
            onError: () => done(new Error('Segment 2 error')),
            onTimeout: () => done(new Error('Segment 2 timeout')),
            onAbort: () => {},
            onProgress: () => {},
          };

          loader2.load(context2, loaderConfig, callbacks2);
          clock.tick(100);
        },
        onError: () => done(new Error('Segment 1 error')),
        onTimeout: () => done(new Error('Segment 1 timeout')),
        onAbort: () => {},
        onProgress: () => {},
      };

      loader1.load(context, loaderConfig, callbacks1);
      clock.tick(100);
    });
  });

  describe('Stall Detection', function () {
    it('should detect stall and failback when no progress', function (done) {
      const loader = new FailbackLoader(config);
      const context: FragmentLoaderContext = {
        url: 'https://cdn.example.com/video/segment.ts',
        frag: null as any,
        part: null,
        responseType: 'arraybuffer',
        headers: {},
        rangeStart: 0,
        rangeEnd: 0,
      };
      const loaderConfig = {
        loadPolicy: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 60000,
        },
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: 0,
      } as unknown as LoaderConfiguration;

      let requestCount = 0;

      MockXMLHttpRequest.onRequest = (xhr) => {
        requestCount++;

        if (requestCount === 1) {
          // First request - receive some headers but then stall
          self.setTimeout(() => {
            // Simulate receiving headers (TTFB)
            xhr.readyState = 2;
            xhr.status = 200;
            xhr.onreadystatechange?.();

            // Send some progress
            xhr.onprogress?.(
              new ProgressEvent('progress', { loaded: 1000, total: 1000000 }),
            );

            // Then... nothing. Stall will be detected after 5 seconds
          }, 10);
        } else if (requestCount === 2) {
          // Second request to failback host
          expect(xhr.url).to.include('failback.example.com');
          self.setTimeout(() => {
            xhr.simulateResponse(200, new ArrayBuffer(1000), {});
          }, 10);
        }
      };

      const callbacks: LoaderCallbacks<FragmentLoaderContext> = {
        onSuccess: () => {
          expect(requestCount).to.equal(2);
          loader.destroy();
          done();
        },
        onError: () => done(new Error('Should not error')),
        onTimeout: () => {},
        onAbort: () => {},
        onProgress: () => {},
      };

      loader.load(context, loaderConfig, callbacks);

      // Advance past initial request
      clock.tick(100);

      // Advance past stall timeout (5 seconds)
      clock.tick(6000);

      // Advance to let failback complete
      clock.tick(100);
    });
  });
});
