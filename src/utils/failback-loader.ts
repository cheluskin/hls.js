import { setDohProviders } from './dns-txt-resolver';
import { getRetryDelay, shouldRetry } from './error-helper';
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
import { LoaderContextType } from '../types/loader';
import type { HlsConfig } from '../config';
import type {
  FragmentLoaderContext,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats,
} from '../types/loader';

// ============================================
// FAILBACK STATE ISOLATION
// State is stored per HlsConfig instance to support multiple players on one page
// ============================================

/**
 * Which kind of resource a loader instance serves. Fragments and playlists keep
 * separate origin-health bookkeeping (the playlist origin and the segment CDN
 * are frequently different hosts), but share what is known about the
 * reachability of the failback hosts themselves.
 */
type FailbackScope = 'fragment' | 'playlist';

interface HostHealth {
  // performance.now() of the last complete, valid response from this host.
  lastSuccessAt: number;
  // performance.now() of the last silent/stalled attempt (0 = none).
  lastFrozenAt: number;
  // Consecutive frozen attempts without a success in between. Drives the
  // exponential de-prioritisation window.
  frozenCount: number;
}

interface PlaylistScopeState {
  consecutiveOriginalFailures: number;
}

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
  // Reachability of individual hosts (keyed by URL origin), shared by the
  // fragment and playlist scopes.
  hostHealth: Map<string, HostHealth>;
  // Smoothed time-to-response-headers of attempts that did answer. Used to
  // stretch hedge / silence budgets on slow (but healthy) mobile links.
  ttfbEstimateMs: number;
  playlist: PlaylistScopeState;
}

const failbackStates = new WeakMap<HlsConfig, FailbackSessionState>();

// Number of ordinary consecutive failures on original CDN before switching to
// permanent failback. A confirmed incomplete transfer switches immediately.
// We use 2 for transient issues. The 206 detection handles browser Range
// requests from cached partial data.
// Permanent failback is only entered once a failback host actually delivered
// the object the origin failed on: when *every* host fails (device offline,
// radio handover, total blackout) there is no evidence that the backups are
// better, and a healthy user must not be pinned to them.
const PERMANENT_FAILBACK_THRESHOLD = 2;
const PROBE_EVERY_N_FRAGMENTS = 6;
const PROBE_TIMEOUT_MS = 5000;

// --- Censorship-resilience tuning (defaults, overridable via FailbackConfig) ---
//
// TSPU/DPI blocking observed in the wild (Chrome net-export logs from Android)
// lets TCP and the TLS handshake complete, lets the server send only a few KB
// (handshake, SETTINGS, sometimes response headers and ~1.3KB of body), then
// silently drops every further server packet. No RST is sent: the connection
// stays "open" but silent. A healthy CDN returns response headers in well under
// a second, so a much shorter budget than the transport timeout lets us start
// alternatives quickly instead of waiting the full maxTimeToFirstByte.
//
// Reaching this budget marks the attempt as *suspect* and opens alternatives,
// but the request itself is kept until the transport `maxTimeToFirstByteMs`
// (or until its concurrency slot is needed): on a slow but healthy mobile link
// the origin may still answer, and aborting it would only throw that away.
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
// Extra same-URL retries within one load. They are only used after a
// connection-level failure (reset / closed / stall), never after pure silence:
// Chrome keeps a blackholed HTTP/2 or QUIC session in its pool (aborting the
// XHR only cancels the stream), so an immediate retry of a silent host is sent
// into the very same frozen connection and cannot succeed.
const DEFAULT_SILENT_RETRIES_PER_HOST = 2;

const STALL_CHECK_INTERVAL_MS = 500;
const MIN_SPEED_BYTES_PER_SEC = 4096;
const DEFAULT_FAILBACK_HOST_COOLDOWN_MS = 30000;

// Hard ceiling on waiting for response headers when the transport policy has
// no finite `maxTimeToFirstByteMs` (the manifest policy uses Infinity).
const DEFAULT_HARD_FIRST_BYTE_TIMEOUT_MS = 10000;
// A response that streamed this much has left the few-KB window a TSPU leaks
// before blackholing (observed 2-4KB, classic reports 16-20KB). Once the
// preferred attempt got this far, parallel "insurance" requests are cancelled
// so slow-but-healthy links do not download every hedged segment twice.
const PROVEN_TRANSFER_BYTES = 64 * 1024;
// A host whose connection went silent/stalled is tried after the others for
// this long (doubling per consecutive freeze). Chrome only drops a frozen
// HTTP/2 session after a PING timeout (~20s) and a QUIC session after its idle
// timeout, so every request to that host in the meantime is wasted.
const FROZEN_HOST_PENALTY_MS = 30000;
const FROZEN_HOST_PENALTY_MAX_MS = 5 * 60 * 1000;
// A monitor tick arriving this late means timers were suspended (background
// tab, Android app switch, frozen renderer). The gap says nothing about the
// network, so silence/stall budgets are not charged for it.
const TIMER_GAP_TOLERANCE_MS = 2000;
// Adaptive budgets derived from the observed time-to-headers. Samples are
// clipped so a single outlier cannot push hedging out for many fragments
// (3s covers a cold TLS connection plus a redirect on a slow 3G link).
const TTFB_EWMA_WEIGHT = 0.3;
const TTFB_SAMPLE_MAX_MS = 3000;
const HEDGE_DELAY_TTFB_FACTOR = 2;
const FIRST_BYTE_TTFB_FACTOR = 3;

function isHttpClientError(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Read a response header without tripping CORS: Chrome logs "Refused to get
 * unsafe header" for every getResponseHeader() call on a header the server
 * did not expose (Content-Encoding, Content-Range, Age on most CDNs), which
 * would fire on every fragment. getAllResponseHeaders() only lists exposed
 * headers. Some browsers throw InvalidStateError when called too early.
 */
function getExposedResponseHeader(
  xhr: XMLHttpRequest,
  name: string,
): string | null {
  try {
    if (typeof xhr.getAllResponseHeaders !== 'function') {
      return xhr.getResponseHeader(name) || null;
    }
    const all = xhr.getAllResponseHeaders();
    if (!all) {
      return null;
    }
    const wanted = name.toLowerCase();
    const lines = all.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const separator = line.indexOf(':');
      if (
        separator > 0 &&
        line.slice(0, separator).trim().toLowerCase() === wanted
      ) {
        return line.slice(separator + 1).trim();
      }
    }
  } catch {
    // Header not available in this XHR state.
  }
  return null;
}

/**
 * Size of a response body as counted by Content-Length (bytes on the wire),
 * or -1 when it cannot be determined. Text bodies are UTF-16 in JS, so their
 * `length` is not comparable to Content-Length for non-ASCII playlists.
 */
function getWireLength(data: any): number {
  if (typeof data === 'string') {
    if (typeof TextEncoder === 'undefined') {
      return -1;
    }
    return new TextEncoder().encode(data).length;
  }
  if (data && typeof data.byteLength === 'number') {
    return data.byteLength;
  }
  return -1;
}

function getScopeForContext(context: LoaderContext): FailbackScope {
  switch (context.type) {
    case LoaderContextType.MANIFEST:
    case LoaderContextType.LEVEL:
    case LoaderContextType.AUDIO_TRACK:
    case LoaderContextType.SUBTITLE_TRACK:
      return 'playlist';
    default:
      return 'fragment';
  }
}

/**
 * True only when the browser positively reports that there is no network.
 * Failures in that state say nothing about any CDN.
 */
function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function getHostKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

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
      hostHealth: new Map(),
      ttfbEstimateMs: 0,
      playlist: { consecutiveOriginalFailures: 0 },
    };
    failbackStates.set(config, state);
  }
  return state;
}

function getHostHealth(state: FailbackSessionState, url: string): HostHealth {
  const key = getHostKey(url);
  let health = state.hostHealth.get(key);
  if (!health) {
    health = { lastSuccessAt: 0, lastFrozenAt: 0, frozenCount: 0 };
    state.hostHealth.set(key, health);
  }
  return health;
}

/**
 * Remaining de-prioritisation of a host whose connection recently froze, or 0
 * when the host may be used in its normal order.
 */
function getFrozenPenaltyRemaining(
  state: FailbackSessionState,
  url: string,
  now: number,
): number {
  const health = state.hostHealth.get(getHostKey(url));
  if (
    !health?.lastFrozenAt ||
    health.frozenCount === 0 ||
    health.lastSuccessAt > health.lastFrozenAt
  ) {
    return 0;
  }
  const penalty = Math.min(
    FROZEN_HOST_PENALTY_MS * Math.pow(2, health.frozenCount - 1),
    FROZEN_HOST_PENALTY_MAX_MS,
  );
  return Math.max(0, health.lastFrozenAt + penalty - now);
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
  state.hostHealth.forEach((health) => {
    health.lastFrozenAt = 0;
    health.frozenCount = 0;
  });
  state.playlist.consecutiveOriginalFailures = 0;

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
  // blackholing a response, so it validates the tail of the last segment
  // (never the first bytes a middlebox lets through). A segment shorter than
  // the probe is validated completely: asking for bytes past its end would make
  // the server answer with fewer bytes than requested and the probe could
  // never succeed.
  const probeLength = RECOVERY_PROBE_MAX_BYTES;
  const hasKnownLength = typeof knownLength === 'number' && knownLength > 0;
  const probeStart =
    hasKnownLength && knownLength > probeLength ? knownLength - probeLength : 0;
  const probeEnd = hasKnownLength
    ? Math.min(probeStart + probeLength, knownLength)
    : probeStart + probeLength;

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
      // loadSource()/destroyFailbackState() may have replaced this session
      // while the probe was in flight. Ignore the stale callback.
      if (failbackStates.get(config) !== state) {
        return;
      }

      state.isProbeInProgress = false;
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
      if (failbackStates.get(config) !== state) {
        return;
      }
      state.isProbeInProgress = false;
      logger.log('[FailbackLoader] ✗ Original CDN probe failed');
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
   * is still silent (no response headers). Stretched automatically on links
   * whose observed time-to-headers is slow. Default: 1200ms.
   */
  hedgeDelayMs?: number;
  /**
   * Soft blackhole budget: an attempt without response headers after this
   * long is treated as blackholed (its host is de-prioritised, alternatives
   * are opened, a completed backup is no longer held back for it), but it is
   * only aborted at the transport `maxTimeToFirstByteMs` or when its slot is
   * needed. Stretched automatically on slow links. Default: 2500ms.
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
   * How many extra same-URL retries each host gets within a single load after
   * a connection-level failure (reset/closed) or a mid-transfer stall. Silent
   * hosts are not retried within the load: the browser would reuse their
   * frozen HTTP/2 or QUIC connection. HTTP errors are never retried on the same
   * host. Default: 2.
   */
  silentRetriesPerHost?: number;
  /**
   * Also apply failback (and blackhole/stall detection) to playlist requests
   * (multivariant, media and rendition playlists) when no custom `pLoader` or
   * `loader` is configured. The failback hosts must serve playlists under the
   * same path. Default: true.
   */
  playlistFailback?: boolean;
  /**
   * Override the process-wide DNS-over-HTTPS provider list used to resolve
   * failback hosts. Empty/omitted keeps the built-in defaults (Google,
   * Cloudflare, Quad9, AliDNS).
   */
  dohProviders?: string[];
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

interface Candidate {
  url: string;
  isOriginal: boolean;
  failbackNumber: number;
  isRetry: boolean;
}

interface Attempt {
  xhr: XMLHttpRequest;
  url: string;
  isOriginal: boolean;
  failbackNumber: number; // 0 for original, >=1 for failback hosts
  // Same-URL retry after a connection-level failure. Retries do not get the
  // extended silence budget: the host already failed once in this load.
  isRetry: boolean;
  startTime: number;
  // Reference point for the silence budgets. Shifted forward when timers were
  // suspended, so a background freeze is not mistaken for a network stall.
  waitStart: number;
  lastMonitorAt: number;
  firstByteAt: number; // 0 until response headers arrive
  loaded: number;
  total: number;
  lastProgressTime: number;
  lastSpeedCheckTime: number;
  lastSpeedCheckBytes: number;
  lowSpeedDuration: number;
  // No response headers within the soft budget: alternatives were opened, the
  // request is only kept in case it is merely slow.
  suspect: boolean;
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
  private scope: FailbackScope = 'fragment';
  // Playlist scope only: the origin is known to fail, so it is raced against
  // the best backup from the start instead of being given a head start.
  private raceOriginal: boolean = false;
  // Load-level retries driven by loadPolicy.timeoutRetry / errorRetry (only
  // the manifest policy carries them; fragment policies are passed without).
  private loadRetryTimer?: number;

  // Candidate scheduling
  private allowOriginal: boolean = true;
  // Candidate URL per index for this load (undefined = transform threw), so a
  // user transformUrl is evaluated exactly once per index even though ranking
  // may look at the list several times.
  private candidateCache: Map<number, string | null | undefined> = new Map();
  private pendingRetryUrls: string[] = [];
  private silentRetryBudget: Map<string, number> = new Map();
  private launchedCount: number = 0;
  private failbackAttempt: number = 0;
  private triedFailbackUrls: Set<string> = new Set();
  // After every healthy backup is quarantined, walk the list once more
  // ignoring cooldown so a load is never left with zero candidates.
  private quarantineBypassStarted: boolean = false;

  // In-flight attempts (parallel hedging)
  private attempts: Set<Attempt> = new Set();
  private inFlightUrls: Set<string> = new Set();
  private hedgeTimer?: number;
  // Failback response held while the original is still allowed to win.
  // Primary CDN keeps priority even when a hedged backup finishes first.
  private parkedSuccess: {
    attempt: Attempt;
    data: any;
    len: number;
    status: number;
  } | null = null;

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
      playlistFailback: userConfig.playlistFailback,
      dohProviders: userConfig.dohProviders,
    };

    if (userConfig.dohProviders && userConfig.dohProviders.length > 0) {
      setDohProviders(userConfig.dohProviders);
    }

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
    return (
      this.failbackConfig.hedge !== false && !this.isBlockingPlaylistRequest()
    );
  }

  /**
   * LL-HLS blocking playlist reload (`_HLS_msn` / `_HLS_part`): the server
   * deliberately holds the response until the requested part exists, so
   * silence is expected and must not be read as a blackhole.
   */
  private isBlockingPlaylistRequest(): boolean {
    const context = this.context as
      | (LoaderContext & { deliveryDirectives?: unknown })
      | null;
    return this.scope === 'playlist' && !!context?.deliveryDirectives;
  }

  /**
   * Smoothed time-to-headers observed in this session (0 = unknown). Budgets
   * below never drop under their configured values; they only stretch when the
   * link is demonstrably slow, so a healthy slow link is not treated as a
   * blackhole and hedged/abandoned on every request.
   */
  private getTtfbEstimateMs(): number {
    return getSessionState(this.config).ttfbEstimateMs;
  }

  private sampleTtfb(ttfbMs: number) {
    if (!(ttfbMs >= 0) || !Number.isFinite(ttfbMs)) {
      return;
    }
    const state = getSessionState(this.config);
    const sample = Math.min(ttfbMs, TTFB_SAMPLE_MAX_MS);
    state.ttfbEstimateMs = state.ttfbEstimateMs
      ? state.ttfbEstimateMs * (1 - TTFB_EWMA_WEIGHT) +
        sample * TTFB_EWMA_WEIGHT
      : sample;
  }

  private getHedgeDelayMs(): number {
    const value = this.failbackConfig.hedgeDelayMs;
    const configured =
      Number.isFinite(value) && value! >= 0 ? value! : DEFAULT_HEDGE_DELAY_MS;
    const adaptive = Math.max(
      configured,
      this.getTtfbEstimateMs() * HEDGE_DELAY_TTFB_FACTOR,
    );
    // Never hedge later than the point where the attempt counts as silent.
    return Math.min(adaptive, this.getFirstByteTimeoutMs());
  }

  /**
   * Soft silence budget: with no response headers by then, the attempt is
   * treated as blackholed for scheduling purposes (alternatives are opened,
   * the host is de-prioritised) but it is not aborted yet.
   */
  private getFirstByteTimeoutMs(): number {
    if (this.isBlockingPlaylistRequest()) {
      return this.getHardFirstByteTimeoutMs();
    }
    const value = this.failbackConfig.firstByteTimeoutMs;
    const configured =
      Number.isFinite(value) && value! > 0
        ? value!
        : DEFAULT_FIRST_BYTE_TIMEOUT_MS;
    const adaptive = Math.max(
      configured,
      this.getTtfbEstimateMs() * FIRST_BYTE_TTFB_FACTOR,
    );
    // Never wait longer than the transport's own first-byte budget.
    return Math.min(adaptive, this.getHardFirstByteTimeoutMs());
  }

  /**
   * Hard silence budget: the attempt is aborted when no response headers
   * arrived by then. This is the transport's own `maxTimeToFirstByteMs`.
   */
  private getHardFirstByteTimeoutMs(): number {
    const ttfb = this.loaderConfig?.loadPolicy.maxTimeToFirstByteMs;
    if (ttfb && Number.isFinite(ttfb) && ttfb > 0) {
      return ttfb;
    }
    const maxLoad = this.loaderConfig?.loadPolicy.maxLoadTimeMs;
    if (maxLoad && Number.isFinite(maxLoad) && maxLoad > 0) {
      return Math.min(maxLoad, DEFAULT_HARD_FIRST_BYTE_TIMEOUT_MS);
    }
    return DEFAULT_HARD_FIRST_BYTE_TIMEOUT_MS;
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
    if (this.loadRetryTimer) {
      self.clearTimeout(this.loadRetryTimer);
      this.loadRetryTimer = undefined;
    }
    Array.from(this.attempts).forEach((attempt) => {
      this.teardownAttempt(attempt, true);
    });
    this.attempts.clear();
    this.inFlightUrls.clear();
    this.parkedSuccess = null;
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
    // Keep the stats object created in the constructor (as BaseLoader does):
    // FragmentLoader binds `frag.stats = loader.stats` and copies `retry`
    // before calling load(). Replacing it here left ABR reading an all-zero
    // object, so every bandwidth sample was 0 bytes.
    this.stats.loading.start = self.performance.now();
    this.context = context;
    this.callbacks = callbacks;
    this.loaderConfig = config;
    this.originalUrl = context.url;
    this.scope = getScopeForContext(context);
    this.startLoadCycle();
  }

  /**
   * One pass over the candidates (origin, backups, same-host retries). A load
   * normally runs a single cycle; policies with timeoutRetry / errorRetry
   * (manifest) may run more, like XhrLoader's own retries.
   */
  private startLoadCycle() {
    const context = this.context;
    if (!context) {
      return;
    }
    this.attemptedOriginalRequest = false;
    this.finished = false;
    this.stats.loading.first = 0;
    this.stats.loaded = 0;
    this.stats.total = 0;
    this.stats.aborted = false;

    this.candidateCache.clear();
    this.pendingRetryUrls = [];
    this.silentRetryBudget.clear();
    this.launchedCount = 0;
    this.failbackAttempt = 0;
    this.triedFailbackUrls.clear();
    this.quarantineBypassStarted = false;
    this.attempts.clear();
    this.inFlightUrls.clear();
    this.parkedSuccess = null;
    this.lastFailureKind = null;
    this.lastFailureXhr = null;
    this.lastErrorCode = 0;
    this.lastErrorText = 'Network error';

    const state = getSessionState(this.config);
    this.requestOrder = ++state.nextRequestOrder;
    if (this.scope === 'playlist') {
      // Playlists are small and never skip the origin: once it is known to
      // fail, it simply races the best backup instead of getting a head start.
      this.allowOriginal = true;
      this.raceOriginal =
        state.playlist.consecutiveOriginalFailures >=
        PERMANENT_FAILBACK_THRESHOLD;
    } else {
      this.allowOriginal = !state.permanentFailbackMode;
      this.raceOriginal = false;
    }

    const hosts = this.getHosts();

    // Per-fragment start log is verbose by default — only critical transitions
    // (permanent mode switch, failback, errors) log unconditionally.
    this.logVerbose(
      `[FailbackLoader] LOAD START (${this.scope}): ${context.url}` +
        `\n  state: failures=${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD}, permanentMode=${state.permanentFailbackMode}` +
        `\n  hosts: [${hosts.join(', ')}]` +
        `\n  config: hedge=${this.isHedgeEnabled()}, hedgeDelay=${this.getHedgeDelayMs()}ms, firstByte=${this.getFirstByteTimeoutMs()}/${this.getHardFirstByteTimeoutMs()}ms, dataStall=${this.getDataStallTimeoutMs()}ms, maxParallel=${this.getMaxParallelAttempts()}`,
    );

    if (this.scope === 'fragment' && state.permanentFailbackMode) {
      logger.log(
        `[FailbackLoader] PERMANENT FAILBACK MODE - skipping original`,
      );
    }

    // Kick off the first attempt. Hedging / retries schedule the rest.
    if (!this.launchNextAttempt()) {
      this.completeNoHealthyFailbackHosts();
      return;
    }
    if (this.raceOriginal) {
      // Known-bad playlist origin: start the best backup right away.
      this.launchNextAttempt();
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
    return getHostKey(url);
  }

  /**
   * Record that a host produced a complete, valid response. Clears any
   * frozen-connection de-prioritisation for it.
   */
  private markHostSuccess(url: string) {
    const health = getHostHealth(getSessionState(this.config), url);
    health.lastSuccessAt = self.performance.now();
    health.frozenCount = 0;
  }

  /**
   * Record that a host went silent or stalled mid-transfer. Its connection is
   * most likely blackholed and Chrome will keep reusing it for a while, so the
   * host is tried after the others (it is never excluded: with no alternative
   * it is still used).
   */
  private markHostFrozen(url: string) {
    if (isBrowserOffline()) {
      return;
    }
    const health = getHostHealth(getSessionState(this.config), url);
    const now = self.performance.now();
    // One freeze per host per load is enough evidence; parallel attempts or
    // concurrent loaders (audio + video) hitting the same frozen host at once
    // must not escalate the penalty several steps in one go.
    const alreadyCounted =
      health.lastFrozenAt > 0 &&
      (health.lastFrozenAt >= this.stats.loading.start ||
        now - health.lastFrozenAt < 1000);
    health.lastFrozenAt = now;
    if (!alreadyCounted) {
      health.frozenCount = Math.min(health.frozenCount + 1, 16);
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

  /**
   * Enter permanent failback. Only called once a failback host delivered the
   * object the origin failed on, so the switch always moves playback to a
   * source that is known to work right now.
   */
  private switchToPermanentFailbackModeIfNeeded(state: FailbackSessionState) {
    if (this.scope !== 'fragment') {
      return;
    }
    if (state.consecutiveOriginalFailures >= PERMANENT_FAILBACK_THRESHOLD) {
      if (!state.permanentFailbackMode) {
        state.permanentFailbackMode = true;
        logger.log(
          `[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable, failback host delivered`,
        );
      }
    }
  }

  private recordOriginalSourceFailure(
    reason: string,
    confirmedUnusable: boolean = false,
  ) {
    const state = getSessionState(this.config);

    if (this.scope === 'playlist') {
      const playlistState = state.playlist;
      playlistState.consecutiveOriginalFailures = confirmedUnusable
        ? PERMANENT_FAILBACK_THRESHOLD
        : playlistState.consecutiveOriginalFailures + 1;
      logger.log(
        `[FailbackLoader] Playlist ${reason.charAt(0).toLowerCase()}${reason.slice(1)} (${playlistState.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})`,
      );
      return;
    }

    if (state.permanentFailbackMode) {
      return;
    }

    // A response that starts and then stalls or truncates is conclusively
    // unusable for playback. Do not spend another fragment on the same CDN.
    // Ordinary transport failures retain the two-failure threshold. The actual
    // switch waits until a failback host has delivered (completeWithSuccess).
    state.consecutiveOriginalFailures = confirmedUnusable
      ? state.threshold
      : state.consecutiveOriginalFailures + 1;
    logger.log(
      `[FailbackLoader] ${reason} (${state.consecutiveOriginalFailures}/${PERMANENT_FAILBACK_THRESHOLD})${confirmedUnusable ? ' - switching as soon as a failback host delivers' : ''}`,
    );
  }

  /**
   * Translate an attempt failure into origin health bookkeeping + quarantine.
   * Only the original request feeds the permanent-mode threshold; failback
   * hosts are quarantined only on definitive (non-censorship) failures.
   */
  private recordAttemptFailure(
    attempt: Attempt,
    kind: AttemptFailureKind,
    options?: { confirmedUnusable?: boolean; httpStatus?: number },
  ) {
    // A browser-synthesized 206 is not evidence about the CDN itself.
    if (kind === 'partial') {
      return;
    }

    // With no network at all every host fails the same way. Nothing can be
    // learned about any CDN, and counting it would move a healthy user to the
    // backups as soon as the connection is back.
    if (isBrowserOffline()) {
      this.logVerbose(
        `[FailbackLoader] Browser is offline - not counting ${kind} failure of ${attempt.url}`,
      );
      return;
    }

    if (kind === 'silent' || kind === 'stall') {
      this.markHostFrozen(attempt.url);
    }

    if (attempt.isOriginal) {
      // A 4xx is about this object (missing segment, expired token), not the
      // CDN. Still failback the current request, but do not send the rest of
      // the session to backup.
      if (isHttpClientError(options?.httpStatus)) {
        return;
      }

      // Stall is a confirmed mid-transfer break. Integrity is immediately
      // unusable for Range mismatches we issued and for an identity body
      // shorter than Content-Length (finished truncated transfer). A body
      // longer than Content-Length is hidden gzip and never reaches here.
      const confirmedUnusable =
        kind === 'stall' ||
        (kind === 'integrity' && options?.confirmedUnusable === true);
      this.recordOriginalSourceFailure(
        `Original source ${this.describeFailure(kind)}`,
        confirmedUnusable,
      );
      return;
    }

    // Failback hosts: only a definitive server-side failure (HTTP error)
    // quarantines the host. Silent/stall/network failures are treated as
    // likely-censorship and remain retryable (see maybeRequeueForRetry).
    // Playlist errors never quarantine: a mirror that does not carry a
    // playlist (404) can still serve every segment.
    if (kind === 'http' && this.scope === 'fragment') {
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

  /**
   * Whether the same URL may be retried later in this load. Only failures that
   * end the underlying connection qualify (reset/closed, or a stall after
   * which the retry is a last resort): a *silent* attempt means the host's
   * HTTP/2 or QUIC session is blackholed, and Chrome sends a retry into that
   * very session (aborting the XHR only cancels the stream), so it cannot
   * succeed until Chrome tears the session down 20s+ later.
   */
  private isRetryableFailure(kind: AttemptFailureKind): boolean {
    return kind === 'stall' || kind === 'network';
  }

  private logAllFailed() {
    logger.log(
      `[FailbackLoader] ALL FAILED: no more candidates available` +
        `\n  original: ${this.originalUrl}` +
        `\n  attempts: ${this.launchedCount}`,
    );

    this.invokeFailbackHook(
      'onAllFailed',
      this.failbackConfig.onAllFailed,
      this.originalUrl,
      this.launchedCount,
    );
  }

  /**
   * Invoke a user-supplied failbackConfig hook without letting exceptions
   * interrupt the loader's success/error completion path.
   */
  private invokeFailbackHook(
    name: string,
    hook: ((...args: any[]) => void) | undefined,
    ...args: any[]
  ) {
    if (!hook) {
      return;
    }
    try {
      hook(...args);
    } catch (error: any) {
      logger.warn(
        `[FailbackLoader] ${name} callback threw: ${error?.message || error}`,
      );
    }
  }

  /**
   * Candidate URL at `index`: a URL, `null` at the end of the list, or
   * `undefined` when this index must be skipped (the transform threw).
   * transformUrl results are cached per load so each index is evaluated once.
   */
  private getCandidateAt(index: number): string | null | undefined {
    const cacheable = !!this.failbackConfig.transformUrl;
    if (cacheable && this.candidateCache.has(index)) {
      return this.candidateCache.get(index);
    }
    let candidate: string | null | undefined;
    try {
      candidate = this.getFailbackUrl(index) || null;
    } catch (error: any) {
      logger.warn(
        `[FailbackLoader] getFailbackUrl/transformUrl threw at index ${index}: ${error?.message || error}`,
      );
      candidate = undefined;
    }
    if (cacheable) {
      this.candidateCache.set(index, candidate);
    }
    return candidate;
  }

  /**
   * Pick the next failback host. Hosts keep their configured (GeoDNS) order,
   * except that a host whose connection recently froze is moved behind every
   * host that did not: Chrome keeps sending requests into a blackholed HTTP/2
   * or QUIC session until it tears it down, so trying it first again would
   * waste a full silence budget on every fragment. Among frozen hosts, the one
   * whose penalty expires first goes first. When `ignoreQuarantine` is set,
   * hosts that were skipped for an HTTP-error cooldown become eligible so a
   * load is never left empty.
   */
  private nextFailbackCandidate(ignoreQuarantine: boolean): {
    url: string;
    isOriginal: boolean;
    failbackNumber: number;
  } | null {
    const state = getSessionState(this.config);
    const now = self.performance.now();
    let best: string | null = null;
    let bestPenalty = Infinity;

    for (let index = 0; index < MAX_FAILBACK_ATTEMPTS; index++) {
      const candidate = this.getCandidateAt(index);
      if (candidate === null) {
        break;
      }
      if (candidate === undefined) {
        continue;
      }
      if (candidate === this.originalUrl) {
        continue;
      }
      if (this.triedFailbackUrls.has(candidate)) {
        continue;
      }
      if (this.inFlightUrls.has(candidate)) {
        continue;
      }
      if (!ignoreQuarantine && !this.isFailbackHostAvailable(candidate)) {
        continue;
      }
      const penalty = getFrozenPenaltyRemaining(state, candidate, now);
      if (penalty < bestPenalty) {
        best = candidate;
        bestPenalty = penalty;
        if (penalty === 0) {
          // First non-frozen host in configured order.
          break;
        }
      }
    }

    if (!best) {
      return null;
    }
    if (bestPenalty > 0) {
      this.logVerbose(
        `[FailbackLoader] Every remaining failback host froze recently; trying the least recent one: ${best}`,
      );
    }
    this.triedFailbackUrls.add(best);
    this.failbackAttempt++;
    return {
      url: best,
      isOriginal: false,
      failbackNumber: this.failbackAttempt,
    };
  }

  /**
   * Compute the next candidate URL to launch, or null if exhausted.
   * Order: original (once, if allowed) → failback hosts (configured order,
   * recently frozen hosts last) → queued same-URL retries after
   * connection-level failures → last-resort original → one quarantine-bypass
   * pass over unused backups.
   */
  private dequeueCandidateUrl(): Candidate | null {
    // 1. Original source (only the very first slot, and only when allowed).
    if (this.allowOriginal && !this.attemptedOriginalRequest) {
      this.attemptedOriginalRequest = true;
      if (!this.inFlightUrls.has(this.originalUrl)) {
        return {
          url: this.originalUrl,
          isOriginal: true,
          failbackNumber: 0,
          isRetry: false,
        };
      }
    }

    // 2. Fresh failback hosts.
    const failback = this.nextFailbackCandidate(this.quarantineBypassStarted);
    if (failback) {
      return { ...failback, isRetry: false };
    }

    // 3. Queued same-URL retries after connection-level failures.
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
      if (
        !isOriginal &&
        !this.quarantineBypassStarted &&
        !this.isFailbackHostAvailable(url)
      ) {
        continue;
      }
      const failbackNumber = isOriginal ? 0 : ++this.failbackAttempt;
      return { url, isOriginal, failbackNumber, isRetry: true };
    }

    // 4. Permanent mode skipped the original, but every backup is dead or
    // quarantined. A working origin is better than failing the fragment.
    if (!this.attemptedOriginalRequest) {
      this.attemptedOriginalRequest = true;
      if (!this.inFlightUrls.has(this.originalUrl)) {
        logger.log(
          `[FailbackLoader] LAST RESORT: no healthy failback hosts, trying original: ${this.originalUrl}`,
        );
        return {
          url: this.originalUrl,
          isOriginal: true,
          failbackNumber: 0,
          isRetry: false,
        };
      }
    }

    // 5. Still nothing launchable: retry backups that were only skipped for
    // cooldown. Hosts already tried this load stay in triedFailbackUrls.
    if (!this.quarantineBypassStarted) {
      this.quarantineBypassStarted = true;
      const bypassed = this.nextFailbackCandidate(true);
      if (bypassed) {
        logger.log(
          `[FailbackLoader] LAST RESORT: ignoring failback host quarantine for ${bypassed.url}`,
        );
        return { ...bypassed, isRetry: false };
      }
    }

    return null;
  }

  /**
   * Launch the next candidate attempt if one is available and we are under the
   * concurrency cap. Returns true if an attempt was started.
   */
  private launchNextAttempt(): boolean {
    // A parked backup response is already in hand; only the original's head
    // start is being waited out, so no new request can improve the outcome.
    if (this.finished || this.parkedSuccess) {
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
    this.launchCandidate(candidate);
    return true;
  }

  private launchCandidate(candidate: Candidate) {
    this.launchedCount++;

    if (!candidate.isOriginal) {
      this.invokeFailbackHook(
        'onFailback',
        this.failbackConfig.onFailback,
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
      candidate.isRetry,
    );
    this.armHedgeTimer();
  }

  /**
   * At the concurrency cap, hand the slot of the oldest attempt that is
   * already past its soft silence budget to a fresh candidate. Keeps
   * exploring hosts while a blackholed request would otherwise sit on the slot
   * until its hard timeout. Returns true if a candidate was launched.
   */
  private evictSuspectForCandidate(): boolean {
    if (
      this.finished ||
      this.parkedSuccess ||
      this.launchedCount >= MAX_TOTAL_ATTEMPTS_PER_LOAD
    ) {
      return false;
    }
    let oldest: Attempt | null = null;
    this.attempts.forEach((attempt) => {
      if (
        attempt.suspect &&
        !attempt.settled &&
        attempt.firstByteAt === 0 &&
        (!oldest || attempt.startTime < oldest.startTime)
      ) {
        oldest = attempt;
      }
    });
    if (!oldest) {
      return false;
    }
    const candidate = this.dequeueCandidateUrl();
    if (!candidate) {
      return false;
    }
    const evicted: Attempt = oldest;
    this.failAttempt(
      evicted,
      'silent',
      `No response headers within ${this.getFirstByteTimeoutMs()}ms; slot handed to ${candidate.url}`,
      undefined,
      undefined,
      true,
    );
    if (this.finished) {
      return false;
    }
    this.launchCandidate(candidate);
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

  /**
   * The original request, if it is still worth waiting for: it is answering
   * (stall detection guards it from here on), or it is still within its head
   * start. A silent original past its soft budget, or any silent original
   * when the origin is already known to fail (playlist race), does not hold
   * back a completed backup.
   */
  private findViableOriginal(): Attempt | null {
    let found: Attempt | null = null;
    this.attempts.forEach((attempt) => {
      if (!attempt.isOriginal || attempt.settled) {
        return;
      }
      if (attempt.firstByteAt > 0 || (!attempt.suspect && !this.raceOriginal)) {
        found = attempt;
      }
    });
    return found;
  }

  /**
   * Hold a successful failback response while the original request is still
   * viable. Prefer the highest-priority (lowest failbackNumber) parked body.
   */
  private parkFailbackSuccess(
    attempt: Attempt,
    data: any,
    len: number,
    status: number,
  ) {
    attempt.settled = true;
    this.clearAttemptTimers(attempt);
    this.attempts.delete(attempt);
    this.inFlightUrls.delete(attempt.url);
    attempt.xhr.onreadystatechange = null;
    attempt.xhr.onprogress = null;
    attempt.xhr.onerror = null;

    if (
      !this.parkedSuccess ||
      attempt.failbackNumber < this.parkedSuccess.attempt.failbackNumber
    ) {
      this.parkedSuccess = { attempt, data, len, status };
      this.logVerbose(
        `[FailbackLoader] Parked failback #${attempt.failbackNumber} success; waiting on original: ${attempt.url}`,
      );
    }
  }

  /**
   * Deliver a previously parked failback body after the original has failed.
   * Returns true when a parked response was consumed.
   */
  private consumeParkedSuccess(): boolean {
    if (!this.parkedSuccess || this.finished) {
      return false;
    }
    const parked = this.parkedSuccess;
    this.parkedSuccess = null;
    this.completeWithSuccess(
      parked.attempt,
      parked.data,
      parked.len,
      parked.status,
    );
    return true;
  }

  private startAttempt(
    url: string,
    isOriginal: boolean,
    failbackNumber: number,
    isRetry: boolean = false,
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
      isRetry,
      startTime: now,
      waitStart: now,
      lastMonitorAt: now,
      firstByteAt: 0,
      loaded: 0,
      total: 0,
      lastProgressTime: now,
      lastSpeedCheckTime: now,
      lastSpeedCheckBytes: 0,
      lowSpeedDuration: 0,
      suspect: false,
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
      // Match XhrLoader: call xhrSetup with the loader instance as `this` so
      // existing configs that rely on method-style hooks keep working.
      Promise.resolve()
        .then(() => {
          if (attempt.settled || this.finished) return;
          return xhrSetup.call(this, xhr, url, xhrContext);
        })
        .catch(() => {
          if (attempt.settled || this.finished) return;
          xhr.open('GET', url, true);
          return xhrSetup.call(this, xhr, url, xhrContext);
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

    // stats.loading.start stays at load() time (as in XhrLoader): TTFB and
    // bandwidth samples must include time spent on attempts that failed.
    attempt.startTime = self.performance.now();
    attempt.waitStart = attempt.startTime;
    attempt.lastMonitorAt = attempt.startTime;
    attempt.lastProgressTime = attempt.startTime;
    attempt.lastSpeedCheckTime = attempt.startTime;

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

    // 0. Timers were suspended (background tab, Android app switch, frozen
    // renderer). Whatever happened during the gap is not evidence about the
    // network: shift the silence/stall baselines past it and judge again on
    // the next tick.
    const tickGap = now - attempt.lastMonitorAt;
    attempt.lastMonitorAt = now;
    if (tickGap > TIMER_GAP_TOLERANCE_MS) {
      const suspended = tickGap - STALL_CHECK_INTERVAL_MS;
      attempt.waitStart = Math.min(now, attempt.waitStart + suspended);
      attempt.lastProgressTime = Math.min(
        now,
        attempt.lastProgressTime + suspended,
      );
      attempt.lastSpeedCheckTime = now;
      attempt.lastSpeedCheckBytes = attempt.loaded;
      attempt.lowSpeedDuration = 0;
      this.logVerbose(
        `[FailbackLoader] Timers were suspended for ${tickGap.toFixed(0)}ms; not charging the gap to ${attempt.url}`,
      );
      return;
    }

    // 1. Blackhole detection: no response headers/bytes at all.
    if (attempt.firstByteAt === 0) {
      const waited = now - attempt.waitStart;
      const hardTimeout = this.getHardFirstByteTimeoutMs();
      const softTimeout = this.getFirstByteTimeoutMs();
      // A same-URL retry already failed once in this load: no extended wait.
      if (waited >= hardTimeout || (waited >= softTimeout && attempt.isRetry)) {
        this.failAttempt(
          attempt,
          'silent',
          `No first byte within ${(waited >= hardTimeout ? hardTimeout : softTimeout).toFixed(0)}ms`,
        );
        return;
      }
      if (!attempt.suspect && waited >= softTimeout) {
        this.markAttemptSuspect(attempt, softTimeout);
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

  /**
   * No response headers within the soft budget. The host is most likely
   * blackholed: de-prioritise it, open alternatives and stop holding back a
   * completed backup for it. The request itself stays open until the hard
   * budget (or until its slot is needed), because on a slow but healthy link
   * it may still answer.
   */
  private markAttemptSuspect(attempt: Attempt, softTimeout: number) {
    attempt.suspect = true;
    this.markHostFrozen(attempt.url);
    logger.log(
      `[FailbackLoader] SILENT: no response headers from ${attempt.url} within ${softTimeout.toFixed(0)}ms; trying alternatives (request kept until ${this.getHardFirstByteTimeoutMs().toFixed(0)}ms)`,
    );
    if (
      attempt.isOriginal &&
      this.parkedSuccess &&
      !this.findViableOriginal()
    ) {
      this.consumeParkedSuccess();
      return;
    }
    this.pump();
  }

  private onProgress(attempt: Attempt, event: ProgressEvent) {
    if (attempt.settled || this.finished) {
      return;
    }
    attempt.loaded = event.loaded;
    if (event.lengthComputable) {
      attempt.total = event.total;
    }
    attempt.lastProgressTime = self.performance.now();

    if (attempt.loaded >= PROVEN_TRANSFER_BYTES) {
      this.cancelRedundantAttempts(attempt);
    }
    this.refreshLoadingStats();
  }

  /**
   * `attempt` has streamed past the window a TSPU leaks before blackholing,
   * so parallel insurance requests only cost bandwidth now (on a slow but
   * healthy link they would otherwise download the same segment again).
   * The original is never cancelled here: it keeps priority when it answers,
   * and costs nothing while it is silent.
   */
  private cancelRedundantAttempts(proven: Attempt) {
    if (this.hedgeTimer) {
      self.clearTimeout(this.hedgeTimer);
      this.hedgeTimer = undefined;
    }
    Array.from(this.attempts).forEach((attempt) => {
      if (attempt === proven || attempt.settled || attempt.isOriginal) {
        return;
      }
      this.noteSilentLoser(attempt);
      this.logVerbose(
        `[FailbackLoader] Cancelling redundant attempt ${attempt.url}: ${proven.url} already streamed ${proven.loaded} bytes`,
      );
      attempt.settled = true;
      this.teardownAttempt(attempt, true);
      // Not a failure: allow the URL again should the proven attempt break.
      this.triedFailbackUrls.delete(attempt.url);
    });
  }

  /**
   * A request that is being cancelled because another host answered, while it
   * had itself been silent for at least the hedge delay, most likely hit a
   * blackholed connection. De-prioritise its host so the next fragments do
   * not start on it again (it would never reach its own silence budget,
   * because a faster host always wins the race first).
   */
  private noteSilentLoser(attempt: Attempt) {
    if (
      attempt.settled ||
      attempt.firstByteAt > 0 ||
      attempt.suspect ||
      self.performance.now() - attempt.waitStart < this.getHedgeDelayMs()
    ) {
      return;
    }
    this.markHostFrozen(attempt.url);
  }

  /**
   * Mirror the most advanced in-flight attempt into the shared stats while
   * loading, as XhrLoader does for its single request: ABR emergency
   * down-switch and TTFB estimates read `loading.first` and `loaded` during
   * the load.
   */
  private refreshLoadingStats() {
    const leader = Array.from(this.attempts).reduce<Attempt | null>(
      (best, attempt) => {
        if (attempt.settled) {
          return best;
        }
        if (
          !best ||
          attempt.loaded > best.loaded ||
          (attempt.loaded === best.loaded &&
            attempt.firstByteAt > 0 &&
            (best.firstByteAt === 0 || attempt.firstByteAt < best.firstByteAt))
        ) {
          return attempt;
        }
        return best;
      },
      null,
    );
    if (!leader) {
      return;
    }
    const stats = this.stats;
    stats.loaded = leader.loaded;
    stats.total = leader.total;
    stats.loading.first = leader.firstByteAt
      ? Math.max(leader.firstByteAt, stats.loading.start)
      : 0;
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

      // A slow answer is still an answer: the attempt is no longer suspect,
      // and the budgets adapt to how long this link takes to respond.
      attempt.suspect = false;
      if (xhr.status) {
        this.sampleTtfb(ttfb);
      }

      // Headers arrived — do not launch *new* hedges. Already-running
      // backups stay up as insurance: original headers can still be a
      // 503 or a 200 that later stalls (TSPU after handshake).
      if (this.hedgeTimer) {
        self.clearTimeout(this.hedgeTimer);
        this.hedgeTimer = undefined;
      }
      this.refreshLoadingStats();
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
          data,
        );
        if (integrityError) {
          this.failAttempt(
            attempt,
            'integrity',
            integrityError.message,
            undefined,
            { confirmedUnusable: integrityError.immediateFailback },
          );
          return;
        }

        // Primary keeps priority while it is still viable: park failback
        // successes and only promote them after the original fails or goes
        // silent past its soft budget.
        if (!attempt.isOriginal && this.findViableOriginal()) {
          this.parkFailbackSuccess(attempt, data, len, status);
          return;
        }

        this.completeWithSuccess(attempt, data, len, status);
        return;
      }
    }

    // CORS / mixed-content / aborted-without-status: browsers report this as
    // readyState 4 + status 0. Treat as a transport failure, not an HTTP
    // error, so backup hosts are not quarantined.
    if (!status) {
      this.failAttempt(
        attempt,
        'network',
        'HTTP status 0 (CORS or transport failure)',
      );
      return;
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
    this.parkedSuccess = null;
    // Detach the winner from the pool before aborting the losers so its own
    // teardown does not abort the (already complete) winning xhr.
    this.attempts.delete(attempt);
    this.inFlightUrls.delete(attempt.url);
    this.clearAttemptTimers(attempt);
    xhr.onreadystatechange = null;
    xhr.onprogress = null;
    xhr.onerror = null;

    // A hedged failback win leaves the original request still in-flight. If
    // that original never produced a first byte (blackhole), abort alone would
    // skip recordAttemptFailure — permanent failback never engages and every
    // subsequent segment pays hedgeDelayMs again. Count those silent losers.
    // (Usually the original already failed via monitor before consumeParkedSuccess;
    // this covers the rare path where completeWithSuccess runs with original alive.)
    if (!attempt.isOriginal) {
      Array.from(this.attempts).forEach((loser) => {
        if (
          loser.isOriginal &&
          !loser.settled &&
          loser.firstByteAt === 0 &&
          loser.loaded === 0
        ) {
          this.recordAttemptFailure(loser, 'silent');
        }
      });
    }
    this.attempts.forEach((loser) => this.noteSilentLoser(loser));

    this.abortInternal();
    this.markHostSuccess(attempt.url);

    stats.loading.first = Math.max(attempt.firstByteAt, stats.loading.start);
    stats.loading.end = Math.max(self.performance.now(), stats.loading.first);
    stats.loaded = stats.total = len;
    stats.bwEstimate =
      stats.loading.end > stats.loading.first
        ? (stats.total * 8000) / (stats.loading.end - stats.loading.first)
        : 0;

    this.callbacks?.onProgress?.(stats, context, data, xhr);

    this.invokeFailbackHook(
      'onSuccess',
      this.failbackConfig.onSuccess,
      xhr.responseURL,
      !attempt.isOriginal,
      attempt.failbackNumber,
    );

    if (this.scope === 'playlist') {
      this.completePlaylistSuccess(attempt, data, status);
      return;
    }

    if (attempt.isOriginal) {
      if (state.permanentFailbackMode) {
        // A full segment from origin is stronger evidence than a range probe.
        logger.log(
          '[FailbackLoader] Original source recovered via last-resort full segment',
        );
        state.permanentFailbackMode = false;
        state.fragmentsSinceLastProbe = 0;
        state.unhealthyFailbackHosts.clear();
        state.consecutiveOriginalFailures = 0;
      } else if (state.consecutiveOriginalFailures > 0) {
        logger.log(
          `[FailbackLoader] Original source recovered, resetting failure counter`,
        );
        state.consecutiveOriginalFailures = 0;
      } else {
        state.consecutiveOriginalFailures = 0;
      }
    } else {
      // Evidence-based switch: the origin failed and this backup delivered.
      this.switchToPermanentFailbackModeIfNeeded(state);
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
   * Playlist-scope completion. Playlist results never touch the fragment
   * permanent-failback state: the playlist origin and the segment CDN are
   * often different hosts (e.g. an origin that answers playlists itself but
   * redirects segments to a blocked CDN).
   */
  private completePlaylistSuccess(attempt: Attempt, data: any, status: number) {
    const { context, stats } = this;
    if (!context) {
      return;
    }
    const xhr = attempt.xhr;
    const playlistState = getSessionState(this.config).playlist;
    if (attempt.isOriginal) {
      if (playlistState.consecutiveOriginalFailures > 0) {
        logger.log(
          '[FailbackLoader] Playlist origin recovered, resetting failure counter',
        );
      }
      playlistState.consecutiveOriginalFailures = 0;
    } else {
      logger.log(
        `[FailbackLoader] PLAYLIST via failback #${attempt.failbackNumber}: ${xhr.responseURL || attempt.url}`,
      );
    }

    // Relative URIs inside a playlist resolve against the response URL. When a
    // backup served it, keep the canonical origin as the base: media requests
    // then still go through the usual origin → failback path (with permanent
    // mode and origin recovery) instead of being pinned to one backup host.
    const url = attempt.isOriginal
      ? xhr.responseURL || attempt.url
      : this.originalUrl;
    this.callbacks?.onSuccess?.(
      { url, data, code: status },
      stats,
      context,
      xhr,
    );
  }

  /**
   * Validate that a terminal XHR contains the byte range it claims to contain.
   * A middlebox can close a 200 response after a small prefix while XHR still
   * exposes the resulting ArrayBuffer as a successful response.
   *
   * Content-Length is only treated as a truncation signal when the body is
   * *shorter* than the header. A longer body is the normal CORS-hidden gzip
   * case (Content-Encoding is not safelisted; XHR exposes the decompressed
   * buffer against the compressed Content-Length) and must not fail the load.
   */
  private getResponseIntegrityError(
    xhr: XMLHttpRequest,
    context: FragmentLoaderContext,
    status: number,
    data: any,
  ): { message: string; immediateFailback: boolean } | null {
    const contentEncoding = getExposedResponseHeader(xhr, 'Content-Encoding');
    const contentLength = getExposedResponseHeader(xhr, 'Content-Length');
    const isText = typeof data === 'string';

    if (
      contentLength &&
      (!contentEncoding || contentEncoding.toLowerCase() === 'identity')
    ) {
      const expectedLength = Number(contentLength);
      const responseLength = getWireLength(data);
      // Text is re-encoded to count its bytes; the decoder drops a UTF-8 BOM,
      // so allow those 3 bytes before calling a playlist truncated.
      const tolerance = isText ? 3 : 0;
      if (
        responseLength >= 0 &&
        Number.isSafeInteger(expectedLength) &&
        expectedLength >= 0 &&
        responseLength + tolerance < expectedLength
      ) {
        return {
          message: `response body is ${responseLength} bytes but Content-Length is ${expectedLength}`,
          // Hidden gzip produces a *longer* body and is ignored above.
          // A shorter identity body is a finished truncated transfer.
          immediateFailback: true,
        };
      }
    }

    if (isText || !this.hasByteRange(context)) {
      return null;
    }

    const responseLength = getWireLength(data);
    const expectedLength = context.rangeEnd! - context.rangeStart!;
    if (expectedLength >= 0 && responseLength !== expectedLength) {
      return {
        message: `range body is ${responseLength} bytes but requested range requires ${expectedLength}`,
        immediateFailback: true,
      };
    }

    if (status !== 206) {
      return null;
    }

    const contentRange = getExposedResponseHeader(xhr, 'Content-Range');
    if (!contentRange) {
      return null;
    }

    const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!match) {
      return {
        message: '206 response has an invalid Content-Range header',
        immediateFailback: true,
      };
    }

    const responseStart = Number(match[1]);
    const responseEnd = Number(match[2]);
    if (
      responseStart !== context.rangeStart ||
      responseEnd !== context.rangeEnd! - 1
    ) {
      return {
        message: `response range ${responseStart}-${responseEnd} does not match requested range ${context.rangeStart}-${context.rangeEnd! - 1}`,
        immediateFailback: true,
      };
    }

    return null;
  }

  private handleUnexpectedRangeResponse(attempt: Attempt) {
    const contentRange = getExposedResponseHeader(attempt.xhr, 'Content-Range');
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
    // A backup that simply does not carry this object (4xx) must not replace
    // the error already recorded: reporting e.g. a mirror's 404 instead of the
    // origin's 503 would stop hls.js from retrying a recoverable failure.
    if (
      this.isDefinitiveFailureKind(this.lastFailureKind) &&
      !attempt.isOriginal &&
      isHttpClientError(httpError?.code)
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
    options?: { confirmedUnusable?: boolean; httpStatus?: number },
    skipPump: boolean = false,
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
    this.recordAttemptFailure(attempt, kind, {
      ...options,
      httpStatus: httpError?.code ?? options?.httpStatus,
    });
    this.refreshLoadingStats();

    // Original lost: promote a parked failback body if one finished earlier.
    if (attempt.isOriginal && this.consumeParkedSuccess()) {
      return;
    }

    // Same-URL retry only after connection-level failures (see
    // isRetryableFailure): a silent host's frozen session would be reused.
    if (this.isRetryableFailure(kind)) {
      this.maybeRequeueForRetry(attempt.url);
    }

    // Advance: fill the freed concurrency slot immediately.
    if (!skipPump) {
      this.pump();
    }
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
      `[FailbackLoader] Requeued host for fresh-connection retry: ${url} (${used + 1}/${maxRetries})`,
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
    for (;;) {
      if (this.launchNextAttempt()) {
        launchedAny = true;
        continue;
      }
      // At the cap, trade a request that is already past its soft silence
      // budget for a fresh candidate instead of waiting for its hard timeout.
      if (
        this.attempts.size >= this.getMaxParallelAttempts() &&
        this.evictSuspectForCandidate()
      ) {
        launchedAny = true;
        continue;
      }
      break;
    }
    if (this.finished) {
      return;
    }

    if (this.attempts.size > 0) {
      // Still waiting on in-flight attempts. Re-arm hedge if idle.
      if (!launchedAny && !this.hedgeTimer) {
        this.armHedgeTimer();
      }
      return;
    }

    // Nothing in flight: a parked backup body is the answer. (It only waits
    // on an in-flight original, so this is purely defensive.)
    if (this.consumeParkedSuccess()) {
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
    // Without any network, report what XhrLoader would: a status-0 error.
    // hls.js then waits for the `online` event instead of burning its
    // (immediate) timeout retries and going fatal while the phone is in a
    // tunnel or switching networks.
    const offline = !isHttpFailure && isBrowserOffline();

    if (this.maybeRetryLoad(isHttpFailure, offline)) {
      return;
    }

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
    } else if (offline) {
      this.callbacks?.onError?.(
        { code: 0, text: 'Network unavailable (browser offline)' },
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

  /**
   * Honour loadPolicy.timeoutRetry / errorRetry like XhrLoader does. Fragment
   * and level-playlist policies are handed over without them (hls.js retries
   * those itself); the manifest policy keeps them.
   */
  private maybeRetryLoad(isHttpFailure: boolean, offline: boolean): boolean {
    const policy = this.loaderConfig?.loadPolicy;
    if (!policy || !this.callbacks) {
      return false;
    }
    const isTimeout = !isHttpFailure && !offline;
    const retryConfig = isTimeout ? policy.timeoutRetry : policy.errorRetry;
    const response: LoaderResponse = {
      url: this.originalUrl,
      data: undefined,
      code: isHttpFailure ? this.lastErrorCode : 0,
    };
    if (!shouldRetry(retryConfig, this.stats.retry, isTimeout, response)) {
      return false;
    }
    const delay = getRetryDelay(retryConfig, this.stats.retry);
    this.stats.retry++;
    logger.warn(
      `[FailbackLoader] ${isTimeout ? 'Timeout' : 'Error'} loading ${this.originalUrl}, retrying ${this.stats.retry}/${retryConfig.maxNumRetry} in ${delay}ms`,
    );
    this.loadRetryTimer = self.setTimeout(() => {
      this.loadRetryTimer = undefined;
      if (!this.callbacks || this.stats.aborted) {
        return;
      }
      this.startLoadCycle();
    }, delay);
    return true;
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
    // Same contract as XhrLoader: the Age header of the response that won,
    // used by hls.js to time live playlist reloads.
    const age = this.loader
      ? getExposedResponseHeader(this.loader, 'age')
      : null;
    if (age && /^[\d.]+$/.test(age)) {
      return parseFloat(age);
    }
    return null;
  }

  getResponseHeader(name: string): string | null {
    return this.loader ? getExposedResponseHeader(this.loader, name) : null;
  }
}

export default FailbackLoader;
