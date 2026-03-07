import {
  fetchFailbackHosts,
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

registerDnsCacheClearListener(() => {
  dnsHostsPromisesByDomain.clear();
  dnsHostsCacheByDomain.clear();
});

function preloadFailbackHostsForDomain(dnsDomain: string): Promise<string[]> {
  const cached = dnsHostsCacheByDomain.get(dnsDomain);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = dnsHostsPromisesByDomain.get(dnsDomain);
  if (pending) {
    return pending;
  }

  const promise = fetchFailbackHosts(dnsDomain).then((hosts) => {
    const normalizedHosts = normalizeHosts(hosts);
    const resolvedHosts =
      normalizedHosts.length > 0 ? normalizedHosts : FALLBACK_HOSTS;
    dnsHostsCacheByDomain.set(dnsDomain, resolvedHosts);
    logger.log(
      normalizedHosts.length > 0
        ? `[FailbackLoader] DNS hosts loaded for ${dnsDomain}: ${resolvedHosts.join(', ')}`
        : `[FailbackLoader] Using fallback hosts for ${dnsDomain}: ${resolvedHosts.join(', ')}`,
    );
    return resolvedHosts;
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
