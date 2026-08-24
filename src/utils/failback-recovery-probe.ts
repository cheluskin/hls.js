import { logger } from './logger';
import { LoaderContextType } from '../types/loader';
import type { HlsConfig } from '../config';
import type { LoaderContext } from '../types/loader';

export const RECOVERY_PROBE_MAX_BYTES = 16 * 1024;

function getProbeHeaders(
  headers: Record<string, string> | undefined,
  rangeStart: number,
  rangeEnd: number,
): Record<string, string> {
  const probeHeaders: Record<string, string> = {};

  // A caller's media Range is unrelated to this probe. Never let it replace
  // the validation range (or create a duplicate Range header with a different
  // casing), otherwise the probe can validate an arbitrary response.
  for (const name in headers) {
    if (name.toLowerCase() !== 'range') {
      probeHeaders[name] = headers[name];
    }
  }

  probeHeaders.Range = `bytes=${rangeStart}-${rangeEnd - 1}`;
  return probeHeaders;
}

function isValidProbeResponse(
  status: number,
  byteLength: number,
  expectedLength: number,
  contentRange: string | null,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  // Requiring 206 ensures that the server honored our bounded request. A 200
  // could be an ignored Range and force the browser to download an entire
  // segment just to decide that the original is healthy.
  if (status !== 206 || byteLength !== expectedLength) {
    return false;
  }

  // Content-Range is not CORS-safelisted. When it is visible, it must prove
  // that the CDN sent the exact bytes requested. When it is hidden, the full
  // bounded body is still enough to validate transports that do not expose it.
  if (!contentRange) {
    return true;
  }

  const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  return (
    !!match &&
    Number(match[1]) === rangeStart &&
    Number(match[2]) === rangeEnd - 1
  );
}

function probeOriginalCDNWithFetch(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> | undefined,
  rangeStart: number,
  rangeEnd: number,
): Promise<boolean> {
  const expectedLength = rangeEnd - rangeStart;
  const probeHeaders = getProbeHeaders(headers, rangeStart, rangeEnd);

  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;

    const finalize = (isSuccess: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      self.clearTimeout(timeoutId);
      resolve(isSuccess);
    };

    const timeoutId = self.setTimeout(() => {
      logger.log(`[FailbackLoader] Probe timeout after ${timeoutMs}ms`);
      controller.abort();
      finalize(false);
    }, timeoutMs);

    logger.log(
      `[FailbackLoader] Probe fetch starting: ${url} (${probeHeaders.Range})`,
    );

    fetch(url, {
      method: 'GET',
      headers: probeHeaders,
      signal: controller.signal,
    })
      .then((response) => {
        if (response.status !== 206) {
          // Do not keep a full response alive when the server ignored Range.
          const cancelResult = response.body?.cancel();
          cancelResult?.catch(() => {
            // The response is already considered invalid.
          });
          logger.log(
            `[FailbackLoader] Probe response: status=${response.status}, success=false`,
          );
          finalize(false);
          return;
        }

        // fetch resolves at headers. Recovery is valid only after every byte
        // in the requested range reaches JS before the timeout expires.
        return response.arrayBuffer().then((data) => {
          const contentRange = response.headers?.get('Content-Range') || null;
          const isSuccess = isValidProbeResponse(
            response.status,
            data.byteLength,
            expectedLength,
            contentRange,
            rangeStart,
            rangeEnd,
          );
          logger.log(
            `[FailbackLoader] Probe response: status=${response.status}, bytes=${data.byteLength}/${expectedLength}, content-range=${contentRange || '(not exposed)'}, success=${isSuccess}`,
          );
          finalize(isSuccess);
        });
      })
      .catch((error) => {
        if (!settled) {
          logger.log(
            `[FailbackLoader] Probe fetch error: ${error?.message || error}`,
          );
          finalize(false);
        }
      });
  });
}

export function probeOriginalCDN(
  config: HlsConfig,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
  rangeStart: number = 0,
  rangeEnd: number = RECOVERY_PROBE_MAX_BYTES,
): Promise<boolean> {
  const xhrSetup = config.xhrSetup;
  if (!xhrSetup) {
    return probeOriginalCDNWithFetch(
      url,
      timeoutMs,
      headers,
      rangeStart,
      rangeEnd,
    );
  }

  const expectedLength = rangeEnd - rangeStart;
  const probeHeaders = getProbeHeaders(headers, rangeStart, rangeEnd);

  return new Promise((resolve) => {
    const xhr = new self.XMLHttpRequest();
    let settled = false;

    const finalize = (isSuccess: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      self.clearTimeout(timeoutId);
      xhr.onreadystatechange = null;
      xhr.onerror = null;
      if (xhr.readyState !== 4) {
        xhr.abort();
      }
      resolve(isSuccess);
    };

    const openAndSend = () => {
      if (!xhr.readyState) {
        xhr.open('GET', url, true);
      }

      xhr.responseType = 'arraybuffer';
      for (const header in probeHeaders) {
        xhr.setRequestHeader(header, probeHeaders[header]);
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) {
          return;
        }

        const byteLength =
          xhr.response && typeof xhr.response.byteLength === 'number'
            ? xhr.response.byteLength
            : 0;
        const contentRange = xhr.getResponseHeader?.('Content-Range') || null;
        const isSuccess = isValidProbeResponse(
          xhr.status,
          byteLength,
          expectedLength,
          contentRange,
          rangeStart,
          rangeEnd,
        );
        logger.log(
          `[FailbackLoader] Probe response: status=${xhr.status}, bytes=${byteLength}/${expectedLength}, content-range=${contentRange || '(not exposed)'}, success=${isSuccess}`,
        );
        finalize(isSuccess);
      };

      xhr.onerror = () => {
        logger.log(`[FailbackLoader] Probe xhr error: ${url}`);
        finalize(false);
      };

      try {
        xhr.send();
      } catch (error) {
        logger.log(
          `[FailbackLoader] Probe xhr send error: ${error?.message || error}`,
        );
        finalize(false);
      }
    };

    const timeoutId = self.setTimeout(() => {
      logger.log(`[FailbackLoader] Probe timeout after ${timeoutMs}ms`);
      finalize(false);
    }, timeoutMs);

    logger.log(
      `[FailbackLoader] Probe xhr starting: ${url} (${probeHeaders.Range})`,
    );

    const probeContext: LoaderContext = {
      url,
      responseType: 'arraybuffer',
      type: LoaderContextType.MEDIA_FRAGMENT,
      headers: probeHeaders,
      rangeStart,
      rangeEnd,
    };

    Promise.resolve()
      .then(() => {
        if (settled) {
          return;
        }
        return xhrSetup.call({ config }, xhr, url, probeContext);
      })
      .catch(() => {
        if (settled) {
          return;
        }
        xhr.open('GET', url, true);
        return xhrSetup.call({ config }, xhr, url, probeContext);
      })
      .then(() => {
        if (!settled) {
          openAndSend();
        }
      })
      .catch((error) => {
        logger.log(
          `[FailbackLoader] Probe xhrSetup error: ${error?.message || error}`,
        );
        finalize(false);
      });
  });
}
