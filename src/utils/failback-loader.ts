import { LoadStats } from '../loader/load-stats';
import type { HlsConfig } from '../config';
import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from '../types/loader';

// ============================================
// КОНФИГУРАЦИЯ ПО УМОЛЧАНИЮ - РЕДАКТИРОВАТЬ ЗДЕСЬ
// ============================================
const DEFAULT_PRIMARY_HOST = 'hls.armdb.org';
const DEFAULT_FAILBACK_HOST = 'failback.turkserial.co';
// ============================================

/**
 * Configuration for failback URL transformation
 */
export interface FailbackConfig {
  /** Primary host to match (default: hls.armdb.org) */
  primaryHost?: string;

  /** Failback host to use (default: failback.turkserial.co) */
  failbackHost?: string;

  /** Additional failback hosts for multiple attempts */
  additionalHosts?: string[];

  /** Custom transform function (overrides host settings) */
  transformUrl?: (url: string, attempt: number) => string | null;

  /** Callback when failback is triggered */
  onFailback?: (
    originalUrl: string,
    failbackUrl: string,
    attempt: number,
  ) => void;

  /** Callback when all attempts failed */
  onAllFailed?: (originalUrl: string, attempts: number) => void;
}

class FailbackLoader implements Loader<LoaderContext> {
  private config: HlsConfig;
  private failbackConfig: FailbackConfig;
  private loader: XMLHttpRequest | null = null;
  private callbacks: LoaderCallbacks<LoaderContext> | null = null;
  public context: LoaderContext | null = null;
  public stats: LoaderStats;
  private failbackAttempt: number = 0;
  private originalUrl: string = '';
  private requestTimeout?: number;
  private loaderConfig: LoaderConfiguration | null = null;

  // Список всех failback хостов
  private failbackHosts: string[] = [];

  constructor(config: HlsConfig) {
    this.config = config;
    this.stats = new LoadStats();

    // Merge user config with defaults
    const userConfig = (config as any).failbackConfig || {};
    this.failbackConfig = {
      primaryHost: userConfig.primaryHost || DEFAULT_PRIMARY_HOST,
      failbackHost: userConfig.failbackHost || DEFAULT_FAILBACK_HOST,
      additionalHosts: userConfig.additionalHosts || [],
      transformUrl: userConfig.transformUrl,
      onFailback: userConfig.onFailback,
      onAllFailed: userConfig.onAllFailed,
    };

    // Build failback hosts list
    this.failbackHosts = [
      this.failbackConfig.failbackHost!,
      ...(this.failbackConfig.additionalHosts || []),
    ];
  }

  destroy() {
    this.abortInternal();
    this.loader = null;
    this.callbacks = null;
    this.context = null;
    this.loaderConfig = null;
  }

  private abortInternal() {
    const loader = this.loader;
    self.clearTimeout(this.requestTimeout);
    if (loader) {
      loader.onreadystatechange = null;
      loader.onprogress = null;
      if (loader.readyState !== 4) {
        this.stats.aborted = true;
        loader.abort();
      }
    }
  }

  abort() {
    this.abortInternal();
    if (this.callbacks?.onAbort) {
      this.callbacks.onAbort(
        this.stats,
        this.context as LoaderContext,
        this.loader,
      );
    }
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ) {
    if (this.stats.loading.start) {
      throw new Error('Loader can only be used once.');
    }
    this.stats = new LoadStats();
    this.stats.loading.start = self.performance.now();
    this.context = context;
    this.callbacks = callbacks;
    this.loaderConfig = config;
    this.failbackAttempt = 0;
    this.originalUrl = context.url;
    this.loadUrl(context.url);
  }

  /**
   * Get failback URL for the given attempt number
   */
  private getFailbackUrl(attempt: number): string | null {
    const { primaryHost, transformUrl } = this.failbackConfig;

    // Custom transform takes precedence
    if (transformUrl) {
      return transformUrl(this.originalUrl, attempt);
    }

    // Check if URL contains primary host
    if (!this.originalUrl.includes(primaryHost!)) {
      return null;
    }

    // Get failback host for this attempt
    if (attempt >= this.failbackHosts.length) {
      return null;
    }

    const failbackHost = this.failbackHosts[attempt];
    return this.originalUrl.replace(primaryHost!, failbackHost);
  }

  private loadUrl(url: string) {
    const context = this.context;
    const config = this.loaderConfig;
    if (!context || !config) return;

    const xhr = (this.loader = new self.XMLHttpRequest());

    xhr.open('GET', url, true);
    xhr.responseType = context.responseType as XMLHttpRequestResponseType;

    const headers = context.headers;
    if (headers) {
      for (const header in headers) {
        xhr.setRequestHeader(header, headers[header]);
      }
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader(
        'Range',
        'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1),
      );
    }

    xhr.onreadystatechange = () => this.onReadyStateChange(xhr, url);
    xhr.onprogress = this.onProgress.bind(this);

    // Setup timeout
    const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
    const timeout =
      maxTimeToFirstByteMs && Number.isFinite(maxTimeToFirstByteMs)
        ? maxTimeToFirstByteMs
        : maxLoadTimeMs;

    self.clearTimeout(this.requestTimeout);
    this.requestTimeout = self.setTimeout(() => this.onTimeout(url), timeout);

    xhr.send();
  }

  private onReadyStateChange(xhr: XMLHttpRequest, currentUrl: string) {
    const { context, stats, loaderConfig: config } = this;
    if (!context || !config || this.loader !== xhr || stats.aborted) return;

    if (xhr.readyState >= 2) {
      if (stats.loading.first === 0) {
        stats.loading.first = Math.max(
          self.performance.now(),
          stats.loading.start,
        );

        if (config.loadPolicy.maxLoadTimeMs) {
          self.clearTimeout(this.requestTimeout);
          this.requestTimeout = self.setTimeout(
            () => this.onTimeout(currentUrl),
            config.loadPolicy.maxLoadTimeMs -
              (stats.loading.first - stats.loading.start),
          );
        }
      }

      if (xhr.readyState === 4) {
        self.clearTimeout(this.requestTimeout);
        xhr.onreadystatechange = null;
        xhr.onprogress = null;

        const status = xhr.status;

        if (status >= 200 && status < 300) {
          const data = xhr.response;
          if (data != null) {
            stats.loading.end = Math.max(
              self.performance.now(),
              stats.loading.first,
            );
            const len =
              xhr.responseType === 'arraybuffer'
                ? data.byteLength
                : data.length;
            stats.loaded = stats.total = len;
            stats.bwEstimate =
              (stats.total * 8000) / (stats.loading.end - stats.loading.first);

            this.callbacks?.onProgress?.(stats, context, data, xhr);
            this.callbacks?.onSuccess?.(
              { url: xhr.responseURL, data, code: status },
              stats,
              context,
              xhr,
            );
            return;
          }
        }

        this.handleError(xhr, currentUrl, status);
      }
    }
  }

  private handleError(xhr: XMLHttpRequest, currentUrl: string, status: number) {
    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);

    if (failbackUrl && failbackUrl !== currentUrl) {
      this.failbackAttempt++;

      this.failbackConfig.onFailback?.(
        this.originalUrl,
        failbackUrl,
        this.failbackAttempt,
      );

      console.log(
        `[FailbackLoader] ${currentUrl} failed (${status}), trying: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

    this.failbackConfig.onAllFailed?.(
      this.originalUrl,
      this.failbackAttempt + 1,
    );

    this.callbacks?.onError?.(
      { code: status, text: xhr.statusText },
      this.context as LoaderContext,
      xhr,
      this.stats,
    );
  }

  private onTimeout(currentUrl: string) {
    const failbackUrl = this.getFailbackUrl(this.failbackAttempt);

    if (failbackUrl && failbackUrl !== currentUrl) {
      this.failbackAttempt++;
      this.abortInternal();

      this.failbackConfig.onFailback?.(
        this.originalUrl,
        failbackUrl,
        this.failbackAttempt,
      );

      console.log(
        `[FailbackLoader] ${currentUrl} timeout, trying: ${failbackUrl}`,
      );

      this.loader = null;
      this.loadUrl(failbackUrl);
      return;
    }

    this.failbackConfig.onAllFailed?.(
      this.originalUrl,
      this.failbackAttempt + 1,
    );

    this.abortInternal();
    this.callbacks?.onTimeout?.(
      this.stats,
      this.context as LoaderContext,
      this.loader,
    );
  }

  private onProgress(event: ProgressEvent) {
    this.stats.loaded = event.loaded;
    if (event.lengthComputable) {
      this.stats.total = event.total;
    }
  }

  getCacheAge(): number | null {
    return null;
  }

  getResponseHeader(name: string): string | null {
    return this.loader?.getResponseHeader(name) || null;
  }
}

export default FailbackLoader;
