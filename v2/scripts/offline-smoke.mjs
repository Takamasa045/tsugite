// Test-only harness: drives the real CLI and confirmation-page HTTP forms in a
// new run-owned fixture. It never approves a user's production project.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {review} from '../src/review.mjs';
import {browser} from '../tests/helpers.mjs';
import {state,status} from '../src/core.mjs';
import {fileHash,json,hash,treeHash} from '../src/files.mjs';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/tsugite.mjs',import.meta.url));
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tsugite-v2-evidence-'));
const project=path.join(directory,'my-video'), steps=[],started=Date.now();
process.env.TSUGITE_HOME=path.join(directory,'home');
const run=async args=>{const result=await exec(process.execPath,[cli,...args],{cwd:directory,env:{...process.env,TSUGITE_HOME:path.join(directory,'home')},timeout:120000});const output=JSON.parse(result.stdout);steps.push({command:['tsugite',...args],output});return output;};
let page;
try {
  await run(['init','my-video','--json']);
  await run(['check','--project',project,'--json']);
  await run(['plan','--project',project,'--no-review','--json']);
  page=await review(project);const ui=await browser(page.url);
  const approved=await ui.submit('approve',{stage:'plan'});if(approved.status!==303)throw new Error(await approved.text());
  steps.push({action:'test harness submitted plan confirmation-page form',status:approved.status});
  await run(['make','--project',project,'--json']);
  await run(['export','--project',project,'--json']);
  await ui.refresh();const final=await ui.submit('approve',{stage:'final'});if(final.status!==303)throw new Error(await final.text());
  const workflow=await status(project),ledger=(await state(project)).ledger;
  if(workflow.checks.final!=='approved'||ledger.entries.length)throw new Error('Unexpected workflow or credit state');
  steps.push({action:'test harness submitted final confirmation-page form',status:final.status});
  await run(['note','Opening could be shorter','--project',project,'--json']);
  const packageRoot=fileURLToPath(new URL('../',import.meta.url));
  const runtimeDigest=hash(json({src:await treeHash(path.join(packageRoot,'src')),bin:await treeHash(path.join(packageRoot,'bin')),plugins:await treeHash(path.join(packageRoot,'plugins')),package:await fileHash(packageRoot,'package.json'),lock:await fileHash(packageRoot,'package-lock.json')}));
  const evidence={ok:true,fixture:project,runtimeDigest,node:process.version,elapsedSeconds:(Date.now()-started)/1000,network:'No provider calls; HTTP traffic only to loopback review page',approval:'Automated test-fixture form submissions, not a human production approval',output:path.join(project,'out/final.mp4'),sha256:await fileHash(project,'out/final.mp4'),metadata:workflow.output,ledger,steps};
  await fs.writeFile(path.join(directory,'evidence.json'),json(evidence));
  process.stdout.write(json({ok:true,directory,evidence:path.join(directory,'evidence.json'),output:evidence.output,elapsedSeconds:evidence.elapsedSeconds,metadata:evidence.metadata,ledger}));
} finally {if(page)await page.close();}
