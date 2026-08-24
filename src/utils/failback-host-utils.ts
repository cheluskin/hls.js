/**
 * Drop DNS TXT junk that is not a usable HTTP host (SPF, site-verification,
 * multi-token records). Applied after extracting `host` from a URL so a
 * failback entry like `https://cdn.example.com:8443/path` still works.
 */
function isPlausibleHttpHost(host: string): boolean {
  if (!host || /[\s=,/?#@~]/.test(host)) {
    return false;
  }
  return /^[A-Za-z0-9._:%:[\]-]+$/.test(host);
}

export function normalizeHost(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (trimmed.indexOf('://') !== -1 || trimmed.startsWith('//')) {
    try {
      const parsed = new URL(
        trimmed.startsWith('//') ? `https:${trimmed}` : trimmed,
      );
      candidate = parsed.host || '';
    } catch {
      return null;
    }
  }

  if (!isPlausibleHttpHost(candidate)) {
    return null;
  }

  return candidate;
}

export function normalizeHosts(hosts: string[] | undefined): string[] {
  if (!hosts || hosts.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (let i = 0; i < hosts.length; i++) {
    const normalized = normalizeHost(hosts[i]);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function applyHostToUrl(url: URL, host: string): void {
  const normalized = normalizeHost(host);
  if (!normalized) {
    throw new Error('Invalid failback host');
  }

  if (normalized.startsWith('[')) {
    const match = normalized.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match) {
      throw new Error(`Invalid bracketed host: ${normalized}`);
    }
    url.host = normalized;
    return;
  }

  const colonCount = (normalized.match(/:/g) || []).length;

  if (colonCount === 0) {
    url.hostname = normalized;
    url.port = '';
    return;
  }

  if (colonCount === 1) {
    url.host = normalized;
    return;
  }

  // IPv6 address without brackets
  url.host = `[${normalized}]`;
}
