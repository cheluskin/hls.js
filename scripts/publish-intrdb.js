#!/usr/bin/env node
/* eslint-env node */

/**
 * Publish @intrdb/hls.js variant
 *
 * This script:
 * 1. Temporarily modifies package.json with intrdb name
 * 2. Publishes to npm
 * 3. Restores original package.json
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');

// Read original package.json
const originalContent = fs.readFileSync(packagePath, 'utf-8');
const pkg = JSON.parse(originalContent);

// Modify for intrdb
pkg.name = '@intrdb/hls.js';

// eslint-disable-next-line no-console
console.log(`Publishing ${pkg.name}@${pkg.version}...`);

try {
  // Write modified package.json
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

  // Publish
  execSync('npm publish --access public', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });

  // eslint-disable-next-line no-console
  console.log(`Successfully published ${pkg.name}@${pkg.version}`);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('Publish failed:', error.message);
  process.exit(1);
} finally {
  // Restore original package.json
  fs.writeFileSync(packagePath, originalContent);
  // eslint-disable-next-line no-console
  console.log('Restored original package.json');
}
