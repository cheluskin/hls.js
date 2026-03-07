export function normalizeHost(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('://') || trimmed.startsWith('//')) {
    try {
      const parsed = new URL(
        trimmed.startsWith('//') ? `https:${trimmed}` : trimmed,
      );
      return parsed.host || null;
    } catch {
      return null;
    }
  }

  return trimmed;
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

  url.hostname = normalized;
  url.port = '';
}
