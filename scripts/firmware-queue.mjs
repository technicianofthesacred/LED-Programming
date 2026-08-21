#!/usr/bin/env node
//
// The waiting list for the next card update.
//
// WHY THIS EXISTS. Publishing a card update is deliberately expensive: it
// signs a binary and offers it to every card in a customer's home, so it is
// gated on a hand-made VERSION bump. That gate is correct. Its side effect is
// that small, safe changes which happen to be classified firmware-sensitive
// get put off — and "put off" used to mean a paragraph in TODO.md, a patch
// file on one laptop, and a git stash that a single `git stash clear` would
// have destroyed. Three storage places, two outside version control.
//
// This file replaces all three with one register that lives in the repo:
//
//   firmware-queue/queue.json      what is waiting, in plain language
//   firmware-queue/patches/*.patch the actual changes, committed, not stashed
//
// Three commands:
//
//   node scripts/firmware-queue.mjs                 what is waiting
//   node scripts/firmware-queue.mjs add ...         park a change
//   node scripts/firmware-queue.mjs release         gather it all into one PR
//
// Everything this prints to a person is written for a person. No identifiers,
// no file paths, no jargon in the human-facing lines — Adrian types one thing
// and is told plainly what is waiting or what just happened.
//
// SAFETY. `release` never touches the working tree you run it from. It builds
// the release in a throwaway private worktree, and if anything at all refuses
// to apply it names which item failed, throws the worktree away, and stops.
// A half-applied firmware release is far worse than a blocked one.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const QUEUE_DIRECTORY = 'firmware-queue';
export const QUEUE_FILE = `${QUEUE_DIRECTORY}/queue.json`;
export const PATCH_DIRECTORY = `${QUEUE_DIRECTORY}/patches`;
const VERSION_FILE = 'firmware/lightweaver-controller/VERSION';
const VERSION_POLICY_FILE = 'firmware/lightweaver-controller/tests/firmware-version-policy.mjs';
const SIGNED_MANIFEST_FILE = 'lightweaver/public/firmware/release-manifest.json';

const REGISTER_NOTE = 'Changes that are finished but are waiting for the next card update, '
  + 'because sending one costs a signed update to every card in a customer\'s home. '
  + 'Run "npm run firmware:waiting" to read this, and "npm run firmware:release" to carry it all at once.';

// ---------------------------------------------------------------- register --

export function emptyRegister() {
  return { note: REGISTER_NOTE, waiting: [] };
}

export function readRegister(root = repoRoot) {
  const path = join(root, QUEUE_FILE);
  if (!existsSync(path)) return emptyRegister();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed?.waiting)) {
    throw new Error('The waiting list file is damaged: it has no list of waiting items.');
  }
  return { note: parsed.note || REGISTER_NOTE, waiting: parsed.waiting };
}

export function writeRegister(register, root = repoRoot) {
  mkdirSync(join(root, QUEUE_DIRECTORY), { recursive: true });
  writeFileSync(
    join(root, QUEUE_FILE),
    `${JSON.stringify({ note: REGISTER_NOTE, waiting: register.waiting }, null, 2)}\n`,
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function validateEntry(entry, existing = []) {
  if (!SLUG.test(String(entry.id || ''))) {
    throw new Error('Every waiting item needs a short lowercase name made of letters, numbers and dashes.');
  }
  if (existing.some(other => other.id === entry.id)) {
    throw new Error(`Something is already waiting under the name "${entry.id}".`);
  }
  for (const field of ['what', 'why']) {
    if (!String(entry[field] || '').trim()) {
      throw new Error(`Every waiting item needs a plain-language "${field}".`);
    }
  }
  const kind = entry.source?.kind;
  if (kind === 'branch') {
    if (!String(entry.source.branch || '').trim()) throw new Error('A parked branch needs a branch name.');
  } else if (kind === 'patch') {
    if (!String(entry.source.patch || '').trim()) throw new Error('A parked patch needs a patch file.');
  } else {
    throw new Error('A waiting item must point at either a branch or a patch file.');
  }
  return entry;
}

// ------------------------------------------------------------------- words --

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function readableDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return 'an unknown date';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

const COUNT_WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export function countInWords(total) {
  return COUNT_WORDS[total] || String(total);
}

export function describeRegister(register) {
  const items = register.waiting;
  if (items.length === 0) {
    return [
      'Nothing is waiting.',
      '',
      'The next card update has nothing extra to carry, so you only need to send one',
      'when you actually want to change what the cards do.',
    ].join('\n');
  }
  const lines = [];
  lines.push(items.length === 1
    ? 'One thing is waiting for the next card update.'
    : `${countInWords(items.length)} things are waiting for the next card update.`);
  lines.push('');
  items.forEach((entry, index) => {
    lines.push(`  ${index + 1}. ${entry.what.trim()}`);
    lines.push(`     Why it is waiting: ${entry.why.trim()}`);
    lines.push(`     Added ${readableDate(entry.added)}.`);
    lines.push('');
  });
  lines.push('When you want to send them, run this and nothing else:');
  lines.push('');
  lines.push('    npm run firmware:release');
  lines.push('');
  lines.push('That collects everything above into a single pull request for you to look at.');
  lines.push('It stops there. Nothing reaches anybody\'s card until you say so.');
  return lines.join('\n');
}

// --------------------------------------------------------------------- git --

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

// ----------------------------------------------------------------- version --

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`Not a version number: ${value}`);
  return match.slice(1).map(Number);
}

export function isGreater(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

// The next version must beat BOTH what the tree says and what has actually
// been signed and published, or the signer refuses the release at the very end
// of a twenty-minute job.
export function nextVersion(currentVersion, signedVersion) {
  const highest = isGreater(signedVersion, currentVersion) ? signedVersion : currentVersion;
  const parts = parseVersion(highest);
  parts[2] += 1;
  return parts.join('.');
}

function applyVersionBump(root, version) {
  writeFileSync(join(root, VERSION_FILE), `${version}\n`);
  const policyPath = join(root, VERSION_POLICY_FILE);
  const policy = readFileSync(policyPath, 'utf8');
  const pinned = /assert\.equal\(readFileSync\(versionPath, 'utf8'\)\.trim\(\), '(\d+\.\d+\.\d+)'\);/;
  if (!pinned.test(policy)) {
    throw new Error('Could not find the pinned version number that has to move with the release.');
  }
  writeFileSync(policyPath, policy.replace(
    pinned,
    `assert.equal(readFileSync(versionPath, 'utf8').trim(), '${version}');`,
  ));
}

// -------------------------------------------------------------- add command --

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else { flags[name] = next; index += 1; }
  }
  return flags;
}

function commandAdd(argv) {
  const flags = parseFlags(argv);
  const register = readRegister();
  const id = String(flags.id || flags.branch || '').split('/').pop();
  const entry = {
    id,
    what: String(flags.what || ''),
    why: String(flags.why || 'Landing it on its own would publish a signed update to every card in a customer\'s home for a change no card can see.'),
    added: new Date().toISOString().slice(0, 10),
    source: null,
  };

  if (flags.branch) {
    entry.source = { kind: 'branch', branch: String(flags.branch) };
    if (flags.pr) entry.source.pullRequest = Number(flags.pr);
  } else if (flags.patch) {
    mkdirSync(join(repoRoot, PATCH_DIRECTORY), { recursive: true });
    const destination = `${PATCH_DIRECTORY}/${id}.patch`;
    copyFileSync(resolve(process.cwd(), String(flags.patch)), join(repoRoot, destination));
    entry.source = { kind: 'patch', patch: destination };
  } else if (flags['from-diff']) {
    const base = typeof flags['from-diff'] === 'string' ? flags['from-diff'] : 'origin/main';
    const mergeBase = git(['merge-base', base, 'HEAD']);
    const diff = execFileSync('git', ['diff', '--binary', mergeBase], { cwd: repoRoot, encoding: 'utf8' });
    if (!diff.trim()) throw new Error('There is nothing different from the main line to park.');
    mkdirSync(join(repoRoot, PATCH_DIRECTORY), { recursive: true });
    const destination = `${PATCH_DIRECTORY}/${id}.patch`;
    writeFileSync(join(repoRoot, destination), diff);
    entry.source = { kind: 'patch', patch: destination };
  } else {
    throw new Error('Say where the change lives: --branch <name>, --patch <file>, or --from-diff.');
  }

  validateEntry(entry, register.waiting);
  register.waiting.push(entry);
  writeRegister(register);

  process.stdout.write([
    '',
    'Parked for the next card update:',
    '',
    `  ${entry.what.trim()}`,
    '',
    'It is written down in the repository now, so nothing can lose it, and it will be',
    'picked up automatically the next time a card update goes out.',
    '',
    `${countInWords(register.waiting.length)} ${register.waiting.length === 1 ? 'thing is' : 'things are'} waiting in total.`,
    '',
  ].join('\n'));
  return 0;
}

// ---------------------------------------------------------- release command --

// GH_HOST is set on this machine to an ssh alias, which misroutes the GitHub
// command-line tool. Strip it for the one call that uses it.
function ghEnvironment() {
  const environment = { ...process.env };
  delete environment.GH_HOST;
  return environment;
}

function fail(message, detail = '') {
  process.stderr.write(`\nStopped. Nothing was changed.\n\n${message}\n${detail ? `\n${detail}\n` : ''}\n`);
  return 1;
}

function commandRelease(argv) {
  const flags = parseFlags(argv);
  const register = readRegister();
  if (register.waiting.length === 0) {
    process.stdout.write('\nNothing is waiting, so there is nothing to send.\n\n');
    return 0;
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    return fail(
      'You have unsaved edits open. Save or put them aside first, then run this again.',
      'This is refused on purpose: a card update built on half-finished work is the one\n'
      + 'thing worse than not sending one at all.',
    );
  }

  if (!flags['no-fetch']) {
    const fetched = tryGit(['fetch', 'origin', '--quiet']);
    if (!fetched.ok && !flags.offline) {
      return fail('Could not reach the shared copy of the project. Check the internet connection and try again.');
    }
  }

  const base = String(flags.base || 'origin/main');
  // Read the starting state from the base itself, never from whatever branch
  // this happens to be run from — the release is built on the main line.
  const currentVersion = git(['show', `${base}:${VERSION_FILE}`]).trim();
  const signedVersion = JSON.parse(git(['show', `${base}:${SIGNED_MANIFEST_FILE}`])).firmwareVersion;
  const version = nextVersion(currentVersion, signedVersion);
  const branch = `firmware-release/${version}`;

  const workspace = mkdtempSync(join(tmpdir(), 'lightweaver-release-'));
  const scratch = join(workspace, 'tree');
  let created = false;

  const cleanUp = ({ keepBranch = false } = {}) => {
    if (created) tryGit(['worktree', 'remove', '--force', scratch]);
    rmSync(workspace, { recursive: true, force: true });
    if (!keepBranch) tryGit(['branch', '-D', branch]);
  };

  try {
    const added = tryGit(['worktree', 'add', '--quiet', '-b', branch, scratch, base]);
    if (!added.ok) {
      cleanUp();
      return fail('Could not set up a private space to build the update in.', added.out);
    }
    created = true;

    // From here on the base's own copy of the waiting list is what counts —
    // the release is built on the main line, not on whatever branch this was
    // run from.
    const waiting = readRegister(scratch).waiting;
    if (waiting.length === 0) {
      cleanUp();
      return fail('The waiting list on the main line is empty, even though your copy shows items.',
        'Your copy of the project is out of step. Bring it up to date and try again.');
    }
    register.waiting = waiting;

    process.stdout.write(`\nGathering ${countInWords(register.waiting.length).toLowerCase()} `
      + `${register.waiting.length === 1 ? 'change' : 'changes'} into one card update.\n\n`);

    // Branches first, patches second. A merge needs a clean index, so parked
    // patches — which are staged but not committed until the single release
    // commit at the end — have to come after every merge, not interleaved.
    const ordered = [
      ...register.waiting.filter(entry => entry.source.kind === 'branch'),
      ...register.waiting.filter(entry => entry.source.kind !== 'branch'),
    ];

    for (const entry of ordered) {
      process.stdout.write(`  Adding: ${entry.what.trim()}\n`);
      if (entry.source.kind === 'branch') {
        const reference = `origin/${entry.source.branch}`;
        const known = tryGit(['rev-parse', '--verify', `${reference}^{commit}`], { cwd: scratch });
        if (!known.ok) {
          cleanUp();
          return fail(
            `One of the waiting changes has gone missing: "${entry.what.trim()}"`,
            'The work it pointed at is no longer in the shared copy of the project. Nothing\n'
            + 'was applied. Either restore it, or take it off the waiting list, then try again.',
          );
        }
        const merged = tryGit(['merge', '--no-ff', '--no-edit', reference], { cwd: scratch });
        if (!merged.ok) {
          cleanUp();
          return fail(
            `One of the waiting changes no longer fits: "${entry.what.trim()}"`,
            'The project has moved on since it was written, and it now clashes with something\n'
            + 'newer. Nothing was applied and nothing was left half-done. That one change needs\n'
            + 'redoing against the current project before the update can go out.',
          );
        }
      } else {
        const patchPath = join(scratch, entry.source.patch);
        if (!existsSync(patchPath)) {
          cleanUp();
          return fail(
            `One of the waiting changes has gone missing: "${entry.what.trim()}"`,
            'Its saved copy is not where the waiting list says it is. Nothing was applied.',
          );
        }
        const applied = tryGit(['apply', '--index', '--3way', patchPath], { cwd: scratch });
        if (!applied.ok) {
          cleanUp();
          return fail(
            `One of the waiting changes no longer fits: "${entry.what.trim()}"`,
            'The project has moved on since it was written, and it can no longer be applied\n'
            + 'cleanly. Nothing was applied and nothing was left half-done. That one change\n'
            + 'needs redoing against the current project before the update can go out.',
          );
        }
      }
    }

    // Everything applied. Now the two edits that make it an actual release,
    // and the clearing of what was just consumed so nothing is ever applied
    // twice.
    applyVersionBump(scratch, version);
    for (const entry of register.waiting) {
      if (entry.source.kind === 'patch') {
        rmSync(join(scratch, entry.source.patch), { force: true });
      }
    }
    writeRegister({ waiting: [] }, scratch);

    const summary = register.waiting.map((entry, index) => `${index + 1}. ${entry.what.trim()}`).join('\n');
    const message = [
      `Send a card update carrying ${register.waiting.length} parked ${register.waiting.length === 1 ? 'change' : 'changes'}`,
      '',
      'These were finished earlier and deliberately held back, because each one on its',
      'own would have published a signed update to every card in a customer\'s home for',
      'a change no card can see. They go out together instead, on one version bump.',
      '',
      summary,
      '',
      `Firmware version ${currentVersion} -> ${version}, with its pinned copy in the version`,
      'test moved to match. The waiting list is emptied in this same change, so nothing',
      'here can be applied a second time.',
      '',
      'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    ].join('\n');

    git(['add', '-A'], { cwd: scratch });
    git(['commit', '--quiet', '-m', message], { cwd: scratch });

    if (flags['dry-run']) {
      const head = git(['rev-parse', 'HEAD'], { cwd: scratch });
      cleanUp({ keepBranch: true });
      process.stdout.write([
        '',
        'Rehearsal only. Everything fitted together and the update was built, but nothing',
        'was sent anywhere. It is kept locally for inspection as:',
        '',
        `  ${branch} (${head.slice(0, 12)})`,
        '',
      ].join('\n'));
      return 0;
    }

    const pushed = tryGit(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: scratch });
    if (!pushed.ok) {
      cleanUp();
      return fail('Everything fitted together, but it could not be sent to the shared copy of the project.', pushed.out);
    }

    const pr = spawnSync('gh', [
      'pr', 'create',
      '--base', 'main',
      '--head', branch,
      '--title', `Send a card update carrying ${register.waiting.length} parked ${register.waiting.length === 1 ? 'change' : 'changes'}`,
      '--body', `${message.replace(/\nCo-Authored-By:.*$/s, '')}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
    ], { cwd: scratch, encoding: 'utf8', env: ghEnvironment() });

    const url = String(pr.stdout || '').trim();
    cleanUp();

    if (pr.status !== 0) {
      process.stdout.write([
        '',
        'Everything fitted together and it has been sent up, but the pull request could',
        'not be opened automatically. Open it by hand and it is ready to go.',
        '',
      ].join('\n'));
      process.stderr.write(`${pr.stderr || ''}\n`);
      return 1;
    }

    process.stdout.write([
      '',
      'Done. Everything that was waiting is now in one pull request:',
      '',
      `  ${url}`,
      '',
      'The waiting list is empty again. Nothing has been published — look it over, and',
      'it goes out to the cards when you merge it.',
      '',
    ].join('\n'));
    return 0;
  } catch (error) {
    cleanUp();
    return fail('Something went wrong while gathering the changes, so it was all undone.', String(error?.message || error));
  }
}

// -------------------------------------------------------------------- main --

function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'status' || command === 'list') {
      process.stdout.write(`\n${describeRegister(readRegister())}\n\n`);
      return 0;
    }
    if (command === 'add') return commandAdd(rest);
    if (command === 'release' || command === 'redeem') return commandRelease(rest);
    process.stderr.write(`\nUnknown command "${command}". Try: status, add, release.\n\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`\n${error?.message || error}\n\n`);
    return 1;
  }
}

// realpathSync matters: Node resolves symbolic links when it loads a module,
// so on a Mac (where /tmp is a link to /private/tmp) the raw argument and the
// module's own address disagree and this would silently do nothing at all.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
