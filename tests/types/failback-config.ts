import type { HlsConfig as ConfigHlsConfig } from '../../src/config';
import type { FailbackConfig as NamedFailbackConfig } from '../../src/exports-named';
import type Hls from '../../src/hls';
import type {
  FailbackConfig as PublicFailbackConfig,
  HlsConfig as PublicHlsConfig,
} from '../../src/hls';

const failbackConfig = {
  staticHosts: ['failback.example.com:8443'],
  enableCacheControlHeader: true,
  verbose: true,
  transformUrl: (url: string, attempt: number) =>
    attempt > 1 ? null : `${url}?attempt=${attempt}`,
} satisfies PublicFailbackConfig;

const configFromConfig: Partial<ConfigHlsConfig> = {
  failbackConfig,
};

const configFromHls: Partial<PublicHlsConfig> = {
  failbackConfig,
};

type ConstructorFailbackConfig = NonNullable<
  ConstructorParameters<typeof Hls>[0]
>['failbackConfig'];

const constructorFailbackConfig: ConstructorFailbackConfig = failbackConfig;
const namedFailbackConfig: NamedFailbackConfig = failbackConfig;

export const failbackTypeCoverage = {
  configFromConfig,
  configFromHls,
  constructorFailbackConfig,
  namedFailbackConfig,
};
