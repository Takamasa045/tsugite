import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { NODE_RUNTIME_RANGE, DEFAULT_NODE_VERSION, isSupportedNodeVersion } from '../v2/src/node-runtime.mjs';

describe('runtime migration contract', () => {
  it('keeps install metadata and default pin aligned with the CLI policy', async () => {
    for (const prefix of ['', 'v2/', 'apps/workflow-viewer/']) {
      const manifest = JSON.parse(await readFile(`${prefix}package.json`, 'utf8'));
      const lock = JSON.parse(await readFile(`${prefix}package-lock.json`, 'utf8'));
      expect(manifest.engines.node).toBe(NODE_RUNTIME_RANGE);
      expect(lock.packages[''].engines.node).toBe(NODE_RUNTIME_RANGE);
    }
    expect((await readFile('.nvmrc', 'utf8')).trim()).toBe(DEFAULT_NODE_VERSION);
    expect(isSupportedNodeVersion(DEFAULT_NODE_VERSION)).toBe(true);
  });

  it('tests every admitted release line with the same npm and retains all native OS lanes', async () => {
    const ci = YAML.parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const v2 = YAML.parse(await readFile('.github/workflows/v2.yml', 'utf8'));
    for (const job of [ci.jobs.check, ci.jobs['windows-smoke'], ci.jobs['macos-smoke'], v2.jobs.offline, v2.jobs['remotion-smoke']]) {
      expect(job.strategy.matrix.node).toEqual(['22.23.4', '24.22.1', '26.12.1']);
      expect(job.steps).toContainEqual({ run: 'npm install --global npm@10.9.8 --no-audit --no-fund' });
    }
    expect(v2.jobs.offline.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
  });
});
