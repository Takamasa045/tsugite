#!/usr/bin/env bash
# Run from the repository root. Only this helper's uniquely owned scratch is removable.
set -euo pipefail
exec node --input-type=module - "$@" <<'JS'
import {
  cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const root = realpathSync(process.cwd());
const relativeSkill = '.cursor/skills/verify-tsugite-manual';
const scratchParent = join(root, relativeSkill, 'tmp');
const ownerName = '.verify-tsugite-owner.json';
const args = process.argv.slice(2);

function requireDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('expected a real directory');
}

function requireRegularFile(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('expected a regular file');
}

function checkTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('symlinks are not allowed in the fixture or scratch');
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) checkTree(join(path, child));
  } else if (!stat.isFile()) {
    throw new Error('special files are not allowed in the fixture or scratch');
  }
}

function checkParents() {
  for (const segment of ['.cursor', '.cursor/skills', relativeSkill]) {
    requireDirectory(join(root, segment));
  }
  // lstat also rejects dangling links; never mkdir through a link.
  try { requireDirectory(scratchParent); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(scratchParent, { mode: 0o700 });
  }
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

try {
  requireRegularFile(join(root, 'package.json'));
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'tsugite') {
    throw new Error('run this helper from the Tsugite repository root');
  }
  requireRegularFile(join(root, 'bin/pipeline'));
  if (args.length !== 0 && !(args.length === 3 && args[0] === '--cleanup')) {
    throw new Error('usage: isolate-local-fixture.sh [--cleanup <run-dir> <run-id>]');
  }
  checkParents();

  if (args[0] === '--cleanup') {
    const runDir = resolve(args[1]);
    const runId = args[2];
    if (dirname(runDir) !== scratchParent || !/^run-[A-Za-z0-9]+$/.test(basename(runDir))) {
      throw new Error('cleanup target is outside this helper scratch');
    }
    requireDirectory(runDir);
    if (realpathSync(runDir) !== runDir) throw new Error('cleanup path identity changed');
    const marker = join(runDir, ownerName);
    requireRegularFile(marker);
    const owner = JSON.parse(readFileSync(marker, 'utf8'));
    if (owner.repo !== root || owner.run_dir !== runDir || owner.run_id !== runId) {
      throw new Error('scratch ownership does not match');
    }
    checkTree(runDir);
    // Recheck the boundary immediately before the only recursive deletion.
    requireDirectory(scratchParent);
    requireDirectory(runDir);
    rmSync(runDir, { recursive: true, force: false });
    process.stdout.write(JSON.stringify({ ok: true, removed: runDir }) + '\n');
  } else {
    const source = join(root, 'examples/local-fixture');
    requireDirectory(join(root, 'examples'));
    requireDirectory(source);
    requireRegularFile(join(source, 'project.yaml'));
    requireRegularFile(join(source, 'media/clip-001.mp4'));
    requireRegularFile(join(source, 'media/clip-002.mp4'));
    checkTree(source);
    const runDir = mkdtempSync(join(scratchParent, 'run-'));
    const runId = randomUUID();
    // Write ownership first. A failed copy leaves an identifiable run for explicit cleanup.
    writeFileSync(join(runDir, ownerName), JSON.stringify({ repo: root, run_dir: runDir, run_id: runId }), { flag: 'wx', mode: 0o600 });
    const projectsHome = join(runDir, 'projects-home');
    mkdirSync(projectsHome, { mode: 0o700 });
    const projectDir = join(projectsHome, 'verify-local-fixture');
    cpSync(source, projectDir, { recursive: true, errorOnExist: true, force: false });
    checkTree(projectDir);
    const values = {
      VERIFY_RUN_DIR: runDir,
      VERIFY_RUN_ID: runId,
      TSUGITE_PROJECTS_HOME: projectsHome,
      VERIFY_CONFIG: join(projectDir, 'project.yaml')
    };
    for (const [key, value] of Object.entries(values)) process.stdout.write(`export ${key}=${shellQuote(value)}\n`);
  }
} catch (error) {
  process.stderr.write(`fixture isolation blocked: ${error.message}\n`);
  process.exitCode = 1;
}
JS
