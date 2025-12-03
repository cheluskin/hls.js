/**
 * DNS TXT Record Resolver using DNS-over-HTTPS
 * Fetches TXT records from DNS without needing server-side code
 */

import { logger } from './logger';

// DNS-over-HTTPS providers
const DOH_PROVIDERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
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

/**
 * Try to fetch from a single provider
 */
function tryProvider(
  provider: string,
  domain: string,
): Promise<string[] | null> {
  const url = `${provider}?name=${encodeURIComponent(domain)}&type=TXT`;
  return fetch(url, {
    headers: {
      Accept: 'application/dns-json',
    },
  })
    .then((response) => {
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
      logger.warn(`[DNS-TXT] Provider ${provider} failed:`, error);
      return null;
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

  // Try providers sequentially
  return tryProvider(DOH_PROVIDERS[0], domain).then((result) => {
    if (result) {
      logger.log(`[DNS-TXT] Resolved ${domain}: ${result.join(', ')}`);
      dnsCache.set(domain, result);
      return result;
    }
    // Try second provider
    return tryProvider(DOH_PROVIDERS[1], domain).then((result2) => {
      if (result2) {
        logger.log(`[DNS-TXT] Resolved ${domain}: ${result2.join(', ')}`);
        dnsCache.set(domain, result2);
        return result2;
      }
      logger.warn(`[DNS-TXT] Failed to resolve ${domain} from all providers`);
      return [];
    });
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
