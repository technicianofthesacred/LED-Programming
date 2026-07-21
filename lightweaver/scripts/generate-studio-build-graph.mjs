import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStudioBuildGraph } from '../src/lib/productionDeploymentCheck.js';

const GRAPH_FILE = 'studio-build-graph.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function collectCodeAssets(root, relativeDirectory = 'assets') {
  const directory = join(root, ...relativeDirectory.split('/'));
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(`Staged Studio assets must not contain symbolic links: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      paths.push(...await collectCodeAssets(root, relativePath));
    } else if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) {
      paths.push(relativePath);
    }
  }
  return paths;
}

export async function generateStudioBuildGraph(stagedRoot) {
  const root = resolve(stagedRoot);
  const paths = [...await collectCodeAssets(root), 'index.html']
    .sort();
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(join(root, ...path.split('/')));
    files.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const graph = parseStudioBuildGraph(JSON.stringify({ schemaVersion: 1, files }));
  const output = `${JSON.stringify(graph, null, 2)}\n`;
  await writeFile(join(root, GRAPH_FILE), output);
  return graph;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const stagedRoot = process.argv[2];
  if (!stagedRoot) throw new Error('Usage: node scripts/generate-studio-build-graph.mjs <staged-root>');
  const graph = await generateStudioBuildGraph(stagedRoot);
  console.log(`Studio build graph: ${graph.files.length} files`);
}
