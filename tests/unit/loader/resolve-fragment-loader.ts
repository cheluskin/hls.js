import { expect } from 'chai';
import { hlsDefaultConfig, mergeConfig } from '../../../src/config';
import { resolveFragmentLoaderConstructor } from '../../../src/loader/resolve-fragment-loader';
import FailbackLoader from '../../../src/utils/failback-loader';
import FetchLoader from '../../../src/utils/fetch-loader';
import { logger } from '../../../src/utils/logger';
import XhrLoader from '../../../src/utils/xhr-loader';

describe('resolveFragmentLoaderConstructor', function () {
  it('uses FailbackLoader when loader is the default XhrLoader', function () {
    const config = mergeConfig(hlsDefaultConfig, { loader: XhrLoader }, logger);
    expect(resolveFragmentLoaderConstructor(config)).to.equal(FailbackLoader);
  });

  it('uses a custom fLoader when provided', function () {
    const config = mergeConfig(
      hlsDefaultConfig,
      { loader: XhrLoader, fLoader: FetchLoader as any },
      logger,
    );
    expect(resolveFragmentLoaderConstructor(config)).to.equal(FetchLoader);
  });

  it('does not replace a non-XhrLoader loader', function () {
    const config = mergeConfig(
      hlsDefaultConfig,
      { loader: FetchLoader },
      logger,
    );
    expect(resolveFragmentLoaderConstructor(config)).to.equal(FetchLoader);
  });
});
