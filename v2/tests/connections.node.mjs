import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,settings,page} from './helpers.mjs';
import {write,readJSON} from '../src/files.mjs';
import {addPlugin,bundledPlugin,newPlugin} from '../src/plugins.mjs';
import {plan,make,currentPlan,state} from '../src/core.mjs';
import {pluginSettings} from '../src/settings.mjs';
async function connection(home,update={},plugin='pixverse',defaults=plugin==='pixverse'?{quality:'540p'}:{}){await fs.mkdir(process.env.TSUGITE_HOME,{recursive:true});await write(process.env.TSUGITE_HOME,'config.json',{version:1,plugins:{[plugin]:{defaults,connection:{enabled:true,base_url:'https://api.fixture.test',credential_env:'TSUGITE_FIXTURE_KEY',download_origins:['https://media.fixture.test'],...update}}}});}
test('live configuration is plan-bound, credentials are lazy and page approval precedes HTTP',async t=>{
  const {root,home}=await fixture(t);await addPlugin(root,await bundledPlugin('pixverse'));await connection(home);
  await settings(root,{execution:'live',make:[{id:'shot',with:'pixverse',prompt:'fixture request',seconds:3}],budget:{pixverse:100}});
  const oldFetch=globalThis.fetch,oldKey=process.env.TSUGITE_FIXTURE_KEY;let calls=0;
  t.after(()=>{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.TSUGITE_FIXTURE_KEY;else process.env.TSUGITE_FIXTURE_KEY=oldKey;});delete process.env.TSUGITE_FIXTURE_KEY;
  const planned=await plan(root);assert.equal(planned.plan.tasks[0].options.quality,'540p');assert.equal(planned.plan.tasks[0].options.aspect,'9:16');assert.equal(planned.plan.tasks[0].quote.credits,21);
  await assert.rejects(make(root),/Waiting for plan/);const ui=await page(t,root);assert.match(ui.html,/LIVE: approved make/);assert.match(ui.html,/api.fixture.test/);await ui.submit('approve',{stage:'plan'});
  process.env.TSUGITE_FIXTURE_KEY='fixture-private-secret';const bytes=await fs.readFile(path.join(root,'assets/intro.mp4'));
  globalThis.fetch=async(url,o)=>{calls++;if(url.includes('text/generate'))return Response.json({ErrCode:0,Resp:{video_id:123,credits:21}});if(url.includes('result/'))return Response.json({ErrCode:0,Resp:{id:123,status:1,url:'https://media.fixture.test/a.mp4'}});assert.deepEqual(o.headers,{});return new Response(bytes);};
  await assert.rejects(make(root),/Credits must/);assert.equal(calls,3);const saved=await state(root);assert.equal(saved.jobs[planned.plan.tasks[0].key].providerJobId,'123');assert.equal(saved.ledger.entries[0].status,'uncertain');assert.ok(!JSON.stringify(saved).includes('fixture-private-secret'));assert.ok(!JSON.stringify(planned).includes('fixture-private-secret'));
  await assert.rejects(make(root),/Uncertain/);assert.equal(calls,3);await connection(home,{base_url:'https://changed.fixture.test'});await assert.rejects(currentPlan(root),/no longer matches/);
});
test('missing connection consent, raw secrets and nested defaults fail closed',async t=>{
  const {root,home}=await fixture(t);await addPlugin(root,await bundledPlugin('pixverse'));await settings(root,{execution:'live',make:[{id:'shot',with:'pixverse',prompt:'fixture',seconds:3}],budget:{pixverse:30}});await assert.rejects(plan(root),/Select and enable/);
  await connection(home,{enabled:false});await assert.rejects(plan(root),/Select and enable/);
  for(const defaults of [{api_key:'do-not-log'},{model:{secret:'do-not-log'}}]){await write(process.env.TSUGITE_HOME,'config.json',{version:1,plugins:{pixverse:{defaults}}});await assert.rejects(pluginSettings('pixverse'),e=>!e.message.includes('do-not-log'));}
  await fs.writeFile(path.join(process.env.TSUGITE_HOME,'config.json'),'do-not-log private malformed content');await assert.rejects(pluginSettings('pixverse'),e=>!e.message.includes('do-not-log'));
});
test('live quotes fail closed for missing maxima, low ceilings and missing budgets',async t=>{
  const {root,home}=await fixture(t);await addPlugin(root,await bundledPlugin('pixverse'));await addPlugin(root,await bundledPlugin('elevenlabs'));
  await connection(home);
  await settings(root,{execution:'live',make:[{id:'shot',with:'pixverse',prompt:'fixture request',seconds:3,options:{max_credits:10}}],budget:{pixverse:100}});
  await assert.rejects(plan(root),/below the documented estimate/);
  await settings(root,{make:[{id:'shot',with:'pixverse',prompt:'fixture request',seconds:3}],budget:{}});
  await assert.rejects(plan(root),/No budget for service pixverse/);
  await connection(home,{},'elevenlabs');
  await settings(root,{execution:'live',make:[{id:'voice',with:'elevenlabs',kind:'audio',prompt:'fixture voice',seconds:3,options:{voice_id:'fixture_voice'}}],budget:{elevenlabs:20}});
  await assert.rejects(plan(root),/explicit positive provider credit maximum/);
  await settings(root,{make:[{id:'voice',with:'elevenlabs',kind:'audio',prompt:'fixture voice',seconds:3,options:{voice_id:'fixture_voice',max_credits:4}}],budget:{elevenlabs:20}});
  const planned=await plan(root);assert.equal(planned.plan.tasks[0].quote.credits,4);assert.equal(planned.plan.tasks[0].quote.service,'elevenlabs');
});
test('a normalization hook cannot switch the provider or other source intent',async t=>{
  const {root,home}=await fixture(t),directory=path.join(home,'normalizer');await newPlugin(directory,'normalizer');
  await fs.writeFile(path.join(directory,'index.mjs'),"export default {quote:()=>({service:'local',credits:0}),make:async()=>{},normalize:t=>({...t,with:'local'})};");await addPlugin(root,directory);
  await settings(root,{make:[{id:'shot',with:'normalizer',prompt:'fixture',seconds:3}]});await assert.rejects(plan(root),/only fill source options/);assert.equal((await state(root)).ledger.entries.length,0);
});
