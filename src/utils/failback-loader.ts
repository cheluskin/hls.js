import {
  DEFAULT_FAILBACK_DNS_DOMAIN,
  getFailbackHostsSync,
  preloadFailbackHosts as preloadResolvedFailbackHosts,
} from './failback-host-resolver';
import { applyHostToUrl, normalizeHosts } from './failback-host-utils';
import { probeOriginalCDN } from './failback-recovery-probe';
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
// FAILBACK STATE ISOLATION
// State is stored per HlsConfig instance to support multiple players on one page
// ============================================

interface FailbackSessionState {
  consecutiveOriginalFailures: number;
  permanentFailbackMode: boolean;
  threshold: number;
  fragmentsSinceLastProbe: number;
  lastSuccessfulOriginalUrl: string | null;
  lastSuccessfulOriginalUrlOrder: number;
  nextRequestOrder: number;
  isProbeInProgress: boolean;
  unhealthyFailbackHosts: Map<string, number>;
}

const failbackStates = new WeakMap<HlsConfig, FailbackSessionState>();

// Number of ordinary consecutive failures on original CDN before switching to
// permanent failback. A confirmed incomplete transfer switches immediately.
// We use 2 for transient issues. The 206 detection handles browser Range
// requests from cached partial data.
const PERMANENT_FAILBACK_THRESHOLD = 2;
const PROBE_EVERY_N_FRAGMENTS = 6;
const PROBE_TIMEOUT_MS = 3000;
const STALL_TIMEOUT_MS = 5000;
const STALL_CHECK_INTERVAL_MS = 1000;
const MIN_SPEED_BYTES_PER_SEC = 4096;
const DEFAULT_FAILBACK_HOST_COOLDOWN_MS = 30000;

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
      lastSuccessfulOriginalUrlOrder: 0,
      nextRequestOrder: 0,
      isProbeInProgress: false,
      unhealthyFailbackHosts: new Map(),
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

  probeOriginalCDN(config, urlToProbe, PROBE_TIMEOUT_MS, headers)
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

export function preloadFailbackHosts(
  dnsDomain: string = DEFAULT_FAILBACK_DNS_DOMAIN,
): Promise<string[]> {
  return preloadResolvedFailbackHosts(dnsDomain);
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
   * How long a failback host is skipped after it fails (default: 30000ms).
   * Set to 0 to retry every host on every fragment.
   */
  failbackHostCooldownMs?: number;
  /**
   * Enable Cache-Control: no-store header.
   * This prevents browser from caching partial responses but triggers CORS preflight
   * (OPTIONS requests), which doubles the number of requests.
   * Default: false (rely on 206 detection instead)
   */
  enableCacheControlHeader?: boolean;
  /**
   * Emit detailed per-fragment logs (load start, response headers, success).
   * Critical events (failback switch, permanent mode, probe, errors) are
   * always logged regardless. Default: false.
   */
  verbose?: boolean;
}

// Safety cap to prevent infinite loops if transformUrl never returns null
const MAX_FAILBACK_ATTEMPTS = 32;

class FailbackLoader implements Loader<FragmentLoaderContext> {
  private config: HlsConfig;
  private failbackConfig: FailbackConfig;
  private loader: XMLHttpRequest | null = null;
  private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
  public context: FragmentLoaderContext | null = null;
  public stats: LoaderStats;
  private failbackAttempt: number = 0;
  private nextFailbackIndex: number = 0;
  private originalUrl: string = '';
  private attemptedOriginalRequest: boolean = false;
  private requestOrder: number = 0;
  private requestTimeout?: number;
  private loaderConfig: LoaderConfiguration | null = null;
  // `stats.loading.start` covers the entire logical load, including retries.
  // Each CDN attempt needs an independent TTFB and download time budget.
  private attemptStartTime: number = 0;

  // Stall detection
  private lastProgressTime: number = 0;
  private stallCheckInterval?: number;
  private currentUrl: string = '';
  private lastStallCheckTime: number = 0;

  // Throughput detection
  private lastTotalBytes: number = 0;
  private lowSpeedDuration: number = 0;

  // Track URLs already attempted so we don't retry them
  private triedUrls: Set<string> = new Set();

  constructor(config: HlsConfig) {
    this.config = config;
    this.stats = new LoadStats();

    const userConfig: FailbackConfig = config.failbackConfig || {};
    const staticHosts = normalizeHosts(userConfig.staticHosts);

    this.failbackConfig = {
      dnsDomain: userConfig.dnsDomain || DEFAULT_FAILBACK_DNS_DOMAIN,
      staticHosts: staticHosts.length > 0 ? staticHosts : undefined,
      transformUrl: userConfig.transformUrl,
      onSuccess: userConfig.onSuccess,
      onFailback: userConfig.onFailback,
      onAllFailed: userConfig.onAllFailed,
      failbackHostCooldownMs: userConfig.failbackHostCooldownMs,
      enableCacheControlHeader: userConfig.enableCacheControlHeader,
      verbose: userConfig.verbose,
    };

    // Ensure state exists for this config
    getSessionState(config);

    // Start DNS preload if not already started (fire and forget)
    preloadResolvedFailbackHosts(this.getDnsDomain()).catch(() => {
      // Ignore errors - will use fallback hosts
    });
  }

  private getDnsDomain(): string {
    return this.failbackConfig.dnsDomain || DEFAULT_FAILBACK_DNS_DOMAIN;
  }

  /**
   * Emit a verbose-only log. Critical events should use logger.log directly.
   */
  private logVerbose(message: string): void {
    if (this.failbackConfig.verbose) {
      logger.log(message);
    }
  }

  /**
   * Get failback hosts (static config or DNS-resolved).
   *
   * Resolved dynamically on every call — DO NOT cache per-loader. The DNS
   * preload is asynchronous, so the first few load() invocations may see the
   * built-in fallback list; if DNS resolves mid-session we want subsequent
   * retries to pick up the fresh GeoDNS-ordered list. The underlying
   * getFailbackHostsSync() is a Map lookup and staticHosts is pre-normalized
   * in the constructor, so there is no meaningful cost to re-reading.
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
    return getFailbackHostsSync(this.getDnsDomain());
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
    const now = self.performance.now();
    this.currentUrl = url;
    this.lastProgressTime = now;
    this.lastStallCheckTime = now;
    this.lastTotalBytes = this.stats.loaded || 0;
    this.lowSpeedDuration = 0;

    this.stallCheckInterval = self.setInterval(() => {
      const tickNow = self.performance.now();

      // 1. Strict Silence Check
      // If we haven't received ANY event for STALL_TIMEOUT_MS
      const timeSinceProgress = tickNow - this.lastProgressTime;
      if (timeSinceProgress > STALL_TIMEOUT_MS) {
        logger.log(
          `[FailbackLoader] Strict stall detected (no events for ${timeSinceProgress}ms)`,
        );
        this.onStall();
        return;
      }

      // 2. Minimum Throughput Check (trickle detection)
      // Use actual elapsed time, not a fixed interval assumption — setInterval
      // can drift under CPU pressure or tab throttling.
      const dt = tickNow - this.lastStallCheckTime;
      this.lastStallCheckTime = tickNow;

      const currentLoaded = this.stats.loaded;
      const bytesDiff = currentLoaded - this.lastTotalBytes;

      // Only check for stalls once we've started receiving data
      if (currentLoaded > 0 && dt > 0) {
        const bytesPerSec = bytesDiff / (dt / 1000);

        if (bytesPerSec < MIN_SPEED_BYTES_PER_SEC) {
          this.lowSpeedDuration += dt;

          if (this.lowSpeedDuration >= STALL_TIMEOUT_MS) {
            logger.log(
              `[FailbackLoader] Throughput stall detected (speed ${bytesPerSec.toFixed(0)} B/s < ${MIN_SPEED_BYTES_PER_SEC} B/s for ${this.lowSpeedDuration.toFixed(0)}ms)`,
            );
            this.onStall();
            return;
          }
        } else {
          // Speed is good, reset counter
          this.lowSpeedDuration = 0;
        }
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

    this.recordSourceFailure(
      currentUrl,
      `Source stalled - no progress for ${STALL_TIMEOUT_MS}ms`,
      true,
    );

    this.tryFailbackOrComplete(
      currentUrl,
      () => {
        this.abortInternal();
        this.callbacks?.onTimeout?.(
          this.stats,
          this.context as FragmentLoaderContext,
          this.loader,
        );
      },
      true,
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
      // Drop the reference so any stale async callbacks from this xhr
      // bail out via `this.loader !== xhr` check.
      this.loader = null;
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
    this.nextFailbackIndex = 0;
    this.originalUrl = context.url;
    this.attemptedOriginalRequest = false;

    const state = getSessionState(this.config);
    this.requestOrder = ++state.nextRequestOrder;
    this.triedUrls.clear();
    const hosts = this.getHosts();

    // Per-fragment start log is verbose by default — only critical transitions
    // (permanent mode switch, failback, errors) log unconditionally.
    this.logVerbose(
      `[FailbackLoader] LOAD START: ${context.url}` +
        `\n  state: failures=${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD}, permanentMode=${state.permanentFailbackMode}` +
        `\n  hosts: [${hosts.join(', ')}]` +
        `\n  config: stallTimeout=${STALL_TIMEOUT_MS}ms, minSpeed=${MIN_SPEED_BYTES_PER_SEC}B/s, probeEvery=${PROBE_EVERY_N_FRAGMENTS}frags`,
    );

    // In permanent failback mode, skip original source entirely
    if (state.permanentFailbackMode) {
      const failbackUrl = this.getNextFailbackUrl(null);
      if (failbackUrl) {
        this.failbackAttempt = 1;
        logger.log(
          `[FailbackLoader] PERMANENT FAILBACK MODE - skipping original, using: ${failbackUrl}`,
        );
        this.loadUrl(failbackUrl);
        return;
      }

      this.completeNoHealthyFailbackHosts();
      return;
    }

    this.attemptedOriginalRequest = true;
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

      applyHostToUrl(url, failbackHost);

      // Always use HTTPS for failback hosts (CDNs require it)
      url.protocol = 'https:';

      return url.toString();
    } catch {
      return null;
    }
  }

  private hasByteRange(context: FragmentLoaderContext): boolean {
    const { rangeStart, rangeEnd } = context;
    return (
      typeof rangeStart === 'number' &&
      typeof rangeEnd === 'number' &&
      Number.isFinite(rangeStart) &&
      Number.isFinite(rangeEnd) &&
      rangeEnd > rangeStart
    );
  }

  private getFailbackHostCooldownMs(): number {
    const cooldownMs = this.failbackConfig.failbackHostCooldownMs;
    return Number.isFinite(cooldownMs) && cooldownMs! >= 0
      ? cooldownMs!
      : DEFAULT_FAILBACK_HOST_COOLDOWN_MS;
  }

  private getFailbackHostKey(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  private isFailbackHostAvailable(url: string): boolean {
    const state = getSessionState(this.config);
    const hostKey = this.getFailbackHostKey(url);
    const unavailableUntil = state.unhealthyFailbackHosts.get(hostKey);
    if (!unavailableUntil) {
      return true;
    }

    if (unavailableUntil <= self.performance.now()) {
      state.unhealthyFailbackHosts.delete(hostKey);
      return true;
    }

    this.logVerbose(
      `[FailbackLoader] Skipping quarantined failback host: ${hostKey}`,
    );
    return false;
  }

  private quarantineFailbackHost(url: string, reason: string): void {
    if (this.failbackAttempt === 0) {
      return;
    }

    const cooldownMs = this.getFailbackHostCooldownMs();
    if (cooldownMs === 0) {
      return;
    }

    const hostKey = this.getFailbackHostKey(url);
    const unavailableUntil = self.performance.now() + cooldownMs;
    getSessionState(this.config).unhealthyFailbackHosts.set(
      hostKey,
      unavailableUntil,
    );
    logger.log(
      `[FailbackLoader] QUARANTINING FAILBACK HOST:` +
        `\n  host: ${hostKey}` +
        `\n  reason: ${reason}` +
        `\n  cooldown: ${cooldownMs}ms`,
    );
  }

  private recordSourceFailure(
    currentUrl: string,
    reason: string,
    confirmedUnusable: boolean = false,
  ): void {
    if (this.failbackAttempt === 0) {
      this.recordOriginalSourceFailure(reason, confirmedUnusable);
      return;
    }

    this.quarantineFailbackHost(currentUrl, reason);
  }

  private switchToPermanentFailbackModeIfNeeded(state: FailbackSessionState) {
    if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
      state.permanentFailbackMode = true;
      logger.log(
        `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable`,
      );
    }
  }

  private recordOriginalSourceFailure(
    reason: string,
    confirmedUnusable: boolean = false,
  ) {
    const state = getSessionState(this.config);

    if (this.failbackAttempt !== 0 || state.permanentFailbackMode) {
      return;
    }

    // A response that starts and then stalls or truncates is conclusively
    // unusable for playback. Do not spend another fragment on the same CDN.
    // Ordinary transport failures retain the two-failure threshold.
    state.consecutiveOriginalFailures = confirmedUnusable
      ? state.threshold
      : state.consecutiveOriginalFailures + 1;
    logger.log(
      `[FailbackLoader] ${reason} (${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})${confirmedUnusable ? ' - switching immediately' : ''}`,
    );

    this.switchToPermanentFailbackModeIfNeeded(state);
  }

  private logAllFailed() {
    const totalAttempts =
      (this.attemptedOriginalRequest ? 1 : 0) + this.failbackAttempt;

    logger.log(
      `[FailbackLoader] ALL FAILED: no more failback hosts available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${totalAttempts}`,
    );

    this.failbackConfig.onAllFailed?.(this.originalUrl, totalAttempts);
  }

  private startFailbackRequest(failbackUrl: string, abortBeforeRetry: boolean) {
    this.failbackAttempt++;

    if (abortBeforeRetry) {
      this.abortInternal();
    }

    this.stats.aborted = false;
    this.stats.loading.first = 0;
    this.stats.loading.end = 0;
    this.stats.loaded = 0;
    this.stats.total = 0;
    this.stats.bwEstimate = 0;

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
  }

  private getNextFailbackUrl(currentUrl: string | null): string | null {
    let candidateIndex = this.nextFailbackIndex;

    while (candidateIndex < MAX_FAILBACK_ATTEMPTS) {
      const candidate = this.getFailbackUrl(candidateIndex);
      if (!candidate) {
        break;
      }
      candidateIndex++;

      if (candidate === currentUrl || this.triedUrls.has(candidate)) {
        continue;
      }
      if (!this.isFailbackHostAvailable(candidate)) {
        continue;
      }

      this.nextFailbackIndex = candidateIndex;
      return candidate;
    }

    this.nextFailbackIndex = candidateIndex;
    return null;
  }

  private completeNoHealthyFailbackHosts() {
    this.logAllFailed();
    this.callbacks?.onError?.(
      { code: 0, text: 'No healthy failback hosts available' },
      this.context as FragmentLoaderContext,
      this.loader,
      this.stats,
    );
  }

  private tryFailbackOrComplete(
    currentUrl: string,
    onExhausted: () => void,
    abortBeforeRetry: boolean = false,
  ) {
    const failbackUrl = this.getNextFailbackUrl(currentUrl);
    if (failbackUrl) {
      this.startFailbackRequest(failbackUrl, abortBeforeRetry);
      return;
    }

    this.logAllFailed();
    onExhausted();
  }

  private loadUrl(url: string) {
    const context = this.context;
    const config = this.loaderConfig;
    if (!context || !config) return;

    this.triedUrls.add(url);

    const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
    const timeout =
      maxTimeToFirstByteMs && Number.isFinite(maxTimeToFirstByteMs)
        ? maxTimeToFirstByteMs
        : maxLoadTimeMs;

    this.logVerbose(
      `[FailbackLoader] LOADING: ${url}` +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  timeout: ${timeout}ms (ttfb=${maxTimeToFirstByteMs}ms, maxLoad=${maxLoadTimeMs}ms)`,
    );

    const xhr = (this.loader = new self.XMLHttpRequest());
    const xhrSetup = this.config.xhrSetup;
    if (xhrSetup) {
      const xhrContext = url !== context.url ? { ...context, url } : context;
      Promise.resolve()
        .then(() => {
          if (this.loader !== xhr || this.stats.aborted) return;
          return xhrSetup(xhr, url, xhrContext);
        })
        .catch(() => {
          if (this.loader !== xhr || this.stats.aborted) return;
          xhr.open('GET', url, true);
          return xhrSetup(xhr, url, xhrContext);
        })
        .then(() => {
          if (this.loader !== xhr || this.stats.aborted) return;
          this.openAndSendXhr(xhr, context, url, timeout);
        })
        .catch((error) => {
          if (this.loader !== xhr || this.stats.aborted) return;
          logger.warn(
            `[FailbackLoader] xhrSetup failed for ${url}: ${error?.message || error}`,
          );
          this.onNetworkError(xhr, url);
        });
      return;
    }

    this.openAndSendXhr(xhr, context, url, timeout);
  }

  private openAndSendXhr(
    xhr: XMLHttpRequest,
    context: FragmentLoaderContext,
    url: string,
    timeout: number,
  ) {
    if (!xhr.readyState) {
      xhr.open('GET', url, true);
    }

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

    if (this.hasByteRange(context)) {
      xhr.setRequestHeader(
        'Range',
        'bytes=' + context.rangeStart + '-' + (context.rangeEnd! - 1),
      );
    }

    xhr.onreadystatechange = () => this.onReadyStateChange(xhr, url);
    xhr.onprogress = this.onProgress.bind(this);
    xhr.onerror = () => this.onNetworkError(xhr, url);

    this.attemptStartTime = self.performance.now();
    self.clearTimeout(this.requestTimeout);
    this.requestTimeout = self.setTimeout(
      () => this.onTimeout(url, xhr),
      timeout,
    );

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
          this.attemptStartTime,
        );
        const ttfb = stats.loading.first - this.attemptStartTime;
        const finalUrl = xhr.responseURL || currentUrl;
        const wasRedirected = finalUrl !== currentUrl;

        this.logVerbose(
          `[FailbackLoader] RESPONSE HEADERS RECEIVED:` +
            `\n  status: ${xhr.status}` +
            `\n  ttfb: ${ttfb.toFixed(0)}ms` +
            `\n  requested: ${currentUrl}` +
            (wasRedirected ? `\n  redirected: ${finalUrl}` : ''),
        );

        if (config.loadPolicy.maxLoadTimeMs) {
          self.clearTimeout(this.requestTimeout);
          const remaining = config.loadPolicy.maxLoadTimeMs - ttfb;
          if (remaining <= 0) {
            // Already over budget by first-byte time — fire timeout
            // asynchronously to unwind the current onreadystatechange cleanly.
            this.requestTimeout = self.setTimeout(
              () => this.onTimeout(currentUrl, xhr),
              0,
            );
          } else {
            this.requestTimeout = self.setTimeout(
              () => this.onTimeout(currentUrl, xhr),
              remaining,
            );
          }
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
            // An application request without Range must never accept 206.
            // Browsers can synthesize it while serving a stale partial cache;
            // Content-Range is often hidden by CORS, so its visibility cannot
            // be part of the detection. This is a per-request browser/cache
            // anomaly, not evidence that the original CDN is unavailable.
            const weRequestedRange = this.hasByteRange(context);
            if (status === 206 && !weRequestedRange) {
              this.handleUnexpectedRangeResponse(xhr, currentUrl);
              return;
            }

            const len =
              xhr.responseType === 'arraybuffer'
                ? data.byteLength
                : data.length;

            const responseIntegrityError = this.getResponseIntegrityError(
              xhr,
              context,
              status,
              len,
            );
            if (responseIntegrityError) {
              this.handleInvalidResponse(
                xhr,
                currentUrl,
                status,
                responseIntegrityError,
              );
              return;
            }

            stats.loading.end = Math.max(
              self.performance.now(),
              stats.loading.first,
            );

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

            // Store the freshest original URL for future recovery probes.
            // Overlapping loaders share one state object, so an older request
            // finishing later must not clobber a newer fragment URL.
            if (this.requestOrder >= state.lastSuccessfulOriginalUrlOrder) {
              const wasNull = !state.lastSuccessfulOriginalUrl;
              state.lastSuccessfulOriginalUrl = this.originalUrl;
              state.lastSuccessfulOriginalUrlOrder = this.requestOrder;

              if (wasNull) {
                logger.log(
                  `[FailbackLoader] Stored original URL for recovery probes: ${this.originalUrl}`,
                );
              }
            }

            if (
              this.requestOrder < state.lastSuccessfulOriginalUrlOrder &&
              state.lastSuccessfulOriginalUrl
            ) {
              this.logVerbose(
                `[FailbackLoader] Ignoring stale original URL for recovery probes: ${this.originalUrl}`,
              );
            }

            // Calculate download stats for logging
            const downloadTime = stats.loading.end - stats.loading.start;
            const speedKBps = len / 1024 / (downloadTime / 1000);
            const speedMbps = (len * 8) / (downloadTime * 1000);

            // CDN Recovery: count fragments and probe when in permanent failback mode
            if (state.permanentFailbackMode) {
              state.fragmentsSinceLastProbe++;
              this.logVerbose(
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
              // Keep failback-success at default log level — it's a significant
              // event (we recovered via backup) that operators want to see.
              logger.log(
                `[FailbackLoader] SUCCESS via failback #${this.failbackAttempt}:` +
                  `\n  url: ${xhr.responseURL}` +
                  `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms` +
                  `\n  speed: ${speedKBps.toFixed(1)}KB/s (${speedMbps.toFixed(2)}Mbps)`,
              );
            } else {
              this.logVerbose(
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

    this.recordSourceFailure(currentUrl, 'Source failed');

    this.tryFailbackOrComplete(currentUrl, () => {
      this.callbacks?.onError?.(
        { code: status, text: xhr.statusText },
        this.context as FragmentLoaderContext,
        xhr,
        this.stats,
      );
    });
  }

  /**
   * Validate that a terminal XHR contains the byte range it claims to contain.
   * A middlebox can close a 200 response after a small prefix while XHR still
   * exposes the resulting ArrayBuffer as a successful response.
   */
  private getResponseIntegrityError(
    xhr: XMLHttpRequest,
    context: FragmentLoaderContext,
    status: number,
    responseLength: number,
  ): string | null {
    const contentEncoding = xhr.getResponseHeader('Content-Encoding');
    const contentLength = xhr.getResponseHeader('Content-Length');

    // Content-Length describes encoded bytes. XHR decodes content, so only
    // compare lengths when the response is unencoded (as media normally is).
    if (
      contentLength &&
      (!contentEncoding || contentEncoding.toLowerCase() === 'identity')
    ) {
      const expectedLength = Number(contentLength);
      if (
        Number.isSafeInteger(expectedLength) &&
        expectedLength >= 0 &&
        responseLength !== expectedLength
      ) {
        return `response body is ${responseLength} bytes but Content-Length is ${expectedLength}`;
      }
    }

    if (!this.hasByteRange(context)) {
      return null;
    }

    const expectedLength = context.rangeEnd! - context.rangeStart!;
    if (expectedLength >= 0 && responseLength !== expectedLength) {
      return `range body is ${responseLength} bytes but requested range requires ${expectedLength}`;
    }

    if (status !== 206) {
      return null;
    }

    const contentRange = xhr.getResponseHeader('Content-Range');
    // Content-Range is not CORS-safelisted. Correct range responses from a
    // CDN which does not expose it remain valid if their body length matches.
    if (!contentRange) {
      return null;
    }

    const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!match) {
      return '206 response has an invalid Content-Range header';
    }

    const responseStart = Number(match[1]);
    const responseEnd = Number(match[2]);
    if (
      responseStart !== context.rangeStart ||
      responseEnd !== context.rangeEnd! - 1
    ) {
      return `response range ${responseStart}-${responseEnd} does not match requested range ${context.rangeStart}-${context.rangeEnd! - 1}`;
    }

    return null;
  }

  private handleUnexpectedRangeResponse(
    xhr: XMLHttpRequest,
    currentUrl: string,
  ) {
    const contentRange = xhr.getResponseHeader('Content-Range');
    logger.log(
      `[FailbackLoader] UNEXPECTED PARTIAL RESPONSE:` +
        `\n  status: 206 Partial Content` +
        `\n  url: ${currentUrl}` +
        `\n  Content-Range: ${contentRange || '(not exposed to JavaScript)'}` +
        `\n  ACTION: Treating as a browser/cache error, will try failback`,
    );

    // Do not update origin health here. The browser may have generated this
    // response from a poisoned cache without the network request reaching the
    // CDN, so permanent failback would be a false attribution.
    this.tryFailbackOrComplete(currentUrl, () => {
      this.callbacks?.onError?.(
        { code: 206, text: 'Unexpected Partial Content response' },
        this.context as FragmentLoaderContext,
        xhr,
        this.stats,
      );
    });
  }

  private handleInvalidResponse(
    xhr: XMLHttpRequest,
    currentUrl: string,
    status: number,
    reason: string,
  ) {
    this.stopStallCheck();
    logger.log(
      `[FailbackLoader] INCOMPLETE RESPONSE:` +
        `\n  status: ${status} ${xhr.statusText}` +
        `\n  url: ${currentUrl}` +
        `\n  attempt: ${this.failbackAttempt}` +
        `\n  reason: ${reason}` +
        `\n  ACTION: Treating as an error, will try failback`,
    );

    this.recordSourceFailure(
      currentUrl,
      'Source returned an incomplete response',
      true,
    );

    this.tryFailbackOrComplete(currentUrl, () => {
      this.callbacks?.onError?.(
        { code: status, text: reason },
        this.context as FragmentLoaderContext,
        xhr,
        this.stats,
      );
    });
  }

  private onTimeout(currentUrl: string, xhr?: XMLHttpRequest) {
    if (xhr && this.loader !== xhr) {
      return;
    }

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

    this.recordSourceFailure(
      currentUrl,
      'Source timeout',
      this.stats.loading.first !== 0 || this.stats.loaded > 0,
    );

    this.tryFailbackOrComplete(
      currentUrl,
      () => {
        this.abortInternal();
        this.callbacks?.onTimeout?.(
          this.stats,
          this.context as FragmentLoaderContext,
          this.loader,
        );
      },
      true,
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

    this.recordSourceFailure(
      currentUrl,
      'Source network error',
      this.stats.loading.first !== 0 || this.stats.loaded > 0,
    );

    this.tryFailbackOrComplete(currentUrl, () => {
      this.callbacks?.onError?.(
        { code: 0, text: 'Network error' },
        this.context as FragmentLoaderContext,
        this.loader,
        this.stats,
      );
    });
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
    // Some browsers throw InvalidStateError when called before headers arrive
    // or after the xhr is in an unusable state.
    try {
      return this.loader?.getResponseHeader(name) || null;
    } catch {
      return null;
    }
  }
}

export default FailbackLoader;
