import FailbackLoader from '../utils/failback-loader';
import XhrLoader from '../utils/xhr-loader';
import type { FragmentLoaderConstructor, HlsConfig } from '../config';

/**
 * Choose the fragment loader constructor.
 *
 * Custom `fLoader` always wins. When the default `XhrLoader` is still in
 * place, route through FailbackLoader so CDN failover applies. Any other
 * `loader` (FetchLoader, a developer-supplied class) is left untouched.
 *
 * Shared by FragmentLoader and CMCDController so enabling CMCD cannot
 * silently wrap XhrLoader and bypass failback.
 */
export function resolveFragmentLoaderConstructor(
  config: HlsConfig,
): FragmentLoaderConstructor {
  if (config.fLoader) {
    return config.fLoader;
  }
  if (config.loader === XhrLoader) {
    return FailbackLoader as FragmentLoaderConstructor;
  }
  return config.loader as FragmentLoaderConstructor;
}
