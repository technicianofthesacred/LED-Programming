#!/usr/bin/env node
/**
 * ensure-rollup-native.mjs
 *
 * Workaround for npm/cli#4828: npm sometimes silently skips platform-specific
 * optional dependencies (e.g. @rollup/rollup-linux-x64-gnu) on fresh installs,
 * causing Vite/Rollup builds to crash with "Cannot find module …".
 *
 * Run this BEFORE any `vite build` call. It detects the missing native package
 * and installs it with --no-save so the package.json is not modified.
 *
 * Usage (called automatically by launch:check and go-live.sh):
 *   node lightweaver/scripts/ensure-rollup-native.mjs
 */

import { execSync } from 'child_process';

const platform = process.platform;   // 'linux', 'darwin', 'win32'
const arch     = process.arch;       // 'x64', 'arm64', …

// Build the platform-specific package name Rollup expects.
// Linux always needs the '-gnu' suffix; other platforms do not.
const suffix = platform === 'linux' ? '-gnu' : '';
const nativePkg = `@rollup/rollup-${platform}-${arch}${suffix}`;

let needed = false;
try {
  // Try to resolve the package from Node's module resolution.
  // execSync lets us do a clean sub-process require check without
  // permanently polluting this process's module cache.
  execSync(`node -e "require('${nativePkg}')"`, { stdio: 'ignore' });
} catch {
  needed = true;
}

if (!needed) {
  console.log(`[ensure-rollup-native] ${nativePkg} is present — nothing to do.`);
  process.exit(0);
}

console.log(`[ensure-rollup-native] ${nativePkg} missing — installing (--no-save)…`);
try {
  execSync(`npm install --no-save ${nativePkg}`, { stdio: 'inherit' });
  console.log(`[ensure-rollup-native] ${nativePkg} installed successfully.`);
} catch (err) {
  console.error(`[ensure-rollup-native] Failed to install ${nativePkg}: ${err.message}`);
  process.exit(1);
}
