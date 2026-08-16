/**
 * DNS TXT Record Resolver using DNS-over-HTTPS
 * Fetches TXT records from DNS without needing server-side code
 */

import { logger } from './logger';

// DNS-over-HTTPS providers (must support CORS + application/dns-json).
// Google/Cloudflare are often blocked in the same places that need failback,
// so the default list includes additional JSON DoH endpoints.
const DEFAULT_DOH_PROVIDERS = [
  'https://dns.google/resolve',
  'https://cloudflare-dns.com/dns-query',
  'https://dns.quad9.net:5053/dns-query',
  'https://dns.alidns.com/resolve',
];

let dohProviders = DEFAULT_DOH_PROVIDERS.slice();

export function getDohProviders(): readonly string[] {
  return dohProviders;
}

/**
 * Override the DoH endpoint list. An empty/invalid list restores the defaults.
 * Shared process-wide: the DNS cache is a module singleton.
 */
export function setDohProviders(providers?: string[]): void {
  const cleaned = (providers || [])
    .map((provider) => (typeof provider === 'string' ? provider.trim() : ''))
    .filter((provider) => provider.length > 0);
  dohProviders = cleaned.length > 0 ? cleaned : DEFAULT_DOH_PROVIDERS.slice();
}

interface DohResponse {
  Status: number;
  Answer?: Array<{
    type: number;
    data: string;
  }>;
}

interface DnsCacheEntry {
  records: string[];
  // null = positive result, cached for the session. A timestamp means a
  // negative result that may be retried after NEGATIVE_DNS_CACHE_TTL_MS.
  expiresAt: number | null;
}

// Positive DNS results are cached for the session. Empty/failed lookups use a
// short TTL so a player that started offline or with blocked DoH can pick up
// GeoDNS hosts later instead of staying on the single build-time fallback.
const dnsCache: Map<string, DnsCacheEntry> = new Map();

export type DnsCacheClearScope = 'all' | 'negative';
const dnsCacheClearListeners = new Set<(scope: DnsCacheClearScope) => void>();

// Timeout for DNS requests (3 seconds per provider)
const DNS_TIMEOUT_MS = 3000;
export const NEGATIVE_DNS_CACHE_TTL_MS = 60_000;

function readDnsCache(domain: string): string[] | undefined {
  const entry = dnsCache.get(domain);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
    dnsCache.delete(domain);
    return undefined;
  }
  return entry.records;
}

export function hasDnsCacheEntry(domain: string): boolean {
  return readDnsCache(domain) !== undefined;
}

/**
 * Remaining absolute expiry for a negative DNS entry, or null if the domain
 * is uncached / positive / already expired.
 */
export function peekNegativeDnsExpiry(domain: string): number | null {
  const entry = dnsCache.get(domain);
  if (!entry || entry.expiresAt == null) {
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    dnsCache.delete(domain);
    return null;
  }
  return entry.expiresAt;
}

/**
 * Expire negative DNS entries so tests can retry without waiting the TTL.
 * Positive (session-long) entries are left intact. Listeners receive
 * `negative` so they can drop only failed preload promises, not a
 * successfully resolved host cache.
 */
export function expireNegativeDnsCache(): void {
  dnsCache.forEach((entry, domain) => {
    if (entry.expiresAt != null) {
      dnsCache.delete(domain);
    }
  });
  dnsCacheClearListeners.forEach((listener) => listener('negative'));
}

/**
 * Try to fetch from a single provider with timeout
 */
function tryProvider(
  provider: string,
  domain: string,
): Promise<string[] | null> {
  const url = `${provider}?name=${encodeURIComponent(domain)}&type=TXT`;

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = self.setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);

  return fetch(url, {
    headers: {
      Accept: 'application/dns-json',
    },
    signal: controller.signal,
  })
    .then((response) => {
      self.clearTimeout(timeoutId);
      if (!response.ok) {
        return null;
      }
      return response.json();
    })
    .then((data: DohResponse | null) => {
      if (data?.Status !== 0 || !data?.Answer) {
        return null;
      }
      // TXT record type is 16
      const txtRecords = data.Answer.filter((a) => a.type === 16).map((a) =>
        // Remove surrounding quotes from TXT data
        a.data.replace(/^"|"$/g, ''),
      );
      return txtRecords.length > 0 ? txtRecords : null;
    })
    .catch((error) => {
      self.clearTimeout(timeoutId);
      logger.warn(`[DNS-TXT] Provider ${provider} failed:`, error);
      return null;
    });
}

/**
 * Promise.any polyfill - returns first fulfilled promise
 */
function promiseAny<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const rejections: Error[] = [];
    let pending = promises.length;

    if (pending === 0) {
      reject(new Error('All promises rejected'));
      return;
    }

    promises.forEach((promise) => {
      Promise.resolve(promise)
        .then(resolve)
        .catch((error) => {
          rejections.push(error);
          pending--;
          if (pending === 0) {
            reject(new Error('All promises rejected'));
          }
        });
    });
  });
}

/**
 * Fetch TXT records from DNS using DNS-over-HTTPS
 * Results are cached permanently (resolved once per session)
 * @param domain - Domain to query (e.g., 'fb.turoktv.com')
 * @returns Array of TXT record values
 */
export function fetchDnsTxt(domain: string): Promise<string[]> {
  const cached = readDnsCache(domain);
  if (cached) {
    return Promise.resolve(cached);
  }

  // Try all providers in parallel - first successful response wins
  const requests = dohProviders.map((provider) =>
    tryProvider(provider, domain).then((result) => {
      if (result) return result;
      throw new Error('No result');
    }),
  );

  return promiseAny(requests)
    .then((result) => {
      logger.log(`[DNS-TXT] Resolved ${domain}: ${result.join(', ')}`);
      dnsCache.set(domain, { records: result, expiresAt: null });
      return result;
    })
    .catch(() => {
      logger.warn(`[DNS-TXT] Failed to resolve ${domain} from all providers`);
      dnsCache.set(domain, {
        records: [],
        expiresAt: Date.now() + NEGATIVE_DNS_CACHE_TTL_MS,
      });
      return [];
    });
}

/**
 * Fetch failback hosts from DNS TXT record
 * @param domain - Domain with TXT record containing failback hosts
 * @returns Promise resolving to array of failback host URLs
 */
export function fetchFailbackHosts(
  domain: string = 'fb.turoktv.com',
): Promise<string[]> {
  return fetchDnsTxt(domain).then((records) =>
    records.filter((r) => r.trim().length > 0),
  );
}

export function registerDnsCacheClearListener(
  listener: (scope: DnsCacheClearScope) => void,
): () => void {
  dnsCacheClearListeners.add(listener);

  return () => {
    dnsCacheClearListeners.delete(listener);
  };
}

/**
 * Clear DNS cache
 */
export function clearDnsCache(): void {
  dnsCache.clear();
  dnsCacheClearListeners.forEach((listener) => listener('all'));
}
