import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers.mjs';
import {plan,currentPlan,make} from '../src/core.mjs';
import {template,initTemplate,installSkill,addKnowledge} from '../src/packs.mjs';
import {addPlugin} from '../src/plugins.mjs';
import {analyze} from '../src/analysis.mjs';
import {write,fileHash} from '../src/files.mjs';
import {page,settings} from './helpers.mjs';
import {newPlugin} from '../src/plugins.mjs';
import {state} from '../src/core.mjs';
import {exportVideo} from '../src/core.mjs';
import {budgetView} from '../src/budget.mjs';
import {addNote,candidates} from '../src/taste.mjs';
import {migrate} from '../src/migrate.mjs';
test('timing template is portable, drops executable/provider fields and imports without approvals',async t=>{
  const {root,home}=await fixture(t);await plan(root);const pack=await template(root);pack.slots[0].path='../../private';pack.make=[{with:'paid',prompt:'ignored'}];
  const dest=path.join(home,'from-template');await initTemplate(dest,pack);await plan(dest);const p=(await currentPlan(dest)).plan;assert.equal(p.tasks.length,0);assert.equal(p.timeline.clips[0].path,'assets/intro.mp4');await assert.rejects(make(dest),/Waiting for plan/);
  await assert.rejects(initTemplate(path.join(home,'bad'),{...pack,slots:[{seconds:100}]}),/timing/);
});
test('one-command Skill installer is client-neutral and never overwrites an existing Skill',async t=>{
  const {home}=await fixture(t);const client=path.join(home,'client-skills');const result=await installSkill(client);assert.match(await fs.readFile(result.installed,'utf8'),/name: tsugite/);await assert.rejects(installSkill(client),/EEXIST/);
});
test('local Whisper mock produces importable SRT and never overwrites user files',async t=>{
  const {root}=await fixture(t);await addPlugin(root,fileURLToPath(new URL('../plugins/whisper/',import.meta.url)));
  const result=await analyze(root,'whisper','assets/intro.mp4',{mock:true,output:'assets/transcript.srt'});assert.equal(result.mock,true);assert.match(result.text,/MOCK TRANSCRIPT/);await assert.rejects(analyze(root,'whisper','assets/intro.mp4',{mock:true,output:'assets/transcript.srt'}),/already exists/);
  await assert.rejects(analyze(root,'whisper','../private',{mock:true}),/assets/);
});
test('Fast Edit returns explicit selected trim proposal and leaves current project untouched',async t=>{
  const {root}=await fixture(t);await addPlugin(root,fileURLToPath(new URL('../plugins/fast-edit/',import.meta.url)));await write(root,'assets/selection.json',{version:1,segments:[{path:'assets/intro.mp4',start:0.5,end:1.5}],format:'9:16'});
  const before=await fileHash(root,'tsugite.yaml');const result=await analyze(root,'fast-edit','assets/selection.json');assert.equal(result.project.length,1);assert.equal(result.project.use[0].start,0.5);assert.equal(result.applied,false);assert.equal(await fileHash(root,'tsugite.yaml'),before);
  await write(root,'assets/selection.json',{version:1,segments:[{path:'assets/../private',start:0,end:1}]});await assert.rejects(analyze(root,'fast-edit','assets/selection.json'),/Invalid selected/);
});
test('manual receipt reconciliation retains reservations until the page checks exact identity',async t=>{
  const {root,home}=await fixture(t),directory=path.join(home,'uncertain-source');await newPlugin(directory,'uncertain-source');
  await write(directory,'index.mjs',`export default {quote:()=>({service:'mock-credit',credits:2}),make:async({onSubmitted})=>{await onSubmitted({providerJobId:'fixture-remote-job'});throw new Error('simulated unknown outcome')}};`);await addPlugin(root,directory);
  await settings(root,{make:[{id:'shot',with:'uncertain-source',prompt:'fixture',seconds:3}],budget:{'mock-credit':3}});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await assert.rejects(make(root),/simulated/);await ui.refresh();const key=(await currentPlan(root)).plan.tasks[0].key;
  assert.equal((await state(root)).jobs[key].providerJobId,'fixture-remote-job');
  await write(root,'assets/receipt.json',{version:1,task_key:'wrong',service:'mock-credit',outcome:'failed',credits:0});assert.equal((await ui.submit('reconcile',{key,receipt:'assets/receipt.json'})).status,409);assert.equal(budgetView((await state(root)).ledger)['mock-credit'].reserved,2);
  await write(root,'assets/receipt.json',{version:1,task_key:key,provider_job_id:'fixture-remote-job',service:'mock-credit',outcome:'failed',credits:1});assert.equal((await ui.submit('reconcile',{key,receipt:'assets/receipt.json'})).status,303);assert.deepEqual(budgetView((await state(root)).ledger)['mock-credit'],{spent:1,reserved:0});
  assert.equal((await ui.submit('reconcile',{key,receipt:'assets/receipt.json'})).status,409);
  await ui.refresh();assert.equal((await ui.submit('retry-failed',{key})).status,303);await assert.rejects(make(root),/Waiting for plan/);assert.notEqual((await currentPlan(root)).plan.tasks[0].key,key);
});
test('knowledge packs snapshot advice locally and invalidate a previous plan without granting execution',async t=>{
  const {root}=await fixture(t);await plan(root);await addKnowledge(root,'story');await assert.rejects(currentPlan(root),/no longer matches/);await plan(root);assert.equal((await currentPlan(root)).plan.knowledge.length,1);await assert.rejects(make(root),/Waiting for plan/);await assert.rejects(addKnowledge(root,'story'),/already exists/);
});
test('similar local wording groups without uploading preferences and preserves negation/numbers',async t=>{
  const {root}=await fixture(t);await addNote(root,'Please keep the opening short');await addNote(root,'Keep opening short');await addNote(root,'The opening should be shorter');assert.equal((await candidates(root)).length,1);
  const positive=await addNote(root,'Keep BGM under 0.5 seconds'),negative=await addNote(root,'Do not keep BGM under 0.5 seconds'),other=await addNote(root,'Keep BGM under 0.6 seconds');assert.notEqual(positive.key,negative.key);assert.notEqual(positive.key,other.key);
});
test('export never overwrites an untracked user delivery file',async t=>{
  const {root}=await fixture(t);await write(root,'out/final.mp4','user-owned data');await plan(root);const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);
  const before=await fileHash(root,'out/final.mp4');await assert.rejects(exportVideo(root),/untracked or modified/);assert.equal(await fileHash(root,'out/final.mp4'),before);assert.equal(Object.keys((await state(root)).renders).length,0);
});
test('explicit final snapshot migrates a complex v1 project without executing or importing its graph',async t=>{
  const {root,home}=await fixture(t);await write(root,'project.yaml','name: Complex v1\nmanifest: manifest.json\n');await write(root,'manifest.json',{native_edit:{mode:'replace',payload:{unsupported:'retained only at original source'}}});
  const before=await fileHash(root,'assets/intro.mp4'),destination=path.join(home,'snapshot');await migrate(root,destination,{flatten:'assets/intro.mp4'});assert.equal(await fileHash(destination,'assets/original-final.mp4'),before);assert.equal(await fileHash(root,'assets/intro.mp4'),before);await plan(destination);await assert.rejects(make(destination),/Waiting for plan/);
  await assert.rejects(migrate(root,path.join(home,'escape'),{flatten:'../private.mp4'}),/Unsafe/);
});
test('the core does not contain provider or renderer-specific implementations',async()=>{
  const directory=fileURLToPath(new URL('../src/',import.meta.url));
  for(const filename of await fs.readdir(directory)){if(!filename.endsWith('.mjs'))continue;const source=await fs.readFile(path.join(directory,filename),'utf8');assert.doesNotMatch(source,/pixverse|elevenlabs|remotion|hyperframes|\bkling\b/i,filename);}
});
