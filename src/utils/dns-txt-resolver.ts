/**
 * DNS TXT Record Resolver using DNS-over-HTTPS
 * Fetches TXT records from DNS without needing server-side code
 */

import { logger } from './logger';

// DNS-over-HTTPS providers
const DOH_PROVIDERS = [
  'https://dns.google/resolve',
  'https://common.dot.dns.yandex.net/dns-query',
];

interface DohResponse {
  Status: number;
  Answer?: Array<{
    type: number;
    data: string;
  }>;
}

// Permanent cache for DNS results (resolved once, stored forever)
const dnsCache: Map<string, string[]> = new Map();

// Timeout for DNS requests (3 seconds per provider)
const DNS_TIMEOUT_MS = 3000;

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
  // Check cache first - permanent cache, no TTL
  const cached = dnsCache.get(domain);
  if (cached) {
    return Promise.resolve(cached);
  }

  // Try all providers in parallel - first successful response wins
  const requests = DOH_PROVIDERS.map((provider) =>
    tryProvider(provider, domain).then((result) => {
      if (result) return result;
      throw new Error('No result');
    }),
  );

  return promiseAny(requests)
    .then((result) => {
      logger.log(`[DNS-TXT] Resolved ${domain}: ${result.join(', ')}`);
      dnsCache.set(domain, result);
      return result;
    })
    .catch(() => {
      logger.warn(`[DNS-TXT] Failed to resolve ${domain} from all providers`);
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

/**
 * Clear DNS cache
 */
export function clearDnsCache(): void {
  dnsCache.clear();
}
