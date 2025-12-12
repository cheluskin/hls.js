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
// Хосты загружаются из DNS TXT записи fb.turoktv.com
// ============================================
const DEFAULT_DNS_DOMAIN = 'fb.turoktv.com';
const FALLBACK_HOSTS = ['failback.turkserial.co'];
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
  recoveryMediaElement: HTMLMediaElement | null;
  isProbeInProgress: boolean;
}

const failbackStates = new WeakMap<HlsConfig, FailbackSessionState>();

const PERMANENT_FAILBACK_THRESHOLD = 2;
const PROBE_EVERY_N_FRAGMENTS = 6;
const PROBE_TIMEOUT_MS = 3000;
const MIN_BUFFER_FOR_RECOVERY = 25;
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
      recoveryMediaElement: null,
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
  hasRecoveryMediaElement: boolean;
  isProbeInProgress: boolean;
  minBufferForRecovery: number;
} {
  const state = getSessionState(config);
  return {
    consecutiveFailures: state.consecutiveOriginalFailures,
    permanentMode: state.permanentFailbackMode,
    threshold: state.threshold,
    fragmentsSinceLastProbe: state.fragmentsSinceLastProbe,
    probeEveryNFragments: PROBE_EVERY_N_FRAGMENTS,
    lastSuccessfulOriginalUrl: state.lastSuccessfulOriginalUrl,
    hasRecoveryMediaElement: state.recoveryMediaElement !== null,
    isProbeInProgress: state.isProbeInProgress,
    minBufferForRecovery: MIN_BUFFER_FOR_RECOVERY,
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
 * Set media element reference for buffer checking during CDN recovery
 * Supports both HTMLVideoElement and HTMLAudioElement
 */
export function setRecoveryVideoElement(
  config: HlsConfig,
  media: HTMLMediaElement | null,
): void {
  const state = getSessionState(config);
  state.recoveryMediaElement = media;
}

/**
 * Get buffer ahead of current playback position
 */
function getBufferAhead(state: FailbackSessionState): number {
  if (!state.recoveryMediaElement) return 0;

  const media = state.recoveryMediaElement;
  const buffered = media.buffered;
  const currentTime = media.currentTime;

  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return 0;
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
    const timeoutId = self.setTimeout(
      () => controller.abort(),
      PROBE_TIMEOUT_MS,
    );

    const mergedHeaders: Record<string, string> = {
      Range: 'bytes=0-1023',
      ...headers,
    };

    fetch(url, {
      method: 'GET',
      headers: mergedHeaders,
      signal: controller.signal,
    })
      .then((response) => {
        self.clearTimeout(timeoutId);
        resolve(response.status === 200 || response.status === 206);
      })
      .catch(() => {
        self.clearTimeout(timeoutId);
        resolve(false);
      });
  });
}

/**
 * Try to recover to original CDN if conditions are met
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

  // Check buffer - need enough runway for safe switch
  const bufferAhead = getBufferAhead(state);
  if (bufferAhead < MIN_BUFFER_FOR_RECOVERY) {
    logger.log(
      `[FailbackLoader] Recovery skipped - buffer ${bufferAhead.toFixed(1)}s < ${MIN_BUFFER_FOR_RECOVERY}s required`,
    );
    return;
  }

  state.isProbeInProgress = true;
  logger.log(
    `[FailbackLoader] Probing original CDN (buffer=${bufferAhead.toFixed(1)}s)...`,
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

      // Re-check buffer after probe (user may have seeked)
      const bufferAfterProbe = getBufferAhead(state);
      if (bufferAfterProbe < MIN_BUFFER_FOR_RECOVERY) {
        logger.log(
          `[FailbackLoader] Recovery aborted - buffer dropped to ${bufferAfterProbe.toFixed(1)}s during probe`,
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
  /** Disable Cache-Control header (useful for dev/test servers with strict CORS) */
  disableCacheControlHeader?: boolean;
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
      disableCacheControlHeader: userConfig.disableCacheControlHeader,
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
        `[FailbackLoader] ${currentUrl} stalled, trying: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

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

    const xhr = (this.loader = new self.XMLHttpRequest());

    xhr.open('GET', url, true);
    xhr.responseType = context.responseType as XMLHttpRequestResponseType;

    const headers = context.headers;
    if (headers) {
      for (const header in headers) {
        xhr.setRequestHeader(header, headers[header]);
      }
    }

    // Disable browser cache to prevent auto-adding Range headers from stale cache
    // This fixes ISP blocking issues where browser returns incomplete cached data
    if (!this.failbackConfig.disableCacheControlHeader) {
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

    const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
    const timeout =
      maxTimeToFirstByteMs && Number.isFinite(maxTimeToFirstByteMs)
        ? maxTimeToFirstByteMs
        : maxLoadTimeMs;

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
              state.lastSuccessfulOriginalUrl = this.originalUrl;
            }

            // CDN Recovery: count fragments and probe when in permanent failback mode
            if (state.permanentFailbackMode) {
              state.fragmentsSinceLastProbe++;
              logger.log(
                `[FailbackLoader] SUCCESS (permanent failback): ${xhr.responseURL} [${state.fragmentsSinceLastProbe}/${PROBE_EVERY_N_FRAGMENTS}]`,
              );

              // Time to probe original CDN?
              if (state.fragmentsSinceLastProbe >= PROBE_EVERY_N_FRAGMENTS) {
                state.fragmentsSinceLastProbe = 0;
                // Fire and forget - don't block the current request
                // Pass headers for authenticated probe (if any)
                tryRecoverToOriginalCDN(this.config, context.headers);
              }
            } else if (this.failbackAttempt > 0) {
              logger.log(
                `[FailbackLoader] SUCCESS via failback #${this.failbackAttempt}: ${xhr.responseURL}`,
              );
            } else {
              logger.log(
                `[FailbackLoader] SUCCESS (direct): ${xhr.responseURL}`,
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
        `[FailbackLoader] ${currentUrl} failed (${status}), trying: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

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
        `[FailbackLoader] ${currentUrl} timeout, trying: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

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
        `[FailbackLoader] ${currentUrl} network error, trying: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

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
