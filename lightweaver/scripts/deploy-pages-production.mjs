import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ProductionLibraryConfigurationError,
  readProductionLibraryConfiguration,
} from './require-cloud-library-production.mjs';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const REDIRECT_PATH = join(PROJECT_DIR, '.wrangler', 'deploy', 'config.json');

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function productionWranglerToml(config) {
  return `name = "lightweaver"
compatibility_date = "2026-07-15"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = ${tomlString(join(PROJECT_DIR, '.pages', 'lightweaver'))}

[[d1_databases]]
binding = "PROJECTS_DB"
database_name = ${tomlString(config.PROJECTS_DB_DATABASE_NAME)}
database_id = ${tomlString(config.PROJECTS_DB_DATABASE_ID)}

[[r2_buckets]]
binding = "PROJECT_BLOBS"
bucket_name = ${tomlString(config.PROJECT_BLOBS_BUCKET_NAME)}

[vars]
ACCESS_TEAM_DOMAIN = ${tomlString(config.ACCESS_TEAM_DOMAIN)}
ACCESS_AUD = ${tomlString(config.ACCESS_AUD)}
OWNER_EMAILS = ${tomlString(config.OWNER_EMAILS)}
MAX_LIBRARY_BODY_BYTES = ${tomlString(config.MAX_LIBRARY_BODY_BYTES)}
MAX_LIBRARY_BACKUP_BYTES = ${tomlString(config.MAX_LIBRARY_BACKUP_BYTES)}
MAX_LIBRARY_BACKUP_REVISIONS = ${tomlString(config.MAX_LIBRARY_BACKUP_REVISIONS)}
`;
}

function runCommand(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed (${signal || code}).`));
    });
  });
}

async function deployWithGeneratedConfig(config, env, run) {
  const deployDirectory = dirname(REDIRECT_PATH);
  const configPath = join(deployDirectory, `lightweaver-production-${process.pid}-${randomUUID()}.toml`);
  let configCreated = false;
  let redirectCreated = false;
  await mkdir(deployDirectory, { recursive: true, mode: 0o700 });

  try {
    await writeFile(configPath, productionWranglerToml(config), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    configCreated = true;
    await writeFile(REDIRECT_PATH, `${JSON.stringify({ configPath: basename(configPath) }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    redirectCreated = true;
    await run('wrangler', [
      'pages', 'deploy', '.pages/lightweaver', '--project-name', 'lightweaver', '--branch', 'main',
    ], env);
  } finally {
    if (redirectCreated) await rm(REDIRECT_PATH, { force: true });
    if (configCreated) await rm(configPath, { force: true });
  }
}

export async function deployProductionPages({ env = process.env, run = runCommand } = {}) {
  const config = readProductionLibraryConfiguration(env);
  await run('npm', ['run', 'build'], env);
  await run('npm', ['run', 'stage:pages'], env);
  await run('npm', ['run', 'verify:pages'], env);
  await deployWithGeneratedConfig(config, env, run);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    await deployProductionPages();
  } catch (error) {
    console.error(error instanceof ProductionLibraryConfigurationError
      ? error.message
      : `Production Pages deployment failed: ${error.message}`);
    process.exitCode = 1;
  }
}
