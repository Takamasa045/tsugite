import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture} from './helpers.mjs';
import {exportLabs} from '../scripts/export-labs.mjs';
import {addPlugin,plugin} from '../src/plugins.mjs';
test('labs compatibility sources export non-destructively with standalone zero-cost inspections',async t=>{
  const {root,home}=await fixture(t),destination=path.join(home,'labs'),result=await exportLabs(destination);assert.equal(result.packages.length,11);assert.ok(result.packages.every(p=>p.files>0));
  const selected=path.join(destination,'packages/tesseract');await promisify(execFile)(process.execPath,['--test','test.mjs'],{cwd:selected});await addPlugin(root,selected);const loaded=await plugin(root,'labs-tesseract',true);assert.deepEqual(loaded.manifest.capabilities,['analysis']);assert.equal((await loaded.implementation.analyze()).executionSupported,false);await assert.rejects(exportLabs(destination),/EEXIST/);
});
