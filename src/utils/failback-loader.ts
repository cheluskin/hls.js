import { fetchFailbackHosts } from './dns-txt-resolver';
import { logger } from './logger';
import { LoadStats } from '../loader/load-stats';
import type { HlsConfig } from '../config';
import type {
  FragmentLoaderContext,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderStats,
} from '../types/loader';

// ============================================
// FAILBACK КОНФИГУРАЦИЯ
// Значения подставляются при сборке через env vars:
// FAILBACK_DNS_DOMAIN и FAILBACK_HOSTS
// ============================================
declare const __FAILBACK_DNS_DOMAIN__: string;
declare const __FAILBACK_HOSTS__: string[];

const DEFAULT_DNS_DOMAIN = __FAILBACK_DNS_DOMAIN__;
const FALLBACK_HOSTS = __FAILBACK_HOSTS__;
// ============================================

// Global cache for DNS-resolved hosts (Shared across all instances, this is safe/desired)
let dnsHostsPromise: Promise<string[]> | null = null;
let dnsHostsCache: string[] | null = null;

// ============================================
// FAILBACK STATE ISOLATION
// State is stored per HlsConfig instance to support multiple players on one page
// ============================================

interface FailbackSessionState {
  consecutiveOriginalFailures: number;
  permanentFailbackMode: boolean;
  threshold: number;
  fragmentsSinceLastProbe: number;
  lastSuccessfulOriginalUrl: string | null;
  isProbeInProgress: boolean;
}

const failbackStates = new WeakMap<HlsConfig, FailbackSessionState>();

// Number of consecutive failures on original CDN before switching to permanent failback.
// We use 2 to avoid expensive failback traffic for temporary issues.
// The 206 detection handles browser Range requests from cached partial data.
const PERMANENT_FAILBACK_THRESHOLD = 2;
const PROBE_EVERY_N_FRAGMENTS = 6;
const PROBE_TIMEOUT_MS = 3000;
const STALL_TIMEOUT_MS = 5000;
const STALL_CHECK_INTERVAL_MS = 1000;
const MIN_SPEED_BYTES_PER_SEC = 4096;

/**
 * Get or initialize state for a specific config instance
 */
function getSessionState(config: HlsConfig): FailbackSessionState {
  let state = failbackStates.get(config);
  if (!state) {
    state = {
      consecutiveOriginalFailures: 0,
      permanentFailbackMode: false,
      threshold: PERMANENT_FAILBACK_THRESHOLD,
      fragmentsSinceLastProbe: 0,
      lastSuccessfulOriginalUrl: null,
      isProbeInProgress: false,
    };
    failbackStates.set(config, state);
  }
  return state;
}

/**
 * Get current failback state (for monitoring/debugging)
 * Requires the HlsConfig instance to identify the player
 */
export function getFailbackState(config: HlsConfig): {
  consecutiveFailures: number;
  permanentMode: boolean;
  threshold: number;
} {
  const state = getSessionState(config);
  return {
    consecutiveFailures: state.consecutiveOriginalFailures,
    permanentMode: state.permanentFailbackMode,
    threshold: state.threshold,
  };
}

/**
 * Get extended failback state including CDN recovery info (for debugging)
 */
export function getExtendedFailbackState(config: HlsConfig): {
  consecutiveFailures: number;
  permanentMode: boolean;
  threshold: number;
  fragmentsSinceLastProbe: number;
  probeEveryNFragments: number;
  lastSuccessfulOriginalUrl: string | null;
  isProbeInProgress: boolean;
} {
  const state = getSessionState(config);
  return {
    consecutiveFailures: state.consecutiveOriginalFailures,
    permanentMode: state.permanentFailbackMode,
    threshold: state.threshold,
    fragmentsSinceLastProbe: state.fragmentsSinceLastProbe,
    probeEveryNFragments: PROBE_EVERY_N_FRAGMENTS,
    lastSuccessfulOriginalUrl: state.lastSuccessfulOriginalUrl,
    isProbeInProgress: state.isProbeInProgress,
  };
}

/**
 * Reset failback state (for debugging or when you want to retry original source)
 */
export function resetFailbackState(config: HlsConfig): void {
  const state = getSessionState(config);
  const wasInPermanentMode = state.permanentFailbackMode;

  state.permanentFailbackMode = false;
  state.fragmentsSinceLastProbe = 0;

  if (wasInPermanentMode) {
    state.consecutiveOriginalFailures = PERMANENT_FAILBACK_THRESHOLD - 1;
    logger.log(
      `[FailbackLoader] State reset - will try original source (failures=${state.consecutiveOriginalFailures}, first fail returns to permanent)`,
    );
  } else {
    state.consecutiveOriginalFailures = 0;
  }
}

/**
 * Full reset of all failback state (for when HLS instance is destroyed)
 */
export function destroyFailbackState(config: HlsConfig): void {
  if (failbackStates.has(config)) {
    failbackStates.delete(config);
    logger.log('[FailbackLoader] State fully destroyed');
  }
}

/**
 * Probe original CDN with a Range request to check if it's back online
 * Supports headers (e.g. for Auth)
 */
function probeOriginalCDN(
  url: string,
  headers?: Record<string, string>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeoutId = self.setTimeout(() => {
      logger.log(`[FailbackLoader] Probe timeout after ${PROBE_TIMEOUT_MS}ms`);
      controller.abort();
    }, PROBE_TIMEOUT_MS);

    const mergedHeaders: Record<string, string> = {
      Range: 'bytes=0-1023',
      ...headers,
    };

    logger.log(`[FailbackLoader] Probe fetch starting: ${url}`);

    fetch(url, {
      method: 'GET',
      headers: mergedHeaders,
      signal: controller.signal,
    })
      .then((response) => {
        self.clearTimeout(timeoutId);
        const isSuccess = response.status === 200 || response.status === 206;
        logger.log(
          `[FailbackLoader] Probe response: status=${response.status}, success=${isSuccess}`,
        );
        resolve(isSuccess);
      })
      .catch((error) => {
        self.clearTimeout(timeoutId);
        logger.log(
          `[FailbackLoader] Probe fetch error: ${error?.message || error}`,
        );
        resolve(false);
      });
  });
}

/**
 * Try to recover to original CDN if conditions are met
 *
 * Note: We don't check buffer level because:
 * 1. Probe is async and doesn't block current loading
 * 2. If probe succeeds, CDN works - next fragments will load fine
 * 3. If CDN is unstable after switch, we return to permanent mode after 1 failure
 *    (because resetFailbackState sets consecutiveOriginalFailures = THRESHOLD - 1)
 */
function tryRecoverToOriginalCDN(
  config: HlsConfig,
  headers?: Record<string, string>,
): void {
  const state = getSessionState(config);

  // Prevent concurrent probes
  if (state.isProbeInProgress) {
    logger.log('[FailbackLoader] Recovery skipped - probe already in progress');
    return;
  }

  // Must be in permanent failback mode
  if (!state.permanentFailbackMode) {
    logger.log('[FailbackLoader] Recovery skipped - not in permanent mode');
    return;
  }

  // Need a URL to probe
  if (!state.lastSuccessfulOriginalUrl) {
    logger.log('[FailbackLoader] Recovery skipped - no original URL stored');
    return;
  }

  state.isProbeInProgress = true;
  logger.log(
    `[FailbackLoader] Probing original CDN: ${state.lastSuccessfulOriginalUrl}`,
  );

  const urlToProbe = state.lastSuccessfulOriginalUrl;

  probeOriginalCDN(urlToProbe, headers)
    .then((isAlive) => {
      // Re-check conditions after async probe - state may have changed
      if (!state.permanentFailbackMode) {
        logger.log(
          '[FailbackLoader] Recovery aborted - no longer in permanent mode',
        );
        return;
      }

      if (isAlive) {
        logger.log(
          '[FailbackLoader] ✓ Original CDN recovered - switching back (first fail will return to permanent)',
        );
        resetFailbackState(config);
      } else {
        logger.log('[FailbackLoader] ✗ Original CDN still unavailable');
      }
    })
    .catch(() => {
      logger.log('[FailbackLoader] ✗ Original CDN probe failed');
    })
    .finally(() => {
      state.isProbeInProgress = false;
    });
}

/**
 * Preload failback hosts from DNS
 * Call this early in app initialization for best performance
 */
export function preloadFailbackHosts(): Promise<string[]> {
  if (dnsHostsCache) {
    return Promise.resolve(dnsHostsCache);
  }

  if (!dnsHostsPromise) {
    dnsHostsPromise = fetchFailbackHosts(DEFAULT_DNS_DOMAIN).then((hosts) => {
      if (hosts.length > 0) {
        dnsHostsCache = hosts;
        logger.log(`[FailbackLoader] DNS hosts loaded: ${hosts.join(', ')}`);
      } else {
        dnsHostsCache = FALLBACK_HOSTS;
        logger.log(
          `[FailbackLoader] Using fallback hosts: ${FALLBACK_HOSTS.join(', ')}`,
        );
      }
      return dnsHostsCache;
    });
  }

  return dnsHostsPromise;
}

/**
 * Get current failback hosts (cached or fallback)
 */
function getFailbackHostsSync(): string[] {
  return dnsHostsCache || FALLBACK_HOSTS;
}

/**
 * Optional configuration for failback behavior
 */
export interface FailbackConfig {
  /** DNS domain for TXT record lookup (default: fb.turoktv.com) */
  dnsDomain?: string;
  /** Static failback hosts (overrides DNS lookup) */
  staticHosts?: string[];
  /** Custom transform function */
  transformUrl?: (url: string, attempt: number) => string | null;
  /** Callback when load succeeds */
  onSuccess?: (url: string, wasFailback: boolean, attempt: number) => void;
  /** Callback when failback is triggered */
  onFailback?: (
    originalUrl: string,
    failbackUrl: string,
    attempt: number,
  ) => void;
  /** Callback when all attempts failed */
  onAllFailed?: (originalUrl: string, attempts: number) => void;
  /**
   * Enable Cache-Control: no-store header.
   * This prevents browser from caching partial responses but triggers CORS preflight
   * (OPTIONS requests), which doubles the number of requests.
   * Default: false (rely on 206 detection instead)
   */
  enableCacheControlHeader?: boolean;
}

class FailbackLoader implements Loader<FragmentLoaderContext> {
  private config: HlsConfig;
  private failbackConfig: FailbackConfig;
  private loader: XMLHttpRequest | null = null;
  private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
  public context: FragmentLoaderContext | null = null;
  public stats: LoaderStats;
  private failbackAttempt: number = 0;
  private originalUrl: string = '';
  private requestTimeout?: number;
  private loaderConfig: LoaderConfiguration | null = null;

  // Stall detection
  private lastProgressTime: number = 0;
  private stallCheckInterval?: number;
  private currentUrl: string = '';

  // Throughput detection
  private lastTotalBytes: number = 0;
  private lowSpeedDuration: number = 0;

  constructor(config: HlsConfig) {
    this.config = config;
    this.stats = new LoadStats();

    const userConfig = (config as any).failbackConfig || {};

    this.failbackConfig = {
      dnsDomain: userConfig.dnsDomain,
      staticHosts: userConfig.staticHosts,
      transformUrl: userConfig.transformUrl,
      onSuccess: userConfig.onSuccess,
      onFailback: userConfig.onFailback,
      onAllFailed: userConfig.onAllFailed,
      enableCacheControlHeader: userConfig.enableCacheControlHeader,
    };

    // Ensure state exists for this config
    getSessionState(config);

    // Start DNS preload if not already started (fire and forget)
    preloadFailbackHosts().catch(() => {
      // Ignore errors - will use fallback hosts
    });
  }

  /**
   * Get failback hosts (static config or DNS-resolved)
   */
  private getHosts(): string[] {
    // Static hosts take precedence
    if (
      this.failbackConfig.staticHosts &&
      this.failbackConfig.staticHosts.length > 0
    ) {
      return this.failbackConfig.staticHosts;
    }
    // Use DNS-resolved hosts (or fallback)
    return getFailbackHostsSync();
  }

  destroy() {
    this.abortInternal();
    this.stopStallCheck();
    this.loader = null;
    this.callbacks = null;
    this.context = null;
    this.loaderConfig = null;
    // Note: We do NOT destroy state here automatically because other loaders
    // might still be active or the Hls instance might be reused.
    // Explicit clean up should be done via Hls.destroy() which calls destroyFailbackState
  }

  private stopStallCheck() {
    if (this.stallCheckInterval) {
      self.clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = undefined;
    }
  }

  private startStallCheck(url: string) {
    this.stopStallCheck();
    this.currentUrl = url;
    this.lastProgressTime = self.performance.now();
    this.lastTotalBytes = this.stats.loaded || 0;
    this.lowSpeedDuration = 0;

    this.stallCheckInterval = self.setInterval(() => {
      const now = self.performance.now();

      // 1. Strict Silence Check (original logic)
      // If we haven't received ANY event for STALL_TIMEOUT_MS
      const timeSinceProgress = now - this.lastProgressTime;
      if (timeSinceProgress > STALL_TIMEOUT_MS) {
        logger.log(
          `[FailbackLoader] Strict stall detected (no events for ${timeSinceProgress}ms)`,
        );
        this.onStall();
        return;
      }

      // 2. Minimum Throughput Check (trickle detection)
      // Check how many bytes we received since last interval check
      const currentLoaded = this.stats.loaded;
      const bytesDiff = currentLoaded - this.lastTotalBytes;

      // Calculate minimum bytes required per this interval (assuming 1s interval)
      // If interval changes, this math needs adjustment
      const minBytesRequired =
        MIN_SPEED_BYTES_PER_SEC * (STALL_CHECK_INTERVAL_MS / 1000);

      // Only check for stalls if we have started loading (loaded > 0)
      if (currentLoaded > 0 && bytesDiff < minBytesRequired) {
        this.lowSpeedDuration += STALL_CHECK_INTERVAL_MS;
        // logger.log(`[FailbackLoader] Low speed detected: ${bytesDiff} bytes in last interval. Duration: ${this.lowSpeedDuration}ms`);

        if (this.lowSpeedDuration >= STALL_TIMEOUT_MS) {
          logger.log(
            `[FailbackLoader] Throughput stall detected (speed < ${MIN_SPEED_BYTES_PER_SEC} B/s for ${this.lowSpeedDuration}ms)`,
          );
          this.onStall();
          return;
        }
      } else {
        // Speed is good, reset counter
        this.lowSpeedDuration = 0;
      }

      this.lastTotalBytes = currentLoaded;
    }, STALL_CHECK_INTERVAL_MS);
  }

  private onStall() {
    const currentUrl = this.currentUrl;
    this.stopStallCheck();
    const state = getSessionState(this.config);
    const elapsed = self.performance.now() - this.stats.loading.start;
    const loaded = this.stats.loaded || 0;
    const total = this.stats.total || 0;
    const percent = total > 0 ? ((loaded / total) * 100).toFixed(1) : '?';
    const speedKBps = elapsed > 0 ? loaded / 1024 / (elapsed / 1000) : 0;

    logger.log(
      `[FailbackLoader] STALL DETECTED:` +
        `\n  url: ${currentUrl}` +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  elapsed: ${elapsed.toFixed(0)}ms` +
        `\n  loaded: ${(loaded / 1024).toFixed(1)}KB / ${(total / 1024).toFixed(1)}KB (${percent}%)` +
        `\n  speed: ${speedKBps.toFixed(1)}KB/s (min required: ${(MIN_SPEED_BYTES_PER_SEC / 1024).toFixed(1)}KB/s)` +
        `\n  state: failures=${state.consecutiveOriginalFailures}, permanentMode=${state.permanentFailbackMode}`,
    );

    // Track failures on original source (not already in permanent mode)
    if (this.failbackAttempt === 0 && !state.permanentFailbackMode) {
      state.consecutiveOriginalFailures++;
      logger.log(
        `[FailbackLoader] Original source stalled - no progress for ${STALL_TIMEOUT_MS}ms (${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})`,
      );

      if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
        state.permanentFailbackMode = true;
        logger.log(
          `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable`,
        );
      }
    }

    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);

    if (failbackUrl && failbackUrl !== currentUrl) {
      this.failbackAttempt++;
      this.abortInternal();
      // Reset aborted flag so failback response is not ignored
      this.stats.aborted = false;

      this.failbackConfig.onFailback?.(
        this.originalUrl,
        failbackUrl,
        this.failbackAttempt,
      );

      logger.log(
        `[FailbackLoader] FAILBACK: trying host #${this.failbackAttempt}: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

    logger.log(
      `[FailbackLoader] ALL FAILED: no more failback hosts available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${this.failbackAttempt + 1}`,
    );

    this.failbackConfig.onAllFailed?.(
      this.originalUrl,
      this.failbackAttempt + 1,
    );

    this.abortInternal();
    this.callbacks?.onTimeout?.(
      this.stats,
      this.context as FragmentLoaderContext,
      this.loader,
    );
  }

  private abortInternal() {
    const loader = this.loader;
    self.clearTimeout(this.requestTimeout);
    this.stopStallCheck();
    if (loader) {
      loader.onreadystatechange = null;
      loader.onprogress = null;
      loader.onerror = null; // Clear error handler to prevent stale callbacks
      if (loader.readyState !== 4) {
        this.stats.aborted = true;
        loader.abort();
      }
    }
  }

  abort() {
    this.abortInternal();
    if (this.callbacks?.onAbort) {
      this.callbacks.onAbort(
        this.stats,
        this.context as FragmentLoaderContext,
        this.loader,
      );
    }
  }

  load(
    context: FragmentLoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<FragmentLoaderContext>,
  ) {
    if (this.stats.loading.start) {
      throw new Error('Loader can only be used once.');
    }
    this.stats = new LoadStats();
    this.stats.loading.start = self.performance.now();
    this.context = context;
    this.callbacks = callbacks;
    this.loaderConfig = config;
    this.failbackAttempt = 0;
    this.originalUrl = context.url;

    const state = getSessionState(this.config);
    const hosts = this.getHosts();

    // Log load start with full state
    logger.log(
      `[FailbackLoader] LOAD START: ${context.url}` +
        `\n  state: failures=${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD}, permanentMode=${state.permanentFailbackMode}` +
        `\n  hosts: [${hosts.join(', ')}]` +
        `\n  config: stallTimeout=${STALL_TIMEOUT_MS}ms, minSpeed=${MIN_SPEED_BYTES_PER_SEC}B/s, probeEvery=${PROBE_EVERY_N_FRAGMENTS}frags`,
    );

    // In permanent failback mode, skip original source entirely
    if (state.permanentFailbackMode) {
      const failbackUrl = this.getFailbackUrl(0);
      if (failbackUrl) {
        this.failbackAttempt = 1;
        logger.log(
          `[FailbackLoader] PERMANENT FAILBACK MODE - skipping original, using: ${failbackUrl}`,
        );
        this.loadUrl(failbackUrl);
        return;
      }
    }

    this.loadUrl(context.url);
  }

  /**
   * Extract host from URL and create failback URL
   * Uses hosts in order from DNS (respects GeoDNS ordering)
   */
  private getFailbackUrl(attempt: number): string | null {
    const { transformUrl } = this.failbackConfig;

    // Custom transform takes precedence
    if (transformUrl) {
      return transformUrl(this.originalUrl, attempt);
    }

    const hosts = this.getHosts();

    // Check if we have more failback hosts to try
    if (attempt >= hosts.length) {
      return null;
    }

    try {
      const url = new URL(this.originalUrl);
      const failbackHost = hosts[attempt];

      // Parse failback host (may include port like "cdn.example.com:8080")
      if (failbackHost.includes(':')) {
        const [hostname, port] = failbackHost.split(':');
        url.hostname = hostname;
        url.port = port;
      } else {
        url.hostname = failbackHost;
        url.port = ''; // Reset port to default for protocol
      }

      // Always use HTTPS for failback hosts (CDNs require it)
      url.protocol = 'https:';

      return url.toString();
    } catch {
      return null;
    }
  }

  private loadUrl(url: string) {
    const context = this.context;
    const config = this.loaderConfig;
    if (!context || !config) return;

    const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
    const timeout =
      maxTimeToFirstByteMs && Number.isFinite(maxTimeToFirstByteMs)
        ? maxTimeToFirstByteMs
        : maxLoadTimeMs;

    logger.log(
      `[FailbackLoader] LOADING: ${url}` +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  timeout: ${timeout}ms (ttfb=${maxTimeToFirstByteMs}ms, maxLoad=${maxLoadTimeMs}ms)`,
    );

    const xhr = (this.loader = new self.XMLHttpRequest());

    xhr.open('GET', url, true);
    xhr.responseType = context.responseType as XMLHttpRequestResponseType;

    const headers = context.headers;
    if (headers) {
      for (const header in headers) {
        xhr.setRequestHeader(header, headers[header]);
      }
    }

    // NOTE: We previously used Cache-Control: no-store to prevent browser from
    // caching partial responses and auto-adding Range headers on retry.
    // However, this header triggers CORS preflight (OPTIONS) requests which doubles
    // the number of requests (expensive on CDNs).
    //
    // Instead, we now detect HTTP 206 responses that we didn't request (browser-initiated
    // Range requests from stale cache) and treat them as errors, triggering failback.
    // See the 206 detection logic in onReadyStateChange().
    //
    // To re-enable Cache-Control header (e.g., for debugging), set:
    // failbackConfig.enableCacheControlHeader = true
    if (this.failbackConfig.enableCacheControlHeader) {
      xhr.setRequestHeader('Cache-Control', 'no-store');
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader(
        'Range',
        'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1),
      );
    }

    xhr.onreadystatechange = () => this.onReadyStateChange(xhr, url);
    xhr.onprogress = this.onProgress.bind(this);
    xhr.onerror = () => this.onNetworkError(xhr, url);

    self.clearTimeout(this.requestTimeout);
    this.requestTimeout = self.setTimeout(() => this.onTimeout(url), timeout);

    xhr.send();

    // Start stall detection (separate from timeout - detects when download stalls)
    this.startStallCheck(url);
  }

  private onReadyStateChange(xhr: XMLHttpRequest, currentUrl: string) {
    const { context, stats, loaderConfig: config } = this;
    if (!context || !config || this.loader !== xhr || stats.aborted) return;

    if (xhr.readyState >= 2) {
      if (stats.loading.first === 0) {
        stats.loading.first = Math.max(
          self.performance.now(),
          stats.loading.start,
        );
        const ttfb = stats.loading.first - stats.loading.start;
        const finalUrl = xhr.responseURL || currentUrl;
        const wasRedirected = finalUrl !== currentUrl;

        logger.log(
          `[FailbackLoader] RESPONSE HEADERS RECEIVED:` +
            `\n  status: ${xhr.status}` +
            `\n  ttfb: ${ttfb.toFixed(0)}ms` +
            `\n  requested: ${currentUrl}` +
            (wasRedirected ? `\n  redirected: ${finalUrl}` : ''),
        );

        if (config.loadPolicy.maxLoadTimeMs) {
          self.clearTimeout(this.requestTimeout);
          this.requestTimeout = self.setTimeout(
            () => this.onTimeout(currentUrl),
            config.loadPolicy.maxLoadTimeMs -
              (stats.loading.first - stats.loading.start),
          );
        }
      }

      if (xhr.readyState === 4) {
        self.clearTimeout(this.requestTimeout);
        this.stopStallCheck();
        xhr.onreadystatechange = null;
        xhr.onprogress = null;

        const status = xhr.status;

        if (status >= 200 && status < 300) {
          const data = xhr.response;
          if (data != null) {
            stats.loading.end = Math.max(
              self.performance.now(),
              stats.loading.first,
            );
            const len =
              xhr.responseType === 'arraybuffer'
                ? data.byteLength
                : data.length;

            // Detect browser-initiated Range requests (from cache)
            // If we got HTTP 206 but didn't request a range ourselves,
            // the browser auto-added Range header from stale cache
            const weRequestedRange = !!(context.rangeStart || context.rangeEnd);
            if (status === 206 && !weRequestedRange) {
              // Parse Content-Range header to check if we got partial data
              // Format: "bytes 15592-15592/2624292" or "bytes 0-1023/2624292"
              const contentRange = xhr.getResponseHeader('Content-Range');
              if (contentRange) {
                const match = contentRange.match(
                  /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i,
                );
                if (match) {
                  const rangeStart = parseInt(match[1], 10);
                  const rangeEnd = parseInt(match[2], 10);
                  const totalSize =
                    match[3] === '*' ? -1 : parseInt(match[3], 10);
                  const receivedBytes = rangeEnd - rangeStart + 1;

                  // If total size is known and we didn't get the full file, it's a cache issue
                  if (totalSize > 0 && receivedBytes < totalSize) {
                    logger.log(
                      `[FailbackLoader] CACHE RANGE ISSUE DETECTED:` +
                        `\n  url: ${currentUrl}` +
                        `\n  status: 206 Partial Content (browser-initiated)` +
                        `\n  Content-Range: ${contentRange}` +
                        `\n  received: ${receivedBytes} bytes, total: ${totalSize} bytes` +
                        `\n  ACTION: Treating as error, will try failback`,
                    );
                    // Treat this as an error - trigger failback
                    this.handleError(xhr, currentUrl, 206);
                    return;
                  }
                }
              }
            }

            stats.loaded = stats.total = len;
            stats.bwEstimate =
              (stats.total * 8000) / (stats.loading.end - stats.loading.first);

            this.callbacks?.onProgress?.(stats, context, data, xhr);

            // Call success callback if configured
            this.failbackConfig.onSuccess?.(
              xhr.responseURL,
              this.failbackAttempt > 0,
              this.failbackAttempt,
            );

            // Track consecutive failures for permanent failback mode
            const state = getSessionState(this.config);
            if (this.failbackAttempt === 0 && !state.permanentFailbackMode) {
              // Success on original source - reset failure counter
              if (state.consecutiveOriginalFailures > 0) {
                logger.log(
                  `[FailbackLoader] Original source recovered, resetting failure counter`,
                );
              }
              state.consecutiveOriginalFailures = 0;
            }

            // Store original URL for future recovery probes
            // Always store it - even if we loaded from failback, we want to probe original later
            if (
              !state.lastSuccessfulOriginalUrl ||
              this.failbackAttempt === 0
            ) {
              const wasNull = !state.lastSuccessfulOriginalUrl;
              state.lastSuccessfulOriginalUrl = this.originalUrl;
              if (wasNull) {
                logger.log(
                  `[FailbackLoader] Stored original URL for recovery probes: ${this.originalUrl}`,
                );
              }
            }

            // Calculate download stats for logging
            const downloadTime = stats.loading.end - stats.loading.start;
            const speedKBps = len / 1024 / (downloadTime / 1000);
            const speedMbps = (len * 8) / (downloadTime * 1000);

            // CDN Recovery: count fragments and probe when in permanent failback mode
            if (state.permanentFailbackMode) {
              state.fragmentsSinceLastProbe++;
              logger.log(
                `[FailbackLoader] SUCCESS (permanent failback):` +
                  `\n  url: ${xhr.responseURL}` +
                  `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms` +
                  `\n  speed: ${speedKBps.toFixed(1)}KB/s (${speedMbps.toFixed(2)}Mbps)` +
                  `\n  probe: [${state.fragmentsSinceLastProbe}/${PROBE_EVERY_N_FRAGMENTS}]`,
              );

              // Time to probe original CDN?
              if (state.fragmentsSinceLastProbe >= PROBE_EVERY_N_FRAGMENTS) {
                state.fragmentsSinceLastProbe = 0;
                logger.log(
                  `[FailbackLoader] Triggering CDN probe:` +
                    `\n  lastSuccessfulOriginalUrl: ${state.lastSuccessfulOriginalUrl}` +
                    `\n  isProbeInProgress: ${state.isProbeInProgress}` +
                    `\n  permanentFailbackMode: ${state.permanentFailbackMode}`,
                );
                // Fire and forget - don't block the current request
                // Pass headers for authenticated probe (if any)
                tryRecoverToOriginalCDN(this.config, context.headers);
              }
            } else if (this.failbackAttempt > 0) {
              logger.log(
                `[FailbackLoader] SUCCESS via failback #${this.failbackAttempt}:` +
                  `\n  url: ${xhr.responseURL}` +
                  `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms` +
                  `\n  speed: ${speedKBps.toFixed(1)}KB/s (${speedMbps.toFixed(2)}Mbps)`,
              );
            } else {
              logger.log(
                `[FailbackLoader] SUCCESS (direct):` +
                  `\n  url: ${xhr.responseURL}` +
                  `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms` +
                  `\n  speed: ${speedKBps.toFixed(1)}KB/s (${speedMbps.toFixed(2)}Mbps)`,
              );
            }

            this.callbacks?.onSuccess?.(
              { url: xhr.responseURL, data, code: status },
              stats,
              context,
              xhr,
            );
            return;
          }
        }

        this.handleError(xhr, currentUrl, status);
      }
    }
  }

  private handleError(xhr: XMLHttpRequest, currentUrl: string, status: number) {
    this.stopStallCheck(); // Ensure stall check is stopped
    const state = getSessionState(this.config);
    const finalUrl = xhr.responseURL || currentUrl;
    const wasRedirected = finalUrl !== currentUrl;
    const elapsed = self.performance.now() - this.stats.loading.start;

    logger.log(
      `[FailbackLoader] HTTP ERROR:` +
        `\n  status: ${status} ${xhr.statusText}` +
        `\n  url: ${currentUrl}` +
        (wasRedirected ? `\n  redirected: ${finalUrl}` : '') +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  elapsed: ${elapsed.toFixed(0)}ms` +
        `\n  loaded: ${this.stats.loaded} bytes`,
    );

    // Track failures on original source (not already in permanent mode)
    if (this.failbackAttempt === 0 && !state.permanentFailbackMode) {
      state.consecutiveOriginalFailures++;
      logger.log(
        `[FailbackLoader] Original source failed (${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})`,
      );

      // Check if we should switch to permanent failback mode
      if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
        state.permanentFailbackMode = true;
        logger.log(
          `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable`,
        );
      }
    }

    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);

    if (failbackUrl && failbackUrl !== currentUrl) {
      this.failbackAttempt++;
      // Reset aborted flag so failback response is not ignored
      this.stats.aborted = false;

      this.failbackConfig.onFailback?.(
        this.originalUrl,
        failbackUrl,
        this.failbackAttempt,
      );

      logger.log(
        `[FailbackLoader] FAILBACK: trying host #${this.failbackAttempt}: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

    logger.log(
      `[FailbackLoader] ALL FAILED: no more failback hosts available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${this.failbackAttempt + 1}`,
    );

    this.failbackConfig.onAllFailed?.(
      this.originalUrl,
      this.failbackAttempt + 1,
    );

    this.callbacks?.onError?.(
      { code: status, text: xhr.statusText },
      this.context as FragmentLoaderContext,
      xhr,
      this.stats,
    );
  }

  private onTimeout(currentUrl: string) {
    const state = getSessionState(this.config);
    const elapsed = self.performance.now() - this.stats.loading.start;
    const loaded = this.stats.loaded || 0;
    const total = this.stats.total || 0;
    const percent = total > 0 ? ((loaded / total) * 100).toFixed(1) : '?';

    logger.log(
      `[FailbackLoader] TIMEOUT:` +
        `\n  url: ${currentUrl}` +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  elapsed: ${elapsed.toFixed(0)}ms` +
        `\n  loaded: ${(loaded / 1024).toFixed(1)}KB / ${(total / 1024).toFixed(1)}KB (${percent}%)` +
        `\n  state: failures=${state.consecutiveOriginalFailures}, permanentMode=${state.permanentFailbackMode}`,
    );

    // Track failures on original source (not already in permanent mode)
    if (this.failbackAttempt === 0 && !state.permanentFailbackMode) {
      state.consecutiveOriginalFailures++;
      logger.log(
        `[FailbackLoader] Original source timeout (${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})`,
      );

      if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
        state.permanentFailbackMode = true;
        logger.log(
          `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable`,
        );
      }
    }

    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);

    if (failbackUrl && failbackUrl !== currentUrl) {
      this.failbackAttempt++;
      this.abortInternal();
      // Reset aborted flag so failback response is not ignored
      this.stats.aborted = false;

      this.failbackConfig.onFailback?.(
        this.originalUrl,
        failbackUrl,
        this.failbackAttempt,
      );

      logger.log(
        `[FailbackLoader] FAILBACK: trying host #${this.failbackAttempt}: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

    logger.log(
      `[FailbackLoader] ALL FAILED: no more failback hosts available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${this.failbackAttempt + 1}`,
    );

    this.failbackConfig.onAllFailed?.(
      this.originalUrl,
      this.failbackAttempt + 1,
    );

    this.abortInternal();
    this.callbacks?.onTimeout?.(
      this.stats,
      this.context as FragmentLoaderContext,
      this.loader,
    );
  }

  private onNetworkError(xhr: XMLHttpRequest, currentUrl: string) {
    // Ignore if this is not the current loader (stale callback from previous request)
    if (this.loader !== xhr) {
      return;
    }

    self.clearTimeout(this.requestTimeout);
    this.stopStallCheck();
    const state = getSessionState(this.config);
    const elapsed = self.performance.now() - this.stats.loading.start;
    const finalUrl = xhr.responseURL || currentUrl;
    const wasRedirected = finalUrl !== currentUrl;

    logger.log(
      `[FailbackLoader] NETWORK ERROR:` +
        `\n  url: ${currentUrl}` +
        (wasRedirected ? `\n  redirected: ${finalUrl}` : '') +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  elapsed: ${elapsed.toFixed(0)}ms` +
        `\n  loaded: ${this.stats.loaded || 0} bytes` +
        `\n  state: failures=${state.consecutiveOriginalFailures}, permanentMode=${state.permanentFailbackMode}`,
    );

    // Track failures on original source (not already in permanent mode)
    if (this.failbackAttempt === 0 && !state.permanentFailbackMode) {
      state.consecutiveOriginalFailures++;
      logger.log(
        `[FailbackLoader] Original source network error (${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})`,
      );

      if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
        state.permanentFailbackMode = true;
        logger.log(
          `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable`,
        );
      }
    }

    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);

    if (failbackUrl && failbackUrl !== currentUrl) {
      this.failbackAttempt++;
      // Reset aborted flag so failback response is not ignored
      this.stats.aborted = false;

      this.failbackConfig.onFailback?.(
        this.originalUrl,
        failbackUrl,
        this.failbackAttempt,
      );

      logger.log(
        `[FailbackLoader] FAILBACK: trying host #${this.failbackAttempt}: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

    logger.log(
      `[FailbackLoader] ALL FAILED: no more failback hosts available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${this.failbackAttempt + 1}`,
    );

    this.failbackConfig.onAllFailed?.(
      this.originalUrl,
      this.failbackAttempt + 1,
    );

    this.callbacks?.onError?.(
      { code: 0, text: 'Network error' },
      this.context as FragmentLoaderContext,
      this.loader,
      this.stats,
    );
  }

  private onProgress(event: ProgressEvent) {
    this.stats.loaded = event.loaded;
    if (event.lengthComputable) {
      this.stats.total = event.total;
    }

    // Update last progress time for stall detection
    this.lastProgressTime = self.performance.now();
  }

  getCacheAge(): number | null {
    return null;
  }

  getResponseHeader(name: string): string | null {
    return this.loader?.getResponseHeader(name) || null;
  }
}

export default FailbackLoader;
