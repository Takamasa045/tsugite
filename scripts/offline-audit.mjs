import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.7.0';
const HASHES = {
  darwin_arm64: 'd4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b',
  darwin_amd64: 'e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45',
  linux_amd64: '160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b',
  linux_arm64: '4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7',
  windows_amd64: '9964ed64ec9a387391eb4cc006ad5c531154821aef29b793e02c448de4686438',
  windows_arm64: '3e630381c1f1fd3c9c4d447e6ff2ef6c737083371722773db8337eead0f97962',
};
const RANK = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4, UNKNOWN: 5 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyInventory(result, locks) {
  for (const [path, lock] of locks) {
    const sources = result.results.filter(source => resolve(source.source.path) === path);
    const scanned = new Set(sources.flatMap(source => source.packages ?? [])
      .map(item => `${item.package.name}@${item.package.version}`));
    const expected = Object.entries(lock.packages).filter(([key, pkg]) => key.includes('node_modules/') && !pkg.link && pkg.version)
      .map(([key, pkg]) => `${pkg.name ?? key.split('node_modules/').at(-1)}@${pkg.version}`);
    if (!expected.length || expected.some(name => !scanned.has(name)))
      throw new Error('offline scanner omitted lockfile packages; audit is unverified');
  }
}

export function findingsFor(result, locks, { omitDev = false, level = 'moderate' } = {}) {
  const threshold = RANK[level.toUpperCase()];
  if (!threshold || level.toUpperCase() === 'UNKNOWN') throw new Error('invalid audit level');
  const findings = [];
  for (const source of result.results ?? []) {
    const lock = locks.get(resolve(source.source.path));
    if (!lock) throw new Error('scanner returned an unexpected lockfile');
    for (const item of source.packages ?? []) {
      const { name, version } = item.package;
      const entries = Object.entries(lock.packages).filter(([path, pkg]) =>
        path && (pkg.name ?? path.split('node_modules/').at(-1)) === name && pkg.version === version);
      const devOnly = entries.length > 0 && entries.every(([, pkg]) => pkg.dev === true);
      if (omitDev && devOnly) continue;
      for (const vulnerability of item.vulnerabilities ?? []) {
        let severity = vulnerability.database_specific?.severity?.toUpperCase();
        if (!RANK[severity]) {
          const group = item.groups?.find(group => group.ids.includes(vulnerability.id));
          const score = Number(group?.max_severity);
          severity = group?.max_severity && Number.isFinite(score)
            ? score >= 9 ? 'CRITICAL' : score >= 7 ? 'HIGH' : score >= 4 ? 'MODERATE' : 'LOW'
            : 'UNKNOWN';
        }
        findings.push({ lockfile: source.source.path, package: name, version, devOnly,
          id: vulnerability.id, severity, blocking: RANK[severity] >= threshold });
      }
    }
  }
  return findings;
}

async function download(url, target) {
  const response = await fetch(url, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`public database/tool download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 512 * 1024 * 1024) throw new Error('invalid download size');
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
  return { bytes: bytes.length, sha256: digest(bytes), lastModified: response.headers.get('last-modified') };
}

async function prepare(cache) {
  const system = platform() === 'win32' ? 'windows' : platform();
  const machine = arch() === 'x64' ? 'amd64' : arch();
  const key = `${system}_${machine}`;
  if (!HASHES[key]) throw new Error(`unsupported scanner platform ${key}`);
  const asset = `osv-scanner_${key}${system === 'windows' ? '.exe' : ''}`;
  const binary = join(cache, VERSION, asset);
  let valid = false;
  try { valid = digest(await readFile(binary)) === HASHES[key]; } catch {}
  if (!valid) {
    await download(`https://github.com/google/osv-scanner/releases/download/v${VERSION}/${asset}`, binary);
    if (digest(await readFile(binary)) !== HASHES[key]) throw new Error('scanner checksum mismatch');
  }
  if (system !== 'windows') await chmod(binary, 0o755);
  const database = join(cache, 'db', 'osv-scalibr', 'npm', 'all.zip');
  let fresh = false;
  try {
    const metadata = JSON.parse(await readFile(`${database}.metadata.json`, 'utf8'));
    const age = Date.now() - Date.parse(metadata.fetchedAt);
    fresh = age >= 0 && age < 24 * 60 * 60 * 1000 &&
      metadata.bytes === (await stat(database)).size && digest(await readFile(database)) === metadata.sha256;
  } catch {}
  if (!fresh) {
    const metadata = await download('https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip', database);
    await writeFile(`${database}.metadata.json`, JSON.stringify({ ...metadata, fetchedAt: new Date().toISOString() }));
  }
  return { binary, database };
}

export async function main(args = process.argv.slice(2)) {
  const paths = []; let omitDev = false; let informational = false; let level = 'moderate';
  for (const arg of args) {
    if (arg === '--omit=dev') omitDev = true;
    else if (arg === '--informational') informational = true;
    else if (arg.startsWith('--audit-level=')) level = arg.slice('--audit-level='.length);
    else if (arg.startsWith('-')) throw new Error(`unsupported option ${arg}`);
    else paths.push(resolve(arg));
  }
  if (!paths.length) paths.push(resolve('package-lock.json'));
  const locks = new Map();
  for (const path of paths) {
    const lock = JSON.parse(await readFile(path, 'utf8'));
    if (!lock.packages || !Object.keys(lock.packages).some(key => key.includes('node_modules/')))
      throw new Error('missing or unsupported lockfile inventory');
    locks.set(path, lock);
  }
  const cache = resolve(process.env.NODE_SECURITY_CACHE_DIR ?? join(tmpdir(), 'node-security-offline-audit'));
  const { binary, database } = await prepare(cache);
  const output = join(cache, `result-${randomUUID()}.json`);
  const command = ['scan', 'source', '--offline', '--no-resolve', '--all-packages', '--verbosity=error', '--format=json',
    `--output-file=${output}`, ...paths.map(path => `--lockfile=${path}`)];
  const scan = spawnSync(binary, command, { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: join(cache, 'db') } });
  if (scan.error || ![0, 1].includes(scan.status)) throw new Error('offline scanner failed; audit is unverified');
  const result = JSON.parse(await readFile(output, 'utf8'));
  if (!Array.isArray(result.results)) throw new Error('invalid offline scan result');
  verifyInventory(result, locks);
  const findings = findingsFor(result, locks, { omitDev, level });
  for (const finding of findings) console.log(`${finding.severity} ${finding.package}@${finding.version} ${finding.id} ${finding.devOnly ? 'development' : 'production'}`);
  const blocking = findings.filter(finding => finding.blocking).length;
  console.log(JSON.stringify({ scanner: VERSION, databaseSha256: digest(await readFile(database)),
    lockfiles: paths.length, scope: omitDev ? 'production' : 'all', auditLevel: level,
    findings: findings.length, blocking, informational, inventorySent: false }));
  return blocking && !informational ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
