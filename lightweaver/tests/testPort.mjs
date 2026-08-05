// Conductor runs several workspaces off this repo at once, and every one of
// them used to default to the same test port. Playwright's
// `reuseExistingServer` would then find the Vite server that ANOTHER workspace
// had started, adopt it, and run the whole suite against that workspace's
// source — reporting a clean pass for code the run never loaded. That is worse
// than a failing test: it manufactures false evidence.
//
// Derive the port from this checkout's own path so each workspace gets its own.
// It stays deterministic, so repeat runs inside one workspace still reuse their
// server (and Vite watches the files, so a reused server is never stale).
//
// Override with LIGHTWEAVER_TEST_PORT when you need a specific port.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// A 500-wide band clear of the app dev port (9999) and the old shared default
// (9997). Two workspaces colliding needs a hash collision, not merely a second
// window open.
export const PORT_BAND_START = 9200;
export const PORT_BAND_SIZE = 500;

export function derivePort(workspaceRoot) {
  const digest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 8);
  return PORT_BAND_START + (parseInt(digest, 16) % PORT_BAND_SIZE);
}

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const testPort = Number(process.env.LIGHTWEAVER_TEST_PORT || derivePort(workspaceRoot));
export const testBaseURL = `http://localhost:${testPort}`;
