// Packaging helper only. Each generated package contains its own complete
// offline contract, mock and fixtures; no import points outside the package.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const home=fileURLToPath(new URL('../plugins/',import.meta.url));
const definitions=[
  {id:'pixverse',kind:'video',durations:[3,5,10],reference:'https://platform.pixverse.ai/'},
  {id:'kling',kind:'video',durations:[5,10],reference:'https://app.klingai.com/global/dev/document-api'},
  {id:'elevenlabs',kind:'audio',durations:null,reference:'https://elevenlabs.io/docs/api-reference/text-to-speech/convert'}
];
for(const definition of definitions){
  const dir=path.join(home,definition.id);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'contract.json'),JSON.stringify({...definition,apiVersion:1,liveEnabled:false,creditPolicy:'explicit per-service maximum; no inferred exchange rates',verification:'offline contract and synthetic mock only'},null,2)+'\n');
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:`tsugite-plugin-${definition.id}`,version:'2.0.0-alpha.1',type:'module',license:'MIT',scripts:{test:'node --test test.mjs'},tsugite:{apiVersion:1,id:definition.id,capabilities:['source'],mediaKinds:[definition.kind],network:true,tier:'labs',entry:'index.mjs',mock:'mock.mjs',constraints:'constraints.md'}},null,2)+'\n');
  await fs.writeFile(path.join(dir,'index.mjs'),`import definition from './contract.json' with {type:'json'};
export function request(task) {
  if(typeof task.prompt!=='string'||!task.prompt.trim()||!Number.isFinite(task.seconds)||task.seconds<=0)throw new Error('Invalid source request');
  if((task.kind??'video')!==definition.kind)throw new Error('Unsupported media kind');
  if(definition.durations&&!definition.durations.includes(task.seconds))throw new Error('Unsupported duration');
  const options=task.options??{};
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['model','aspect','seed','voice_id','max_credits'].includes(k)))throw new Error('Unsupported source options (credentials never belong in a project)');
  for(const key of ['model','voice_id'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!options[key].trim()||options[key].length>128))throw new Error('Invalid model or voice identity');
  if(options.max_credits!==undefined&&(!Number.isFinite(options.max_credits)||options.max_credits<0))throw new Error('Invalid service credit maximum');
  if(options.aspect&&!['16:9','9:16'].includes(options.aspect))throw new Error('Unsupported aspect');
  if(options.seed!==undefined&&(!Number.isInteger(options.seed)||options.seed<0||options.seed>2147483647))throw new Error('Invalid seed');
  if(definition.kind==='audio'&&typeof options.voice_id!=='string')throw new Error('Choose a voice_id explicitly');
  return {service:definition.id,kind:definition.kind,prompt:task.prompt,seconds:task.seconds,options};
}
// This is the Tsugite receipt contract, not an undocumented upstream payload.
export function reconcile(receipt) {
  if(!receipt||typeof receipt.provider_job_id!=='string'||!['pending','completed','failed','unknown'].includes(receipt.status))throw new Error('Invalid provider receipt');
  const known=Number.isFinite(receipt.credits_charged)&&receipt.credits_charged>=0;
  return {providerJobId:receipt.provider_job_id,status:receipt.status,actualCredits:known?receipt.credits_charged:null,releaseReservation:receipt.status==='failed'&&known&&receipt.credits_charged===0};
}
export default {quote(task){request(task);const maximum=task.options?.max_credits;if(!Number.isFinite(maximum)||maximum<0)throw new Error('An explicit provider credit maximum is required');return {service:definition.id,credits:maximum};},async make(){throw new Error('Live execution is disabled; only execution: mock is implemented and verified');}};
`);
  await fs.writeFile(path.join(dir,'mock.mjs'),`import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {request} from './index.mjs';import definition from './contract.json' with {type:'json'};
export default {quote(task){request(task);return {service:definition.id,credits:0,mock:true};},async make({task,output}) {request(task);const input=definition.kind==='audio'?'sine=frequency=440:sample_rate=48000':'testsrc2=size=360x640:rate=24';const codec=definition.kind==='audio'?['-c:a','pcm_s16le']:['-c:v','libx264','-pix_fmt','yuv420p','-threads','2'];await promisify(execFile)('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i',input,'-t',String(task.seconds),...codec,output],{timeout:120000,windowsHide:true});return {credits:0,mock:true};}};
`);
  await fs.writeFile(path.join(dir,'test.mjs'),`import {test} from 'node:test';import assert from 'node:assert/strict';import mock from './mock.mjs';import live,{reconcile} from './index.mjs';
const task={prompt:'synthetic contract fixture',seconds:${definition.kind==='audio'?3:5},kind:'${definition.kind}',options:${definition.kind==='audio'?"{voice_id:'fixture-voice'}":"{}"}};
test('mock quote and fail-closed live entry',async()=>{assert.equal(mock.quote(task).credits,0);await assert.rejects(live.make(),/disabled/);});
test('unknown receipts never imply refunds',()=>{assert.equal(reconcile({provider_job_id:'fixture',status:'failed'}).releaseReservation,false);assert.equal(reconcile({provider_job_id:'fixture',status:'failed',credits_charged:0}).releaseReservation,true);});
`);
  await fs.writeFile(path.join(dir,'constraints.md'),`# ${definition.id} source contract\n\nLabs; live execution is deliberately disabled. Use explicit execution: mock for synthetic fixture media (not vendor output). No credentials, API calls, account selection or provider credit consumption occurs.\n\nMedia: ${definition.kind}. Duration contract: ${definition.durations?.join(', ')??'positive finite seconds'}. Provider model and voice selection must be explicit when needed; no billing account is inferred. The normalized receipt contract retains reservations on unknown outcomes; it is not an upstream API compatibility claim.\n\nReference: ${definition.reference}. Upstream request/response transport and live acceptance remain unverified.\n`);
}
