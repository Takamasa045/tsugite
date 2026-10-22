import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedNodeVersion } from '../src/node-runtime.mjs';

test('accepts patched even release lines and rejects unreviewed majors/prereleases', () => {
  for (const version of ['22.23.4', 'v22.23.5', '22.24.0', '24.22.1', '24.23.0', 'v26.12.1', '26.13.0']) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
  for (const version of ['22.12.0', '22.23.3', '24.22.0', '26.12.0', '23.1.0', '25.0.0', '27.0.0', '28.0.0', '26.12', 'v26.12.1-rc.1', '26.12.1junk', '022.23.4', '']) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});
