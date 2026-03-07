#!/usr/bin/env node
/* eslint-env node */

/**
 * Publish hls.js variant(s) to npm.
 *
 * Usage:
 *   node scripts/publish.js arm         - publishes @armdborg/hls.js from dist-armdb
 *   node scripts/publish.js int         - publishes @intrdb/hls.js from dist-intrdb
 *   node scripts/publish.js all         - publishes both variants sequentially
 *
 * Environment:
 *   NPM_TAG=latest|failback|next        - npm dist-tag override (default: latest)
 *   NPM_PUBLISH_DRY_RUN=1               - run npm publish in dry-run mode
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const variants = {
  arm: {
    name: '@armdborg/hls.js',
    distDir: 'dist-armdb',
    dnsDomain: 'armfb.turoktv.com',
    fallbackHost: 'failback.turkserial.co',
  },
  int: {
    name: '@intrdb/hls.js',
    distDir: 'dist-intrdb',
    dnsDomain: 'intfb.turoktv.com',
    fallbackHost: 'failback.intrdb.com',
  },
};

const requestedVariant = process.argv[2];
const npmTag = process.env.NPM_TAG || 'latest';
const dryRun =
  process.argv.includes('--dry-run') || process.env.NPM_PUBLISH_DRY_RUN === '1';

if (
  !requestedVariant ||
  (!variants[requestedVariant] && requestedVariant !== 'all')
) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/publish.js <arm|int|all> [--dry-run]');
  process.exit(1);
}

const variantKeys =
  requestedVariant === 'all' ? Object.keys(variants) : [requestedVariant];
const rootDir = path.join(__dirname, '..');
const rootPkgPath = path.join(rootDir, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));

function normalizeRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    return repository;
  }

  if (typeof repository.url !== 'string') {
    return repository;
  }

  if (repository.url.startsWith('git+')) {
    return repository;
  }

  if (repository.url.startsWith('https://github.com/')) {
    return {
      ...repository,
      url: `git+${repository.url.replace(/\.git$/, '')}.git`,
    };
  }

  return repository;
}

function transformDistPath(value) {
  if (typeof value === 'string') {
    if (value.startsWith('./dist/')) {
      return `./${value.slice('./dist/'.length)}`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => transformDistPath(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key.startsWith('./dist/') ? `./${key.slice('./dist/'.length)}` : key,
        transformDistPath(entryValue),
      ]),
    );
  }

  return value;
}

function createVariantReadme(config) {
  return fs
    .readFileSync(path.join(rootDir, 'README.md'), 'utf-8')
    .replace(/@armdborg\/hls\.js/g, config.name)
    .replace(/armfb\.turoktv\.com/g, config.dnsDomain)
    .replace(/failback\.turkserial\.co/g, config.fallbackHost);
}

function createPublishPkg(packageName) {
  const publishPkg = {
    name: packageName,
    version: rootPkg.version,
    license: rootPkg.license,
    description: rootPkg.description,
    homepage: rootPkg.homepage,
    authors: rootPkg.authors,
    repository: normalizeRepository(rootPkg.repository),
    bugs: rootPkg.bugs,
    main: transformDistPath(rootPkg.main),
    module: transformDistPath(rootPkg.module),
    types: transformDistPath(rootPkg.types),
    exports: transformDistPath(rootPkg.exports),
    files: ['*'],
    publishConfig: {
      ...(rootPkg.publishConfig || {}),
      access: 'public',
    },
  };

  const optionalFields = [
    'keywords',
    'sideEffects',
    'funding',
    'type',
    'browser',
    'typesVersions',
  ];

  optionalFields.forEach((field) => {
    if (rootPkg[field] !== undefined) {
      publishPkg[field] = transformDistPath(rootPkg[field]);
    }
  });

  return publishPkg;
}

function assertArtifactsExist(distDir) {
  const requiredFiles = [
    'hls.js',
    'hls.min.js',
    'hls.mjs',
    'hls.light.js',
    'hls.light.mjs',
    'hls.d.ts',
    'hls.d.mts',
    'hls.js.d.ts',
  ];

  requiredFiles.forEach((file) => {
    const filePath = path.join(distDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing build artifact: ${filePath}`);
    }
  });
}

async function versionPublished(packageName, version) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
  );

  if (response.status === 200) {
    return true;
  }

  if (response.status === 404) {
    return false;
  }

  throw new Error(
    `Unexpected npm registry status ${response.status} for ${packageName}@${version}`,
  );
}

async function publishVariant(variantKey) {
  const config = variants[variantKey];
  const distDir = path.join(rootDir, config.distDir);
  const distPkgPath = path.join(distDir, 'package.json');

  if (!fs.existsSync(distDir)) {
    throw new Error(`Build output directory does not exist: ${distDir}`);
  }

  assertArtifactsExist(distDir);

  if (await versionPublished(config.name, rootPkg.version)) {
    // eslint-disable-next-line no-console
    console.log(
      `Skipping ${config.name}@${rootPkg.version} - already published`,
    );
    return;
  }

  const publishPkg = createPublishPkg(config.name);

  // eslint-disable-next-line no-console
  console.log(
    `Publishing ${config.name}@${rootPkg.version} from ${config.distDir} (tag=${npmTag}${dryRun ? ', dry-run' : ''})...`,
  );

  fs.writeFileSync(distPkgPath, JSON.stringify(publishPkg, null, 2) + '\n');
  fs.copyFileSync(path.join(rootDir, 'LICENSE'), path.join(distDir, 'LICENSE'));
  fs.writeFileSync(
    path.join(distDir, 'README.md'),
    createVariantReadme(config),
    'utf-8',
  );

  const publishCommand = [
    'npm',
    'publish',
    '--access',
    publishPkg.publishConfig.access || 'public',
    '--tag',
    npmTag,
    ...(dryRun ? ['--dry-run'] : []),
  ].join(' ');

  execSync(publishCommand, {
    stdio: 'inherit',
    cwd: distDir,
  });

  // eslint-disable-next-line no-console
  console.log(`Successfully published ${config.name}@${rootPkg.version}`);
}

(async () => {
  try {
    await variantKeys.reduce(
      (promise, variantKey) => promise.then(() => publishVariant(variantKey)),
      Promise.resolve(),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Publish failed:', error.message);
    process.exit(1);
  }
})();
