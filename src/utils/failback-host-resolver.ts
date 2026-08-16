import {
  fetchFailbackHosts,
  hasDnsCacheEntry,
  NEGATIVE_DNS_CACHE_TTL_MS,
  peekNegativeDnsExpiry,
  registerDnsCacheClearListener,
} from './dns-txt-resolver';
import { normalizeHosts } from './failback-host-utils';
import { logger } from './logger';

declare const __FAILBACK_DNS_DOMAIN__: string;
declare const __FAILBACK_HOSTS__: string[];

export const DEFAULT_FAILBACK_DNS_DOMAIN = __FAILBACK_DNS_DOMAIN__;

const FALLBACK_HOSTS = normalizeHosts(__FAILBACK_HOSTS__);
const dnsHostsPromisesByDomain = new Map<string, Promise<string[]>>();
const dnsHostsCacheByDomain = new Map<string, string[]>();
const negativeRetryTimersByDomain = new Map<string, number>();

registerDnsCacheClearListener((scope) => {
  negativeRetryTimersByDomain.forEach((timer) => {
    self.clearTimeout(timer);
  });
  negativeRetryTimersByDomain.clear();

  if (scope === 'negative') {
    // Drop only failed/empty preload promises. A domain that already
    // resolved to real GeoDNS hosts must keep its positive cache.
    dnsHostsPromisesByDomain.forEach((_, domain) => {
      if (!dnsHostsCacheByDomain.has(domain)) {
        dnsHostsPromisesByDomain.delete(domain);
      }
    });
    return;
  }

  dnsHostsPromisesByDomain.clear();
  dnsHostsCacheByDomain.clear();
});

function scheduleNegativeHostRetry(
  dnsDomain: string,
  promise: Promise<string[]>,
) {
  const existing = negativeRetryTimersByDomain.get(dnsDomain);
  if (existing) {
    self.clearTimeout(existing);
  }
  const expiresAt = peekNegativeDnsExpiry(dnsDomain);
  const delayMs =
    expiresAt != null
      ? Math.max(0, expiresAt - Date.now())
      : NEGATIVE_DNS_CACHE_TTL_MS;
  const timer = self.setTimeout(() => {
    negativeRetryTimersByDomain.delete(dnsDomain);
    if (dnsHostsPromisesByDomain.get(dnsDomain) === promise) {
      dnsHostsPromisesByDomain.delete(dnsDomain);
    }
  }, delayMs);
  // Node keeps the process alive for active timers. Tests (and short-lived
  // scripts) should be able to exit while this retry window is still open.
  const maybeNodeTimer = timer as unknown as { unref?: () => void };
  if (typeof maybeNodeTimer.unref === 'function') {
    maybeNodeTimer.unref();
  }
  negativeRetryTimersByDomain.set(dnsDomain, timer as unknown as number);
}

function preloadFailbackHostsForDomain(dnsDomain: string): Promise<string[]> {
  const cached = dnsHostsCacheByDomain.get(dnsDomain);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = dnsHostsPromisesByDomain.get(dnsDomain);
  if (pending) {
    // Retry only after a completed negative lookup whose DNS TTL elapsed.
    // An in-flight first lookup has no timer yet and must be reused.
    if (
      !dnsHostsCacheByDomain.has(dnsDomain) &&
      negativeRetryTimersByDomain.has(dnsDomain) &&
      !hasDnsCacheEntry(dnsDomain)
    ) {
      const staleTimer = negativeRetryTimersByDomain.get(dnsDomain);
      if (staleTimer) {
        self.clearTimeout(staleTimer);
      }
      negativeRetryTimersByDomain.delete(dnsDomain);
      dnsHostsPromisesByDomain.delete(dnsDomain);
    } else {
      return pending;
    }
  }

  const promise = fetchFailbackHosts(dnsDomain)
    .then((hosts) => {
      const normalizedHosts = normalizeHosts(hosts);
      if (normalizedHosts.length > 0) {
        dnsHostsCacheByDomain.set(dnsDomain, normalizedHosts);
        logger.log(
          `[FailbackLoader] DNS hosts loaded for ${dnsDomain}: ${normalizedHosts.join(', ')}`,
        );
        return normalizedHosts;
      }

      // Empty DNS must not pin the build-time fallback list forever. Keep
      // this promise as the in-flight result (avoids a log/lookup per
      // fragment) and drop it when the negative DNS TTL expires.
      logger.log(
        `[FailbackLoader] Using fallback hosts for ${dnsDomain}: ${FALLBACK_HOSTS.join(', ')}`,
      );
      scheduleNegativeHostRetry(dnsDomain, promise);
      return FALLBACK_HOSTS;
    })
    .catch(() => {
      scheduleNegativeHostRetry(dnsDomain, promise);
      return FALLBACK_HOSTS;
    });

  dnsHostsPromisesByDomain.set(dnsDomain, promise);
  return promise;
}

export function preloadFailbackHosts(
  dnsDomain: string = DEFAULT_FAILBACK_DNS_DOMAIN,
): Promise<string[]> {
  return preloadFailbackHostsForDomain(dnsDomain);
}

export function getFailbackHostsSync(dnsDomain: string): string[] {
  return dnsHostsCacheByDomain.get(dnsDomain) || FALLBACK_HOSTS;
}
