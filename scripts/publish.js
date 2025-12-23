#!/usr/bin/env node
/* eslint-env node */

/**
 * Publish hls.js variant to npm
 *
 * Usage:
 *   node scripts/publish.js arm   - publishes @armdborg/hls.js from dist-armdb
 *   node scripts/publish.js int   - publishes @intrdb/hls.js from dist-intrdb
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const variants = {
  arm: {
    name: '@armdborg/hls.js',
    distDir: 'dist-armdb',
  },
  int: {
    name: '@intrdb/hls.js',
    distDir: 'dist-intrdb',
  },
};

const variant = process.argv[2];

if (!variant || !variants[variant]) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/publish.js <arm|int>');
  process.exit(1);
}

const config = variants[variant];
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, config.distDir);
const rootPkgPath = path.join(rootDir, 'package.json');
const distPkgPath = path.join(distDir, 'package.json');

// Read root package.json
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));

// Create package.json for publishing
const publishPkg = {
  name: config.name,
  version: rootPkg.version,
  license: rootPkg.license,
  description: rootPkg.description,
  homepage: rootPkg.homepage,
  authors: rootPkg.authors,
  repository: rootPkg.repository,
  bugs: rootPkg.bugs,
  main: './hls.js',
  module: './hls.mjs',
  types: './hls.d.ts',
  exports: {
    '.': {
      import: './hls.mjs',
      require: './hls.js',
    },
    './light': {
      import: './hls.light.mjs',
      require: './hls.light.js',
    },
    './*': './*',
    './package.json': './package.json',
  },
  files: ['*'],
  publishConfig: {
    access: 'public',
  },
};

// eslint-disable-next-line no-console
console.log(
  `Publishing ${config.name}@${rootPkg.version} from ${config.distDir}...`,
);

try {
  // Write package.json to dist folder
  fs.writeFileSync(distPkgPath, JSON.stringify(publishPkg, null, 2) + '\n');

  // Copy LICENSE and README
  fs.copyFileSync(path.join(rootDir, 'LICENSE'), path.join(distDir, 'LICENSE'));
  fs.copyFileSync(
    path.join(rootDir, 'README.md'),
    path.join(distDir, 'README.md'),
  );

  // Publish from dist folder
  execSync('npm publish --access public --tag latest', {
    stdio: 'inherit',
    cwd: distDir,
  });

  // eslint-disable-next-line no-console
  console.log(`Successfully published ${config.name}@${rootPkg.version}`);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('Publish failed:', error.message);
  process.exit(1);
}
