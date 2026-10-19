import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {init,plan,make,exportVideo,status,currentPlan,state,cleanPreview} from '../src/core.mjs';
import {hash,read,write,fileHash,inside,locked,readJSON} from '../src/files.mjs';
import {newPlugin,addPlugin,inspectPlugin} from '../src/plugins.mjs';
import {reserve,settle,budgetView} from '../src/budget.mjs';
import {callTool,workflowTools} from '../src/mcp.mjs';
import {addNote,taste,pack,importPack,candidates} from '../src/taste.mjs';
import {migrate} from '../src/migrate.mjs';
import {Client} from '@modelcontextprotocol/sdk/client';
import {parse} from 'yaml';
import {fixture,settings,page} from './helpers.mjs';
const exec=promisify(execFile);

test('real offline sample: page approvals, make, MP4 export, final, duplicate reuse',async t=>{
  const {root}=await fixture(t); await plan(root);
  await assert.rejects(make(root),/Waiting for plan/);
  const ui=await page(t,root);
  assert.match(ui.html,/0 provider credits/); assert.match(ui.html,/Plan & storyboard/);
  assert.equal((await ui.submit('approve',{stage:'plan'})).status,303);
  assert.equal((await make(root)).made,0);
  const output=await exportVideo(root);
  assert.ok(Math.abs(output.seconds-6)<0.05); assert.equal(output.width,360); assert.equal(output.height,640);
  await ui.refresh(); assert.equal((await ui.submit('approve',{stage:'final'})).status,303);
  assert.equal((await status(root)).checks.final,'approved');
  assert.deepEqual((await state(root)).ledger.entries,[]);
  const digest=await fileHash(root,'out/final.mp4');
  assert.equal((await exportVideo(root)).reused,true); assert.equal(await fileHash(root,'out/final.mp4'),digest);
  assert.deepEqual((await cleanPreview(root)).files,[]);
});
test('manual clips check cannot be skipped or approved before plan / missing output',async t=>{
  const {root}=await fixture(t);await settings(root,{checks:{auto_clips:false}});await plan(root);
  const ui=await page(t,root);
  assert.equal((await ui.submit('approve',{stage:'clips'})).status,409);
  await ui.submit('approve',{stage:'plan'});await make(root);
  await assert.rejects(exportVideo(root),/Waiting for clips/);
  await ui.refresh();assert.equal((await ui.submit('approve',{stage:'final'})).status,409);
  assert.equal((await ui.submit('approve',{stage:'clips'})).status,303);
  await exportVideo(root);assert.equal((await status(root)).checks.final,'waiting');
});
test('one changed byte of plan invalidates previous approvals; plan semantic forgery rejected',async t=>{
  const {root}=await fixture(t);await plan(root);const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});
  const raw=await read(root,'.tsugite/plan.json');await write(root,'.tsugite/plan.json',raw+' ');
  await assert.rejects(make(root),/Waiting for plan/);
  const p=JSON.parse(raw);p.tasks=[{id:'injected',quote:{credits:0}}];await write(root,'.tsugite/plan.json',p);
  await assert.rejects(make(root),/no longer matches/);
});
test('replanning archives approvals and reverting to an older plan does not revive them',async t=>{
  const {root}=await fixture(t);await plan(root);const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});
  await settings(root,{name:'Revised'});await plan(root);await settings(root,{name:'My first 継手'});await plan(root);
  await assert.rejects(make(root),/Waiting for plan/);assert.equal((await fs.readdir(path.join(root,'.tsugite/approvals/history'))).length,1);
});
test('config, asset, taste and knowledge changes invalidate the plan',async t=>{
  const {root}=await fixture(t);await write(root,'knowledge.md','Keep it short');await settings(root,{knowledge:['knowledge.md']});
  for(const [file,append] of [['tsugite.yaml','\n'],['assets/intro.mp4',' '],['taste/rules.md','- early BGM\n'],['knowledge.md','\n']]){
    await plan(root);const original=await fs.readFile(await inside(root,file));
    await fs.appendFile(await inside(root,file),append);
    await assert.rejects(currentPlan(root),/no longer matches|Command failed/);
    await fs.writeFile(await inside(root,file),original);
  }
});
test('CSRF, Origin, cookie, host, cross-site and stale scope checks',async t=>{
  const {root}=await fixture(t);await plan(root);const ui=await page(t,root);
  for(const change of [{csrf:'wrong'},{digest:'0'},{scope:'0'}]) assert.notEqual((await ui.submit('approve',{stage:'plan',...change})).status,303);
  for(const headers of [{Origin:'https://evil.example'},{Cookie:''},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'application/json'}]) assert.equal((await ui.submit('approve',{stage:'plan'},{headers})).status,403,JSON.stringify(headers));
  const badHost=await new Promise((resolve,reject)=>{ const request=http.request(ui.url,{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end(); });
  assert.equal(badHost,403);
  assert.equal((await fetch(ui.url+'../tsugite.yaml')).status,404);
  assert.equal((await fetch(ui.url+'media/0')).status,403);
  const response=await fetch(ui.url);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await status(root)).checks.plan,'waiting');
});
test('XSS is escaped in name, prompts and notes',async t=>{
  const {root}=await fixture(t);await settings(root,{name:'<script>alert(1)</script>'});await addNote(root,'<img src=x onerror=alert(1)>');await plan(root);
  const ui=await page(t,root);assert.ok(!ui.html.includes('<script>alert'));assert.ok(!ui.html.includes('<img src=x'));assert.match(ui.html,/&lt;script&gt;/);
});
test('CLI and MCP have no approval operation or coercible approval flag',async t=>{
  const {root}=await fixture(t);await plan(root);
  assert.ok(!workflowTools.some(x=>/approve|gate/.test(x)));
  await assert.rejects(callTool(root,'approve',{}),/Unknown tool/);
  await assert.rejects(callTool(root,'make',{approve:true}),/Unexpected/);
  await assert.rejects(callTool(root,'make',{}),/Waiting for plan/);
  const cli=path.resolve('bin/tsugite.mjs');
  for(const args of [['approve'],['make','--approve'],['make','--actor','coordinator'],['clean','--apply']]) await assert.rejects(exec(process.execPath,[cli,...args,'--project',root]));
});
test('project path traversal, absolute input, symlink parent and plugin id rejected',async t=>{
  const {root,home}=await fixture(t);
  for(const relative of ['../secret','assets/../../secret','/tmp/secret','assets\\secret','assets/./intro.mp4','C:relative','assets/a:stream','assets/CON.txt','assets/COM¹','assets/CONIN$','assets/trailing.','assets/trailing ','assets/control\x01']) await assert.rejects(inside(root,relative));
  await fs.symlink(home,path.join(root,'assets','link'),process.platform==='win32'?'junction':'dir');await assert.rejects(inside(root,'assets/link/private'),/Symlinks/);
  await settings(root,{use:['../secret']});await assert.rejects(plan(root),/Inputs must/);
  await assert.rejects(newPlugin(path.join(home,'bad'),'../bad'),/Invalid plugin/);
});
test('parallel make uses exclusive lock and does not double-execute / reserve',async t=>{
  const {root}=await fixture(t);await settings(root,{make:[{id:'generated',with:'local',prompt:'synthetic',seconds:3}]});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});
  const result=await Promise.allSettled([make(root),make(root)]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.match(result.find(x=>x.status==='rejected').reason.message,/busy/);
  await make(root);const s=await state(root);assert.equal(s.ledger.entries.length,1);assert.equal(s.events.filter(x=>x.action==='make-start').length,1);
  assert.equal((await status(root)).checks.clips,'waiting');
});
test('service budgets fixed-point reservations are atomic and never combined',()=>{
  const ledger={entries:[]};
  assert.equal(reserve(ledger,[{id:'zero',service:'constructor',credits:0}],{}).entries.length,1);
  assert.throws(()=>reserve(ledger,[{id:'a',service:'one',credits:4},{id:'b',service:'one',credits:4}],{one:7}),/Budget exceeded/);assert.equal(ledger.entries.length,0);
  let l=reserve(ledger,[{id:'a',service:'one',credits:3.1},{id:'b',service:'two',credits:70}],{one:4,two:70});
  assert.deepEqual(budgetView(l),{one:{spent:0,reserved:3.1},two:{spent:0,reserved:70}});
  l.entries[0].status='started';settle(l,'a',2);assert.equal(budgetView(l).one.spent,2);
  assert.throws(()=>reserve(l,[{id:'c',service:'one',credits:3}],{one:4,two:70}));
  assert.throws(()=>reserve(l,[{id:'d',service:'three',credits:1}],{one:4,two:70}),/No budget/);
  for(const credits of [-1,NaN,Infinity,0.0000001])assert.throws(()=>reserve(ledger,[{id:'bad',service:'one',credits}],{one:10}));
});
async function sourcePlugin(root,home,{id='mock-source',fail=false,credits=2,actual=credits,network=false}={}){
  const directory=path.join(home,id);await newPlugin(directory,id);
  const pkg=await readJSON(directory,'package.json');pkg.tsugite.network=network;await write(directory,'package.json',pkg);
  await write(directory,'index.mjs',`import {copyFile} from 'node:fs/promises';export default {quote:()=>({service:'mock-credit',credits:${credits}}),make:async({output,sample})=>{${fail?'throw new Error("simulated interrupted result")':`await copyFile(sample,output);return {credits:${actual}}`}}};`);
  await addPlugin(root,directory);return directory;
}
test('failed plugin retains full reservation and refuses duplicate execution after failure',async t=>{
  const {root,home}=await fixture(t);await sourcePlugin(root,home,{fail:true});await settings(root,{make:[{id:'x',with:'mock-source',prompt:'test',seconds:3}],budget:{'mock-credit':3}});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await assert.rejects(make(root),/simulated/);
  const s=await state(root);assert.equal(s.ledger.entries[0].status,'uncertain');assert.deepEqual(budgetView(s.ledger),{'mock-credit':{spent:0,reserved:2}});
  await assert.rejects(make(root),/Uncertain/);assert.equal((await state(root)).events.filter(x=>x.action==='make-start').length,1);
});
test('over-reported actual credits are uncertain rather than refunded or overspent',async t=>{
  const {root,home}=await fixture(t);await sourcePlugin(root,home,{actual:3});await settings(root,{make:[{id:'x',with:'mock-source',prompt:'test',seconds:3}],budget:{'mock-credit':2}});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await assert.rejects(make(root),/exceeded reservation/);
  assert.equal((await state(root)).ledger.entries[0].status,'uncertain');
});
test('plugin network and contract checks, scaffold mock test, tamper invalidation',async t=>{
  const {root,home}=await fixture(t);const directory=await sourcePlugin(root,home);
  await exec(process.execPath,['--test','test.mjs'],{cwd:directory});
  await settings(root,{make:[{id:'x',with:'mock-source',prompt:'test',seconds:3}],budget:{'mock-credit':2}});await plan(root);
  await fs.appendFile(path.join(root,'.tsugite/plugins/mock-source/index.mjs'),'\n');await assert.rejects(currentPlan(root),/Plugin changed/);
  await fs.unlink(path.join(directory,'mock.mjs'));await assert.rejects(inspectPlugin(directory),/ENOENT/);
  await sourcePlugin(root,home,{id:'network-source',network:true});await settings(root,{make:[{id:'x',with:'network-source',prompt:'test',seconds:3}]});await assert.rejects(plan(root),/Network plugins are disabled/);
});
test('a newly scaffolded mock produces usable media through the reviewed workflow',async t=>{
  const {root,home}=await fixture(t),directory=path.join(home,'copy-source');
  await newPlugin(directory,'copy-source');await addPlugin(root,directory);
  await settings(root,{execution:'mock',make:[{id:'copied',with:'copy-source',prompt:'fixture copy',seconds:3}],length:'6s'});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);await ui.refresh();await ui.submit('approve',{stage:'clips'});await exportVideo(root);
  assert.equal((await state(root)).ledger.entries[0].actual,0);assert.equal((await status(root)).output.width,360);
});
test('single clip retry requires new page plan approval and preserves other clip',async t=>{
  const {root}=await fixture(t);await settings(root,{make:[{id:'one',with:'local',prompt:'first',seconds:2},{id:'two',with:'local',prompt:'second',seconds:2}]});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);const before=await currentPlan(root);await ui.refresh();
  assert.equal((await ui.submit('retry',{id:'one'})).status,303);await assert.rejects(make(root),/Waiting for plan/);
  const after=await currentPlan(root);assert.notEqual(before.plan.tasks[0].key,after.plan.tasks[0].key);assert.equal(before.plan.tasks[1].key,after.plan.tasks[1].key);
  await ui.refresh();await ui.submit('approve',{stage:'plan'});await make(root);assert.equal((await state(root)).ledger.entries.length,3);
});
test('notes feed the next plan, three observations create one page promotion after final',async t=>{
  const {root}=await fixture(t);
  await addNote(root,'Short opening');await addNote(root,'short opening!');await addNote(root,'Keep intro short','short opening');
  assert.equal((await candidates(root)).length,1);await plan(root);assert.equal((await currentPlan(root)).plan.taste.notes.length,3);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);await exportVideo(root);await ui.refresh();
  const key=(await candidates(root))[0].key;assert.equal((await ui.submit('rule',{key,accept:'yes'})).status,409);
  await ui.submit('approve',{stage:'final'});await ui.refresh();assert.match(ui.html,/Make this habit a rule/);
  assert.equal((await ui.submit('rule',{key,accept:'yes'})).status,303);assert.match((await taste(root)).rules,/Short opening/);assert.equal((await candidates(root)).length,0);
  const exported=await pack(root);assert.equal(exported.kind,'taste');await assert.rejects(importPack(root,{kind:'bad'}));
});
test('copy-only v1 migration never imports approvals or changes original media',async t=>{
  const {root,home}=await fixture(t),source=path.join(home,'v1');await fs.mkdir(source);await fs.mkdir(path.join(source,'media'));
  await fs.copyFile(path.join(root,'assets/intro.mp4'),path.join(source,'media','intro.mp4'));
  await write(source,'project.yaml','name: Legacy\nmanifest: manifest.json\n');await write(source,'manifest.json',{meta:{aspect:'9:16'},clips:[{id:'one',src:'media/intro.mp4',duration:3,audio:false}]});
  const before=await fileHash(source,'media/intro.mp4');const destination=path.join(home,'migrated');const result=await migrate(source,destination);
  assert.equal(result.approvalsImported,false);assert.equal(await fileHash(source,'media/intro.mp4'),before);await plan(destination);await assert.rejects(make(destination),/Waiting for plan/);
  const manifest=JSON.parse(await read(source,'manifest.json'));manifest.clips[0].in=1;await write(source,'manifest.json',manifest);await assert.rejects(migrate(source,path.join(home,'bad-migrate')),/trim exceeds/);
});
test('v1 Remotion backend and generation settings are not imported as plugins',async t=>{
  const {root,home}=await fixture(t),source=path.join(home,'v1-remotion');await fs.mkdir(source);await fs.mkdir(path.join(source,'media'));
  await fs.copyFile(path.join(root,'assets/intro.mp4'),path.join(source,'media','intro.mp4'));
  await write(source,'project.yaml','name: Legacy Remotion\nmanifest: manifest.json\nedit:\n  backend: remotion\ngeneration:\n  adapter: pixverse\n  connection: pixverse\naudio:\n  adapter: elevenlabs\n  connection: elevenlabs\n');
  await write(source,'manifest.json',{meta:{aspect:'9:16'},clips:[{id:'one',src:'media/intro.mp4',duration:3,audio:false}]});
  const destination=path.join(home,'copied');await migrate(source,destination);
  const project=parse(await read(destination,'tsugite.yaml'));assert.equal(project.export,'local');assert.deepEqual(project.budget,{});assert.equal(project.make,undefined);
  const record=await readJSON(destination,'.tsugite/migration.json');assert.match(record.warnings.join('\n'),/edit.backend is not imported/);assert.match(record.warnings.join('\n'),/generation adapters/);
  await assert.rejects(fs.access(path.join(destination,'.tsugite/plugins/remotion')),{code:'ENOENT'});
});
test('final preview and final approval reject modified delivery MP4',async t=>{
  const {root}=await fixture(t);await plan(root);const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);await exportVideo(root);await ui.refresh();await ui.submit('approve',{stage:'final'});
  await fs.appendFile(await inside(root,'out/final.mp4'),'tamper');assert.equal((await status(root)).checks.final,'waiting');await assert.rejects(cleanPreview(root),/changed/);
});
test('real MCP stdio handshake exposes no approval tool and uses current CLI project',async t=>{
  const {root}=await fixture(t);
  const {StdioClientTransport}=await import(new URL('./stdio.js',import.meta.resolve('@modelcontextprotocol/sdk/client')));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('bin/tsugite.mjs'),'mcp','--project',root],stderr:'pipe'});
  const client=new Client({name:'tsugite-test',version:'1.0.0'});t.after(()=>client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().version,JSON.parse(await fs.readFile('package.json','utf8')).version);
  const tools=(await client.listTools()).tools.map(x=>x.name);assert.deepEqual(tools,workflowTools);
  assert.equal((await client.callTool({name:'plan',arguments:{}})).isError,undefined);
  assert.equal((await client.callTool({name:'make',arguments:{}})).isError,true);
  assert.equal((await client.callTool({name:'approve',arguments:{}})).isError,true);
});
test('distinct parallel credit reservations cannot exceed the service limit',async t=>{
  const {root}=await fixture(t);
  const reserveOne=id=>locked(root,async()=>{
    const s=await state(root);s.ledger=reserve(s.ledger,[{id,service:'mock-credit',credits:4}],{'mock-credit':7});
    await new Promise(resolve=>setTimeout(resolve,30));await write(root,'.tsugite/state.json',s);
  });
  const results=await Promise.allSettled([reserveOne('a'),reserveOne('b')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(reserveOne('c'),/Budget exceeded/);assert.equal(budgetView((await state(root)).ledger)['mock-credit'].reserved,4);
});
test('clean page rechecks preview and moves only older recorded generated media',async t=>{
  const {root}=await fixture(t);await settings(root,{make:[{id:'one',with:'local',prompt:'synthetic',seconds:2}]});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);const old=(await currentPlan(root)).plan.tasks[0].key;await ui.refresh();
  await ui.submit('retry',{id:'one'});await ui.refresh();await ui.submit('approve',{stage:'plan'});await make(root);await ui.refresh();await ui.submit('approve',{stage:'clips'});await exportVideo(root);await ui.refresh();await ui.submit('approve',{stage:'final'});await ui.refresh();
  const preview=await cleanPreview(root);assert.equal(preview.files.length,1);assert.match(preview.files[0].path,new RegExp(old));
  assert.equal((await ui.submit('clean',{preview:'stale'})).status,409);
  assert.equal((await ui.submit('clean',{preview:preview.previewDigest})).status,303);
  assert.equal((await cleanPreview(root)).files.length,0);assert.ok(await fileHash(root,'assets/intro.mp4'));assert.ok(await fileHash(root,'out/final.mp4'));
  assert.equal((await fs.readdir(path.join(root,'.tsugite/trash'))).length,1);
});
test('global habits promote after final and twice-missed rules retire through page only',async t=>{
  const {root,home}=await fixture(t),previousHome=process.env.TSUGITE_HOME,globalHome=path.join(home,'global');
  await fs.mkdir(globalHome);process.env.TSUGITE_HOME=globalHome;
  t.after(()=>{if(previousHome===undefined)delete process.env.TSUGITE_HOME;else process.env.TSUGITE_HOME=previousHome;});
  for(let i=0;i<3;i++)await addNote(globalHome,'Short opening');
  await plan(root);assert.equal((await currentPlan(root)).plan.taste.globalNotes.length,3);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);await exportVideo(root);await ui.refresh();await ui.submit('approve',{stage:'final'});await ui.refresh();
  const candidate=(await candidates(root)).find(x=>x.tasteScope==='global');
  assert.equal((await ui.submit('rule',{key:candidate.key,accept:'yes',tasteScope:'global'})).status,303);
  assert.match((await taste(root)).globalRules,/Short opening/);
  // New preference content requires a fresh approved plan and final output.
  await ui.refresh();await ui.submit('approve',{stage:'plan'});await make(root);await exportVideo(root);await ui.refresh();await ui.submit('approve',{stage:'final'});await ui.refresh();
  assert.equal((await ui.submit('retire',{key:candidate.key,tasteScope:'global'})).status,409);
  for(let i=0;i<2;i++)assert.equal((await ui.submit('result',{key:candidate.key,effective:'no',tasteScope:'global'})).status,303);
  assert.equal((await readJSON(globalHome,'taste/stats.json'))[candidate.key].missed,1,'double-click is one outcome');
  await settings(root,{name:'Second rule evaluation'});await plan(root);await ui.refresh();await ui.submit('approve',{stage:'plan'});await make(root);await exportVideo(root);await ui.refresh();await ui.submit('approve',{stage:'final'});await ui.refresh();
  assert.equal((await ui.submit('result',{key:candidate.key,effective:'no',tasteScope:'global'})).status,303);
  await ui.refresh();assert.match(ui.html,/Retire this rule/);
  assert.equal((await ui.submit('retire',{key:candidate.key,tasteScope:'global'})).status,303);
  assert.ok(!(await taste(root)).globalRules.includes('Short opening'));assert.equal((await readJSON(globalHome,'taste/stats.json'))[candidate.key].missed,2);
});
test('optional preference conditions inspect final media and are recorded in final review',async t=>{
  const {root}=await fixture(t);await write(root,'taste/checks.json',[{kind:'max_duration',value:5},{kind:'min_width',value:360}]);await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);await exportVideo(root);await ui.refresh();
  assert.match(ui.html,/Automatic preference checks/);assert.match(ui.html,/&quot;passed&quot;: false/);
  assert.equal((await ui.submit('approve',{stage:'final'})).status,303);
  const record=await readJSON(root,'.tsugite/approvals/final.json');assert.deepEqual(record.preferenceChecks.map(x=>x.passed),[false,true]);
  await write(root,'taste/checks.json',[{kind:'arbitrary-code',value:1}]);await assert.rejects(plan(root),/Invalid machine/);
});
