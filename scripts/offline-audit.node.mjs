import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { findingsFor, main, verifyInventory } from './offline-audit.mjs';

const path = resolve('package-lock.json');
const mocker = 'node_modules/@vitest/mocker';
const lock = { packages: { [mocker]: { version: '4.1.11', dev: true } } };
const advisory = { id: 'GHSA-qxg6-89mg-rqv8', database_specific: { severity: 'MODERATE' } };
const result = { results: [{ source: { path }, packages: [{
  package: { name: '@vitest/mocker', version: '4.1.11' }, vulnerabilities: [advisory],
}] }] };

test('moderate findings retain the existing threshold and production/dev boundary', () => {
  const locks = new Map([[path, lock]]);
  assert.equal(findingsFor(result, locks)[0].blocking, true);
  assert.equal(findingsFor(result, locks, { level: 'high' })[0].blocking, false);
  assert.deepEqual(findingsFor(result, locks, { omitDev: true }), []);
  const mixed = structuredClone(lock);
  mixed.packages[`node_modules/example/${mocker}`] = { version: '4.1.11' };
  const findings = findingsFor(result, new Map([[path, mixed]]), { omitDev: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].devOnly, false);
});

test('unknown severity and unexpected source fail closed', () => {
  const unknown = structuredClone(result);
  delete unknown.results[0].packages[0].vulnerabilities[0].database_specific;
  assert.equal(findingsFor(unknown, new Map([[path, lock]]), { level: 'critical' })[0].blocking, true);
  assert.throws(() => findingsFor(result, new Map()), /unexpected lockfile/);
  assert.throws(() => findingsFor(result, new Map([[path, lock]]), { level: 'off' }), /invalid audit level/);
});

test('unsupported options cannot activate an online mode', async () => {
  await assert.rejects(main(['--online']), /unsupported option/);
  await assert.rejects(main(['--download-offline-databases']), /unsupported option/);
});

test('empty or incomplete scanner output cannot pass a nonempty lockfile', () => {
  const locks = new Map([[path, lock]]);
  verifyInventory(result, locks);
  assert.throws(() => verifyInventory({ results: [] }, locks), /omitted lockfile packages/);
  const missing = structuredClone(lock);
  missing.packages['node_modules/other'] = { version: '1.0.0' };
  assert.throws(() => verifyInventory(result, new Map([[path, missing]])), /omitted lockfile packages/);
});
