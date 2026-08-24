import { expect } from 'chai';
import sinon from 'sinon';
import { hlsDefaultConfig, mergeConfig } from '../../../src/config';
import { probeOriginalCDN } from '../../../src/utils/failback-recovery-probe';
import { logger } from '../../../src/utils/logger';
import type { HlsConfig } from '../../../src/config';

class ProbeMockXMLHttpRequest {
  public static instances: ProbeMockXMLHttpRequest[] = [];
  public static onSend: ((xhr: ProbeMockXMLHttpRequest) => void) | null = null;

  public readyState: number = 0;
  public status: number = 0;
  public response: ArrayBuffer | null = null;
  public responseType: XMLHttpRequestResponseType = '';
  public responseURL: string = '';
  public onreadystatechange: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public aborted: boolean = false;
  public url: string = '';
  public requestHeaders: Map<string, string> = new Map();

  constructor() {
    ProbeMockXMLHttpRequest.instances.push(this);
  }

  open(_method: string, url: string) {
    this.url = url;
    this.responseURL = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders.set(name.toLowerCase(), value);
  }

  send() {
    ProbeMockXMLHttpRequest.onSend?.(this);
  }

  abort() {
    this.aborted = true;
    this.readyState = 4;
  }

  static reset() {
    ProbeMockXMLHttpRequest.instances = [];
    ProbeMockXMLHttpRequest.onSend = null;
  }
}

function createConfig(): HlsConfig {
  return mergeConfig(hlsDefaultConfig, {}, logger);
}

describe('failback-recovery-probe', function () {
  let originalFetch: typeof fetch | undefined;
  let originalXHR: typeof XMLHttpRequest | undefined;
  let clock: sinon.SinonFakeTimers;

  beforeEach(function () {
    originalFetch = self.fetch;
    originalXHR = self.XMLHttpRequest;
    clock = sinon.useFakeTimers();
    ProbeMockXMLHttpRequest.reset();
  });

  afterEach(function () {
    self.fetch = originalFetch as typeof fetch;
    self.XMLHttpRequest = originalXHR as typeof XMLHttpRequest;
    clock.restore();
  });

  it('should validate the full fetch probe range and preserve non-Range headers', async function () {
    const fetchResponse = {
      status: 206,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(16 * 1024)),
    };
    const config = createConfig();
    const fetchStub = sinon.stub().resolves(fetchResponse as Response);
    self.fetch = fetchStub as unknown as typeof fetch;

    const result = await probeOriginalCDN(
      config,
      'https://origin.example.com/segment.ts',
      3000,
      {
        Authorization: 'Bearer token',
        range: 'bytes=0-0',
      },
    );

    expect(result).to.equal(true);
    expect(fetchStub.callCount).to.equal(1);

    const options = fetchStub.firstCall.args[1];
    expect(options.method).to.equal('GET');
    expect(options.headers.Range).to.equal('bytes=0-16383');
    expect(options.headers.range).to.equal(undefined);
    expect(options.headers.Authorization).to.equal('Bearer token');
  });

  it('should not recover when fetch resolves at headers but body stalls', async function () {
    const config = createConfig();
    const fetchResponse = {
      status: 206,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
    };
    self.fetch = sinon
      .stub()
      .resolves(
        fetchResponse as unknown as Response,
      ) as unknown as typeof fetch;

    const resultPromise = probeOriginalCDN(
      config,
      'https://origin.example.com/segment.ts',
      3000,
    );

    await Promise.resolve();
    await Promise.resolve();
    clock.tick(3000);

    expect(await resultPromise).to.equal(false);
  });

  it('should reject an exposed Content-Range for other bytes', async function () {
    const config = createConfig();
    const fetchResponse = {
      status: 206,
      headers: {
        get: () => 'bytes 0-16383/1048576',
      },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(16 * 1024)),
    };
    self.fetch = sinon
      .stub()
      .resolves(
        fetchResponse as unknown as Response,
      ) as unknown as typeof fetch;

    expect(
      await probeOriginalCDN(
        config,
        'https://origin.example.com/segment.ts',
        3000,
        undefined,
        16384,
        32768,
      ),
    ).to.equal(false);
  });

  it('should return false when fetch probe rejects', async function () {
    const config = createConfig();
    self.fetch = sinon
      .stub()
      .rejects(new Error('network')) as unknown as typeof fetch;

    const result = await probeOriginalCDN(
      config,
      'https://origin.example.com/segment.ts',
      3000,
    );

    expect(result).to.equal(false);
  });

  it('should retry xhrSetup after open() and send the probe request', async function () {
    self.XMLHttpRequest =
      ProbeMockXMLHttpRequest as unknown as typeof XMLHttpRequest;

    const xhrSetup = sinon.stub();
    xhrSetup.onFirstCall().throws(new Error('open first'));
    xhrSetup.onSecondCall().returns(undefined);
    const config = createConfig();
    config.xhrSetup = xhrSetup;

    ProbeMockXMLHttpRequest.onSend = (xhr) => {
      xhr.status = 206;
      xhr.response = new ArrayBuffer(16 * 1024);
      xhr.readyState = 4;
      xhr.onreadystatechange?.();
    };

    const resultPromise = probeOriginalCDN(
      config,
      'https://origin.example.com/segment.ts',
      3000,
      {
        'X-Test': '1',
      },
    );

    await Promise.resolve();
    const result = await resultPromise;

    expect(result).to.equal(true);
    expect(xhrSetup.callCount).to.equal(2);

    const xhr = ProbeMockXMLHttpRequest.instances[0];
    expect(xhr.url).to.equal('https://origin.example.com/segment.ts');
    expect(xhr.requestHeaders.get('range')).to.equal('bytes=0-16383');
    expect(xhr.requestHeaders.get('x-test')).to.equal('1');
    expect(xhr.responseType).to.equal('arraybuffer');
    expect(xhrSetup.getCall(0).thisValue).to.have.property('config', config);
  });

  it('should reject an XHR probe with a truncated body', async function () {
    self.XMLHttpRequest =
      ProbeMockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const config = createConfig();
    config.xhrSetup = () => undefined;

    ProbeMockXMLHttpRequest.onSend = (xhr) => {
      xhr.status = 206;
      xhr.response = new ArrayBuffer(1360);
      xhr.readyState = 4;
      xhr.onreadystatechange?.();
    };

    expect(
      await probeOriginalCDN(
        config,
        'https://origin.example.com/segment.ts',
        3000,
      ),
    ).to.equal(false);
  });

  it('should return false on xhr probe timeout and abort the request', async function () {
    self.XMLHttpRequest =
      ProbeMockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const config = createConfig();
    config.xhrSetup = () => undefined;

    ProbeMockXMLHttpRequest.onSend = () => {
      // Intentionally never resolve to trigger the timeout path.
    };

    const resultPromise = probeOriginalCDN(
      config,
      'https://origin.example.com/segment.ts',
      3000,
    );

    clock.tick(3000);
    const result = await resultPromise;

    expect(result).to.equal(false);
    expect(ProbeMockXMLHttpRequest.instances[0].aborted).to.equal(true);
  });
});
