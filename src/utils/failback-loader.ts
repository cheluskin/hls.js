import {
  DEFAULT_FAILBACK_DNS_DOMAIN,
  getFailbackHostsSync,
  preloadFailbackHosts as preloadResolvedFailbackHosts,
} from './failback-host-resolver';
import { applyHostToUrl, normalizeHosts } from './failback-host-utils';
import {
  probeOriginalCDN,
  RECOVERY_PROBE_MAX_BYTES,
} from './failback-recovery-probe';
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
  lastSuccessfulOriginalLength: number | null;
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

// --- Censorship-resilience tuning (defaults, overridable via FailbackConfig) ---
//
// TSPU/DPI blocking observed in the wild lets the TLS handshake complete, then
// blackholes the HTTP response after 0 or a few bytes. The connection stays
// "open" but silent. A healthy CDN returns response headers in well under a
// second, so a much shorter budget than the transport timeout lets us abandon
// a blackholed attempt quickly instead of waiting the full maxTimeToFirstByte.
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 2500;
// After the first byte arrives, a stream that goes silent (few-bytes-then-stall)
// is the other half of the same attack. Abandon it quickly, too.
const DEFAULT_DATA_STALL_TIMEOUT_MS = 3000;
// Staggered hedging: if the leading attempt has produced no first byte within
// this window, open the next candidate in parallel (without killing the slow
// one — it may still be a slow-but-working link). Kept above realistic healthy
// TTFB so a working CDN is never hedged, and so fast unit-test mocks that
// respond in milliseconds keep strictly sequential behaviour.
const DEFAULT_HEDGE_DELAY_MS = 1200;
// Hard cap on simultaneously in-flight requests for one fragment.
const DEFAULT_MAX_PARALLEL_ATTEMPTS = 3;
// A silent (blackholed) host is worth retrying on a fresh connection because
// the block is probabilistic. This bounds how many extra fresh-connection
// retries each URL gets within a single fragment load.
const DEFAULT_SILENT_RETRIES_PER_HOST = 2;

const STALL_CHECK_INTERVAL_MS = 500;
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
      lastSuccessfulOriginalLength: null,
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
  lastSuccessfulOriginalLength: number | null;
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
    lastSuccessfulOriginalLength: state.lastSuccessfulOriginalLength,
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
  // A verified recovery starts a new failback cycle. Keep no cooldown from the
  // previous outage: otherwise every backup that failed before recovery stays
  // unavailable when the original fails again immediately afterwards.
  state.unhealthyFailbackHosts.clear();

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
  const knownLength = state.lastSuccessfulOriginalLength;
  // The probe must exceed the short prefix that a TSPU can leak before
  // blackholing a response. A smaller previous segment is not enough evidence
  // to recover, so it deliberately keeps the full validation length.
  const probeLength = RECOVERY_PROBE_MAX_BYTES;
  const probeStart =
    typeof knownLength === 'number' && knownLength > probeLength
      ? knownLength - probeLength
      : 0;
  const probeEnd = probeStart + probeLength;

  logger.log(
    `[FailbackLoader] Validating original CDN range: bytes=${probeStart}-${probeEnd - 1}`,
  );

  probeOriginalCDN(
    config,
    urlToProbe,
    PROBE_TIMEOUT_MS,
    headers,
    probeStart,
    probeEnd,
  )
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

  // ---- Censorship (TSPU/DPI) resilience ----
  /**
   * Enable staggered parallel hedging: if the leading request produces no first
   * byte within `hedgeDelayMs`, the next candidate is launched in parallel and
   * the fastest valid response wins. Default: true.
   */
  hedge?: boolean;
  /**
   * Delay before hedging the next candidate in parallel while the current one
   * is still silent (no response headers). Default: 1200ms.
   */
  hedgeDelayMs?: number;
  /**
   * Abandon a single attempt that produced no response header/byte within this
   * budget (blackhole detection). Clamped to the transport
   * `maxTimeToFirstByteMs`. Default: 2500ms.
   */
  firstByteTimeoutMs?: number;
  /**
   * Abandon an attempt that received the first byte but then stalled (silence
   * or sub-`4KB/s` trickle) for this long. Default: 3000ms.
   */
  dataStallTimeoutMs?: number;
  /** Maximum simultaneously in-flight requests per fragment. Default: 3. */
  maxParallelAttempts?: number;
  /**
   * How many extra fresh-connection retries each host gets after a silent
   * (blackholed) failure within a single fragment load. HTTP errors are never
   * retried on the same host. Default: 2.
   */
  silentRetriesPerHost?: number;
}

// Safety cap to prevent infinite loops if transformUrl never returns null
const MAX_FAILBACK_ATTEMPTS = 32;
// Absolute ceiling on launched requests for one fragment (covers hedging +
// silent retries) so a total outage still terminates deterministically.
const MAX_TOTAL_ATTEMPTS_PER_LOAD = 24;

type AttemptFailureKind =
  | 'silent' // no first byte at all (classic blackhole)
  | 'stall' // started then went silent / trickled (truncated transfer)
  | 'http' // server responded with a non-2xx status
  | 'integrity' // 2xx/206 body did not match Content-Length / range
  | 'partial' // browser-synthesized 206 from a poisoned cache
  | 'network'; // transport error (onerror)

interface Attempt {
  xhr: XMLHttpRequest;
  url: string;
  isOriginal: boolean;
  failbackNumber: number; // 0 for original, >=1 for failback hosts
  startTime: number;
  firstByteAt: number; // 0 until response headers arrive
  loaded: number;
  lastProgressTime: number;
  lastSpeedCheckTime: number;
  lastSpeedCheckBytes: number;
  lowSpeedDuration: number;
  monitorInterval?: number;
  loadTimeout?: number;
  settled: boolean;
}

class FailbackLoader implements Loader<FragmentLoaderContext> {
  private config: HlsConfig;
  private failbackConfig: FailbackConfig;
  private loader: XMLHttpRequest | null = null;
  private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
  public context: FragmentLoaderContext | null = null;
  public stats: LoaderStats;
  private originalUrl: string = '';
  private attemptedOriginalRequest: boolean = false;
  private requestOrder: number = 0;
  private loaderConfig: LoaderConfiguration | null = null;
  private finished: boolean = false;

  // Candidate scheduling
  private allowOriginal: boolean = true;
  private nextFailbackIndex: number = 0;
  private pendingRetryUrls: string[] = [];
  private silentRetryBudget: Map<string, number> = new Map();
  private launchedCount: number = 0;
  private failbackAttempt: number = 0;
  private triedFailbackUrls: Set<string> = new Set();

  // In-flight attempts (parallel hedging)
  private attempts: Set<Attempt> = new Set();
  private inFlightUrls: Set<string> = new Set();
  private hedgeTimer?: number;

  // Last failure classification, used to pick onError vs onTimeout on exhaustion.
  // Definitive HTTP/integrity failures are sticky: a later silent/stall/timeout
  // must not overwrite them, otherwise completeExhausted() would report onTimeout
  // instead of the real server error. lastFailureXhr is the XHR that produced the
  // retained classification — kept separate from this.loader, which startAttempt()
  // reassigns to each newly launched hedge.
  private lastFailureKind: AttemptFailureKind | null = null;
  private lastFailureXhr: XMLHttpRequest | null = null;
  private lastErrorCode: number = 0;
  private lastErrorText: string = 'Network error';

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
      hedge: userConfig.hedge,
      hedgeDelayMs: userConfig.hedgeDelayMs,
      firstByteTimeoutMs: userConfig.firstByteTimeoutMs,
      dataStallTimeoutMs: userConfig.dataStallTimeoutMs,
      maxParallelAttempts: userConfig.maxParallelAttempts,
      silentRetriesPerHost: userConfig.silentRetriesPerHost,
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

  private isHedgeEnabled(): boolean {
    return this.failbackConfig.hedge !== false;
  }

  private getHedgeDelayMs(): number {
    const value = this.failbackConfig.hedgeDelayMs;
    return Number.isFinite(value) && value! >= 0
      ? value!
      : DEFAULT_HEDGE_DELAY_MS;
  }

  private getFirstByteTimeoutMs(): number {
    const value = this.failbackConfig.firstByteTimeoutMs;
    const configured =
      Number.isFinite(value) && value! > 0
        ? value!
        : DEFAULT_FIRST_BYTE_TIMEOUT_MS;
    // Never wait longer than the transport's own first-byte budget.
    const ttfb = this.loaderConfig?.loadPolicy.maxTimeToFirstByteMs;
    if (ttfb && Number.isFinite(ttfb)) {
      return Math.min(configured, ttfb);
    }
    return configured;
  }

  private getDataStallTimeoutMs(): number {
    const value = this.failbackConfig.dataStallTimeoutMs;
    return Number.isFinite(value) && value! > 0
      ? value!
      : DEFAULT_DATA_STALL_TIMEOUT_MS;
  }

  private getMaxParallelAttempts(): number {
    const value = this.failbackConfig.maxParallelAttempts;
    if (!this.isHedgeEnabled()) {
      return 1;
    }
    return Number.isFinite(value) && value! >= 1
      ? Math.floor(value!)
      : DEFAULT_MAX_PARALLEL_ATTEMPTS;
  }

  private getSilentRetriesPerHost(): number {
    const value = this.failbackConfig.silentRetriesPerHost;
    return Number.isFinite(value) && value! >= 0
      ? Math.floor(value!)
      : DEFAULT_SILENT_RETRIES_PER_HOST;
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
    this.loader = null;
    this.callbacks = null;
    this.context = null;
    this.loaderConfig = null;
    // Note: We do NOT destroy state here automatically because other loaders
    // might still be active or the Hls instance might be reused.
    // Explicit clean up should be done via Hls.destroy() which calls destroyFailbackState
  }

  private clearAttemptTimers(attempt: Attempt) {
    if (attempt.monitorInterval) {
      self.clearInterval(attempt.monitorInterval);
      attempt.monitorInterval = undefined;
    }
    if (attempt.loadTimeout) {
      self.clearTimeout(attempt.loadTimeout);
      attempt.loadTimeout = undefined;
    }
  }

  private teardownAttempt(attempt: Attempt, abortXhr: boolean) {
    this.clearAttemptTimers(attempt);
    this.attempts.delete(attempt);
    this.inFlightUrls.delete(attempt.url);
    const xhr = attempt.xhr;
    xhr.onreadystatechange = null;
    xhr.onprogress = null;
    xhr.onerror = null;
    if (abortXhr && xhr.readyState !== 4) {
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    }
  }

  private abortInternal() {
    if (this.hedgeTimer) {
      self.clearTimeout(this.hedgeTimer);
      this.hedgeTimer = undefined;
    }
    Array.from(this.attempts).forEach((attempt) => {
      this.teardownAttempt(attempt, true);
    });
    this.attempts.clear();
    this.inFlightUrls.clear();
  }

  abort() {
    this.stats.aborted = true;
    this.finished = true;
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
    this.originalUrl = context.url;
    this.attemptedOriginalRequest = false;
    this.finished = false;

    this.nextFailbackIndex = 0;
    this.pendingRetryUrls = [];
    this.silentRetryBudget.clear();
    this.launchedCount = 0;
    this.failbackAttempt = 0;
    this.triedFailbackUrls.clear();
    this.attempts.clear();
    this.inFlightUrls.clear();
    this.lastFailureKind = null;
    this.lastFailureXhr = null;
    this.lastErrorCode = 0;
    this.lastErrorText = 'Network error';

    const state = getSessionState(this.config);
    this.requestOrder = ++state.nextRequestOrder;
    this.allowOriginal = !state.permanentFailbackMode;

    const hosts = this.getHosts();

    // Per-fragment start log is verbose by default — only critical transitions
    // (permanent mode switch, failback, errors) log unconditionally.
    this.logVerbose(
      `[FailbackLoader] LOAD START: ${context.url}` +
        `\n  state: failures=${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD}, permanentMode=${state.permanentFailbackMode}` +
        `\n  hosts: [${hosts.join(', ')}]` +
        `\n  config: hedge=${this.isHedgeEnabled()}, hedgeDelay=${this.getHedgeDelayMs()}ms, firstByte=${this.getFirstByteTimeoutMs()}ms, dataStall=${this.getDataStallTimeoutMs()}ms, maxParallel=${this.getMaxParallelAttempts()}`,
    );

    if (state.permanentFailbackMode) {
      logger.log(
        `[FailbackLoader] PERMANENT FAILBACK MODE - skipping original`,
      );
    }

    // Kick off the first attempt. Hedging / retries schedule the rest.
    if (!this.launchNextAttempt()) {
      this.completeNoHealthyFailbackHosts();
    }
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

  private switchToPermanentFailbackModeIfNeeded(state: FailbackSessionState) {
    if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
      if (!state.permanentFailbackMode) {
        state.permanentFailbackMode = true;
        logger.log(
          `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable`,
        );
      }
    }
  }

  private recordOriginalSourceFailure(
    reason: string,
    confirmedUnusable: boolean = false,
  ) {
    const state = getSessionState(this.config);

    if (state.permanentFailbackMode) {
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

  /**
   * Translate an attempt failure into origin health bookkeeping + quarantine.
   * Only the original request feeds the permanent-mode threshold; failback
   * hosts are quarantined only on definitive (non-censorship) failures.
   */
  private recordAttemptFailure(attempt: Attempt, kind: AttemptFailureKind) {
    // A browser-synthesized 206 is not evidence about the CDN itself.
    if (kind === 'partial') {
      return;
    }

    if (attempt.isOriginal) {
      const confirmedUnusable = kind === 'stall' || kind === 'integrity';
      this.recordOriginalSourceFailure(
        `Original source ${this.describeFailure(kind)}`,
        confirmedUnusable,
      );
      return;
    }

    // Failback hosts: only a definitive server-side failure (HTTP error)
    // quarantines the host. Silent/stall/network failures are treated as
    // likely-censorship and remain retryable (see reEnqueueOnSilence).
    if (kind === 'http') {
      this.quarantineFailbackHost(
        attempt.url,
        `Failback host ${this.describeFailure(kind)}`,
      );
    }
  }

  private describeFailure(kind: AttemptFailureKind): string {
    switch (kind) {
      case 'silent':
        return 'produced no response (blackholed)';
      case 'stall':
        return 'stalled mid-transfer';
      case 'http':
        return 'returned an HTTP error';
      case 'integrity':
        return 'returned an incomplete body';
      case 'partial':
        return 'returned an unexpected partial response';
      case 'network':
        return 'hit a network error';
    }
  }

  private isRetryableSilence(kind: AttemptFailureKind): boolean {
    // These failure modes match the observed TSPU/DPI behaviour and are worth
    // retrying on a fresh connection because the block is probabilistic.
    return kind === 'silent' || kind === 'stall' || kind === 'network';
  }

  private logAllFailed() {
    logger.log(
      `[FailbackLoader] ALL FAILED: no more candidates available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${this.launchedCount}`,
    );

    this.failbackConfig.onAllFailed?.(this.originalUrl, this.launchedCount);
  }

  /**
   * Compute the next candidate URL to launch, or null if exhausted.
   * Order: original (once, if allowed) → each failback host → queued
   * fresh-connection retries of silent hosts.
   */
  private dequeueCandidateUrl(): {
    url: string;
    isOriginal: boolean;
    failbackNumber: number;
  } | null {
    // 1. Original source (only the very first slot, and only when allowed).
    if (this.allowOriginal && !this.attemptedOriginalRequest) {
      this.attemptedOriginalRequest = true;
      if (!this.inFlightUrls.has(this.originalUrl)) {
        return { url: this.originalUrl, isOriginal: true, failbackNumber: 0 };
      }
    }

    // 2. Fresh failback hosts in order.
    while (this.nextFailbackIndex < MAX_FAILBACK_ATTEMPTS) {
      const index = this.nextFailbackIndex;
      const candidate = this.getFailbackUrl(index);
      if (!candidate) {
        this.nextFailbackIndex = MAX_FAILBACK_ATTEMPTS;
        break;
      }
      this.nextFailbackIndex = index + 1;

      if (candidate === this.originalUrl) {
        continue;
      }
      if (this.triedFailbackUrls.has(candidate)) {
        continue;
      }
      if (this.inFlightUrls.has(candidate)) {
        continue;
      }
      if (!this.isFailbackHostAvailable(candidate)) {
        continue;
      }
      this.triedFailbackUrls.add(candidate);
      this.failbackAttempt++;
      return {
        url: candidate,
        isOriginal: false,
        failbackNumber: this.failbackAttempt,
      };
    }

    // 3. Queued fresh-connection retries of hosts that went silent.
    // Walk the queue once: skip (and requeue) URLs still in flight so a busy
    // head entry cannot block a ready sibling behind it. Bound the walk to
    // the initial length to avoid spinning when every entry is still in flight.
    let pendingRemaining = this.pendingRetryUrls.length;
    while (pendingRemaining-- > 0) {
      const url = this.pendingRetryUrls.shift() as string;
      if (this.inFlightUrls.has(url)) {
        // Still trying it; requeue for a later pump so we don't spin.
        this.pendingRetryUrls.push(url);
        continue;
      }
      const isOriginal = url === this.originalUrl;
      if (!isOriginal && !this.isFailbackHostAvailable(url)) {
        continue;
      }
      const failbackNumber = isOriginal ? 0 : ++this.failbackAttempt;
      return { url, isOriginal, failbackNumber };
    }

    return null;
  }

  /**
   * Launch the next candidate attempt if one is available and we are under the
   * concurrency cap. Returns true if an attempt was started.
   */
  private launchNextAttempt(): boolean {
    if (this.finished) {
      return false;
    }
    if (this.attempts.size >= this.getMaxParallelAttempts()) {
      return false;
    }
    if (this.launchedCount >= MAX_TOTAL_ATTEMPTS_PER_LOAD) {
      return false;
    }

    const candidate = this.dequeueCandidateUrl();
    if (!candidate) {
      return false;
    }

    this.launchedCount++;

    if (!candidate.isOriginal) {
      this.failbackConfig.onFailback?.(
        this.originalUrl,
        candidate.url,
        candidate.failbackNumber,
      );
      logger.log(
        `[FailbackLoader] FAILBACK: trying host #${candidate.failbackNumber}: ${candidate.url}`,
      );
    }

    this.startAttempt(
      candidate.url,
      candidate.isOriginal,
      candidate.failbackNumber,
    );
    this.armHedgeTimer();
    return true;
  }

  /**
   * Arm the staggered-hedge timer: if no in-flight attempt has produced a first
   * byte by `hedgeDelayMs`, open the next candidate in parallel.
   */
  private armHedgeTimer() {
    if (this.hedgeTimer) {
      self.clearTimeout(this.hedgeTimer);
      this.hedgeTimer = undefined;
    }
    if (!this.isHedgeEnabled() || this.finished) {
      return;
    }
    if (this.attempts.size >= this.getMaxParallelAttempts()) {
      return;
    }

    this.hedgeTimer = self.setTimeout(() => {
      this.hedgeTimer = undefined;
      if (this.finished) {
        return;
      }
      // If any in-flight attempt is already receiving bytes, that connection is
      // promising — let it run and rely on its stall detection instead.
      if (this.hasProgressingAttempt()) {
        return;
      }
      if (this.launchNextAttempt()) {
        this.logVerbose(
          `[FailbackLoader] HEDGE: leading request silent for ${this.getHedgeDelayMs()}ms, opening parallel candidate`,
        );
      }
    }, this.getHedgeDelayMs());
  }

  private hasProgressingAttempt(): boolean {
    return Array.from(this.attempts).some(
      (attempt) => attempt.firstByteAt > 0 || attempt.loaded > 0,
    );
  }

  private startAttempt(
    url: string,
    isOriginal: boolean,
    failbackNumber: number,
  ) {
    const context = this.context;
    const config = this.loaderConfig;
    if (!context || !config) {
      return;
    }

    const xhr = new self.XMLHttpRequest();
    const now = self.performance.now();
    const attempt: Attempt = {
      xhr,
      url,
      isOriginal,
      failbackNumber,
      startTime: now,
      firstByteAt: 0,
      loaded: 0,
      lastProgressTime: now,
      lastSpeedCheckTime: now,
      lastSpeedCheckBytes: 0,
      lowSpeedDuration: 0,
      settled: false,
    };
    this.attempts.add(attempt);
    this.inFlightUrls.add(url);
    this.loader = xhr;

    this.logVerbose(
      `[FailbackLoader] LOADING: ${url}` +
        `\n  isOriginal: ${isOriginal}, failback#: ${failbackNumber}` +
        `\n  inFlight: ${this.attempts.size}`,
    );

    const xhrSetup = this.config.xhrSetup;
    if (xhrSetup) {
      const xhrContext = url !== context.url ? { ...context, url } : context;
      Promise.resolve()
        .then(() => {
          if (attempt.settled || this.finished) return;
          return xhrSetup(xhr, url, xhrContext);
        })
        .catch(() => {
          if (attempt.settled || this.finished) return;
          xhr.open('GET', url, true);
          return xhrSetup(xhr, url, xhrContext);
        })
        .then(() => {
          if (attempt.settled || this.finished) return;
          this.openAndSendXhr(attempt, context, url);
        })
        .catch((error) => {
          if (attempt.settled || this.finished) return;
          logger.warn(
            `[FailbackLoader] xhrSetup failed for ${url}: ${error?.message || error}`,
          );
          this.failAttempt(attempt, 'network', 'xhrSetup failed');
        });
      return;
    }

    this.openAndSendXhr(attempt, context, url);
  }

  private openAndSendXhr(
    attempt: Attempt,
    context: FragmentLoaderContext,
    url: string,
  ) {
    const xhr = attempt.xhr;
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

    if (this.failbackConfig.enableCacheControlHeader) {
      xhr.setRequestHeader('Cache-Control', 'no-store');
    }

    if (this.hasByteRange(context)) {
      xhr.setRequestHeader(
        'Range',
        'bytes=' + context.rangeStart + '-' + (context.rangeEnd! - 1),
      );
    }

    xhr.onreadystatechange = () => this.onReadyStateChange(attempt);
    xhr.onprogress = (event: ProgressEvent) => this.onProgress(attempt, event);
    xhr.onerror = () => this.failAttempt(attempt, 'network', 'Network error');

    attempt.startTime = self.performance.now();
    attempt.lastProgressTime = attempt.startTime;
    attempt.lastSpeedCheckTime = attempt.startTime;

    if (attempt.isOriginal && attempt.failbackNumber === 0) {
      this.stats.loading.start = attempt.startTime;
    }

    // Per-attempt overall load budget.
    const maxLoadTimeMs = this.loaderConfig?.loadPolicy.maxLoadTimeMs;
    if (maxLoadTimeMs && Number.isFinite(maxLoadTimeMs)) {
      attempt.loadTimeout = self.setTimeout(
        () => this.failAttempt(attempt, 'stall', 'Exceeded max load time'),
        maxLoadTimeMs,
      );
    }

    // Per-attempt monitor: fast blackhole + mid-transfer stall detection.
    attempt.monitorInterval = self.setInterval(
      () => this.monitorAttempt(attempt),
      STALL_CHECK_INTERVAL_MS,
    );

    xhr.send();
  }

  private monitorAttempt(attempt: Attempt) {
    if (attempt.settled || this.finished) {
      return;
    }
    const now = self.performance.now();

    // 1. Blackhole detection: no response headers/bytes at all.
    if (attempt.firstByteAt === 0) {
      if (now - attempt.startTime >= this.getFirstByteTimeoutMs()) {
        this.failAttempt(
          attempt,
          'silent',
          `No first byte within ${this.getFirstByteTimeoutMs()}ms`,
        );
      }
      return;
    }

    // 2. Strict silence after first byte.
    const dataStall = this.getDataStallTimeoutMs();
    if (now - attempt.lastProgressTime >= dataStall) {
      this.failAttempt(
        attempt,
        'stall',
        `No progress for ${(now - attempt.lastProgressTime).toFixed(0)}ms after first byte`,
      );
      return;
    }

    // 3. Throughput trickle detection (real elapsed time, not tick count).
    const dt = now - attempt.lastSpeedCheckTime;
    attempt.lastSpeedCheckTime = now;
    if (attempt.loaded > 0 && dt > 0) {
      const bytesDiff = attempt.loaded - attempt.lastSpeedCheckBytes;
      const bytesPerSec = bytesDiff / (dt / 1000);
      if (bytesPerSec < MIN_SPEED_BYTES_PER_SEC) {
        attempt.lowSpeedDuration += dt;
        if (attempt.lowSpeedDuration >= dataStall) {
          this.failAttempt(
            attempt,
            'stall',
            `Throughput ${bytesPerSec.toFixed(0)} B/s < ${MIN_SPEED_BYTES_PER_SEC} B/s for ${attempt.lowSpeedDuration.toFixed(0)}ms`,
          );
          return;
        }
      } else {
        attempt.lowSpeedDuration = 0;
      }
    }
    attempt.lastSpeedCheckBytes = attempt.loaded;
  }

  private onProgress(attempt: Attempt, event: ProgressEvent) {
    if (attempt.settled) {
      return;
    }
    attempt.loaded = event.loaded;
    attempt.lastProgressTime = self.performance.now();

    // Keep the reported stats tracking the most-advanced attempt so ABR sees
    // meaningful progress during hedged loads.
    if (event.loaded > this.stats.loaded) {
      this.stats.loaded = event.loaded;
      if (event.lengthComputable) {
        this.stats.total = event.total;
      }
    }
  }

  private onReadyStateChange(attempt: Attempt) {
    const { context, loaderConfig: config } = this;
    if (!context || !config || attempt.settled || this.finished) {
      return;
    }
    const xhr = attempt.xhr;

    if (xhr.readyState < 2) {
      return;
    }

    if (attempt.firstByteAt === 0) {
      attempt.firstByteAt = Math.max(self.performance.now(), attempt.startTime);
      attempt.lastProgressTime = attempt.firstByteAt;
      const ttfb = attempt.firstByteAt - attempt.startTime;
      const finalUrl = xhr.responseURL || attempt.url;

      this.logVerbose(
        `[FailbackLoader] RESPONSE HEADERS RECEIVED:` +
          `\n  status: ${xhr.status}` +
          `\n  ttfb: ${ttfb.toFixed(0)}ms` +
          `\n  requested: ${attempt.url}` +
          (finalUrl !== attempt.url ? `\n  redirected: ${finalUrl}` : ''),
      );

      // We have a promising connection — no need to keep hedging.
      if (this.hedgeTimer) {
        self.clearTimeout(this.hedgeTimer);
        this.hedgeTimer = undefined;
      }
    }

    if (xhr.readyState !== 4) {
      return;
    }

    const status = xhr.status;

    if (status >= 200 && status < 300) {
      const data = xhr.response;
      if (data != null) {
        const weRequestedRange = this.hasByteRange(context);
        // An application request without Range must never accept 206.
        if (status === 206 && !weRequestedRange) {
          this.handleUnexpectedRangeResponse(attempt);
          return;
        }

        const len =
          xhr.responseType === 'arraybuffer' ? data.byteLength : data.length;

        const integrityError = this.getResponseIntegrityError(
          xhr,
          context,
          status,
          len,
        );
        if (integrityError) {
          this.failAttempt(attempt, 'integrity', integrityError);
          return;
        }

        this.completeWithSuccess(attempt, data, len, status);
        return;
      }
    }

    // Non-2xx / empty body.
    this.failAttempt(attempt, 'http', `HTTP ${status} ${xhr.statusText}`, {
      code: status,
      text: xhr.statusText || `HTTP ${status}`,
    });
  }

  private completeWithSuccess(
    attempt: Attempt,
    data: any,
    len: number,
    status: number,
  ) {
    const { context } = this;
    if (!context) {
      return;
    }
    const state = getSessionState(this.config);
    const stats = this.stats;
    const xhr = attempt.xhr;

    // This attempt wins. Stop everything else.
    attempt.settled = true;
    this.finished = true;
    this.loader = xhr;
    // Detach the winner from the pool before aborting the losers so its own
    // teardown does not abort the (already complete) winning xhr.
    this.attempts.delete(attempt);
    this.inFlightUrls.delete(attempt.url);
    this.clearAttemptTimers(attempt);
    xhr.onreadystatechange = null;
    xhr.onprogress = null;
    xhr.onerror = null;
    this.abortInternal();

    stats.loading.first = Math.max(attempt.firstByteAt, stats.loading.start);
    stats.loading.end = Math.max(self.performance.now(), stats.loading.first);
    stats.loaded = stats.total = len;
    stats.bwEstimate =
      stats.loading.end > stats.loading.first
        ? (stats.total * 8000) / (stats.loading.end - stats.loading.first)
        : 0;

    this.callbacks?.onProgress?.(stats, context, data, xhr);

    this.failbackConfig.onSuccess?.(
      xhr.responseURL,
      !attempt.isOriginal,
      attempt.failbackNumber,
    );

    if (attempt.isOriginal && !state.permanentFailbackMode) {
      if (state.consecutiveOriginalFailures > 0) {
        logger.log(
          `[FailbackLoader] Original source recovered, resetting failure counter`,
        );
      }
      state.consecutiveOriginalFailures = 0;
    }

    // Store the freshest original URL for future recovery probes.
    if (this.requestOrder >= state.lastSuccessfulOriginalUrlOrder) {
      const wasNull = !state.lastSuccessfulOriginalUrl;
      state.lastSuccessfulOriginalUrl = this.originalUrl;
      state.lastSuccessfulOriginalLength = len;
      state.lastSuccessfulOriginalUrlOrder = this.requestOrder;
      if (wasNull) {
        logger.log(
          `[FailbackLoader] Stored original URL for recovery probes: ${this.originalUrl}`,
        );
      }
    }

    const downloadTime = stats.loading.end - stats.loading.start;
    const speedKBps = downloadTime > 0 ? len / 1024 / (downloadTime / 1000) : 0;

    if (state.permanentFailbackMode) {
      state.fragmentsSinceLastProbe++;
      this.logVerbose(
        `[FailbackLoader] SUCCESS (permanent failback): ${xhr.responseURL}` +
          `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms, speed: ${speedKBps.toFixed(1)}KB/s` +
          `\n  probe: [${state.fragmentsSinceLastProbe}/${PROBE_EVERY_N_FRAGMENTS}]`,
      );

      if (state.fragmentsSinceLastProbe >= PROBE_EVERY_N_FRAGMENTS) {
        state.fragmentsSinceLastProbe = 0;
        logger.log(
          `[FailbackLoader] Triggering CDN probe: ${state.lastSuccessfulOriginalUrl}`,
        );
        tryRecoverToOriginalCDN(this.config, context.headers);
      }
    } else if (!attempt.isOriginal) {
      logger.log(
        `[FailbackLoader] SUCCESS via failback #${attempt.failbackNumber}: ${xhr.responseURL}` +
          `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms, speed: ${speedKBps.toFixed(1)}KB/s`,
      );
    } else {
      this.logVerbose(
        `[FailbackLoader] SUCCESS (direct): ${xhr.responseURL}` +
          `\n  size: ${(len / 1024).toFixed(1)}KB, time: ${downloadTime.toFixed(0)}ms, speed: ${speedKBps.toFixed(1)}KB/s`,
      );
    }

    this.callbacks?.onSuccess?.(
      { url: xhr.responseURL, data, code: status },
      stats,
      context,
      xhr,
    );
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

  private handleUnexpectedRangeResponse(attempt: Attempt) {
    const contentRange = attempt.xhr.getResponseHeader('Content-Range');
    logger.log(
      `[FailbackLoader] UNEXPECTED PARTIAL RESPONSE:` +
        `\n  status: 206 Partial Content` +
        `\n  url: ${attempt.url}` +
        `\n  Content-Range: ${contentRange || '(not exposed to JavaScript)'}` +
        `\n  ACTION: Treating as a browser/cache error, will try failback`,
    );
    // Do not update origin health: the browser may have generated this from a
    // poisoned cache without the request reaching the CDN.
    this.failAttempt(attempt, 'partial', 'Unexpected Partial Content response');
  }

  /**
   * A single attempt failed. Record health, optionally requeue for a fresh
   * connection, then advance to the next candidate or finish the load.
   */
  private isDefinitiveFailureKind(kind: AttemptFailureKind | null): boolean {
    return kind === 'http' || kind === 'integrity';
  }

  /**
   * Record the failure used when the load finally exhausts. Prefer an explicit
   * HTTP/integrity error over a later soft failure (silent/stall/network), and
   * keep `lastFailureXhr` pointed at the XHR that produced the retained error so
   * onError/onTimeout receive the matching networkDetails — not the last hedge
   * (this.loader is overwritten by each startAttempt).
   */
  private recordExhaustionFailure(
    attempt: Attempt,
    kind: AttemptFailureKind,
    reason: string,
    httpError?: { code: number; text: string },
  ) {
    if (
      this.isDefinitiveFailureKind(this.lastFailureKind) &&
      !this.isDefinitiveFailureKind(kind)
    ) {
      return;
    }

    this.lastFailureKind = kind;
    this.lastFailureXhr = attempt.xhr;
    if (httpError) {
      this.lastErrorCode = httpError.code;
      this.lastErrorText = httpError.text;
    } else if (kind !== 'partial') {
      this.lastErrorCode = 0;
      this.lastErrorText = reason;
    }
  }

  private failAttempt(
    attempt: Attempt,
    kind: AttemptFailureKind,
    reason: string,
    httpError?: { code: number; text: string },
  ) {
    if (attempt.settled || this.finished) {
      return;
    }
    attempt.settled = true;

    this.recordExhaustionFailure(attempt, kind, reason, httpError);

    const state = getSessionState(this.config);
    const elapsed = (self.performance.now() - attempt.startTime).toFixed(0);
    logger.log(
      `[FailbackLoader] ATTEMPT FAILED (${kind}):` +
        `\n  url: ${attempt.url}` +
        `\n  isOriginal: ${attempt.isOriginal}, failback#: ${attempt.failbackNumber}` +
        `\n  reason: ${reason}` +
        `\n  elapsed: ${elapsed}ms, loaded: ${attempt.loaded} bytes` +
        `\n  state: failures=${state.consecutiveOriginalFailures}, permanentMode=${state.permanentFailbackMode}`,
    );

    this.teardownAttempt(attempt, true);
    this.recordAttemptFailure(attempt, kind);

    // Retry silent/blackholed hosts on a fresh connection (probabilistic block).
    if (this.isRetryableSilence(kind)) {
      this.maybeRequeueForRetry(attempt.url);
    }

    // Advance: fill the freed concurrency slot immediately.
    this.pump();
  }

  private maybeRequeueForRetry(url: string) {
    const maxRetries = this.getSilentRetriesPerHost();
    if (maxRetries <= 0) {
      return;
    }
    const used = this.silentRetryBudget.get(url) ?? 0;
    if (used >= maxRetries) {
      return;
    }
    this.silentRetryBudget.set(url, used + 1);
    this.pendingRetryUrls.push(url);
    this.logVerbose(
      `[FailbackLoader] Requeued silent host for fresh-connection retry: ${url} (${used + 1}/${maxRetries})`,
    );
  }

  /**
   * Keep launching candidates until the concurrency cap is hit or nothing is
   * launchable. If nothing is in flight and nothing can be launched, the load
   * has failed.
   */
  private pump() {
    if (this.finished) {
      return;
    }

    let launchedAny = false;
    while (this.launchNextAttempt()) {
      launchedAny = true;
    }

    if (this.attempts.size > 0) {
      // Still waiting on in-flight attempts. Re-arm hedge if idle.
      if (!launchedAny && !this.hedgeTimer) {
        this.armHedgeTimer();
      }
      return;
    }

    // Nothing in flight and nothing launchable → exhausted.
    this.completeExhausted();
  }

  private completeExhausted() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.abortInternal();
    this.logAllFailed();

    // A definitive server-side failure (HTTP error / incomplete body) is
    // reported as an error; a silent blackhole / stall / network outage is
    // reported as a timeout, matching transport semantics so hls.js applies
    // its timeout retry policy. lastFailureKind is sticky for http/integrity
    // (see recordExhaustionFailure), so a later hedge timeout cannot mask them.
    const isHttpFailure = this.isDefinitiveFailureKind(this.lastFailureKind);

    // Prefer the XHR that produced the retained failure classification over
    // this.loader (which may point at the last launched hedge attempt).
    const networkDetails = this.lastFailureXhr || this.loader;

    if (isHttpFailure) {
      this.callbacks?.onError?.(
        { code: this.lastErrorCode, text: this.lastErrorText },
        this.context as FragmentLoaderContext,
        networkDetails,
        this.stats,
      );
    } else {
      this.callbacks?.onTimeout?.(
        this.stats,
        this.context as FragmentLoaderContext,
        networkDetails,
      );
    }
  }

  private completeNoHealthyFailbackHosts() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.logAllFailed();
    this.callbacks?.onError?.(
      { code: 0, text: 'No healthy failback hosts available' },
      this.context as FragmentLoaderContext,
      this.loader,
      this.stats,
    );
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
