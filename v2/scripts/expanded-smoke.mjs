// Owned fixture only: no real user projects, keys, providers or human approvals.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {parse,stringify} from 'yaml';
import {review} from '../src/review.mjs';
import {browser} from '../tests/helpers.mjs';
import {state,status} from '../src/core.mjs';
import {fileHash,json,treeHash,hash} from '../src/files.mjs';
import {command} from '../plugins/local/index.mjs';
const execute=promisify(execFile),base=fileURLToPath(new URL('../',import.meta.url)),cli=path.join(base,'bin/tsugite.mjs');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tsugite-v2-expanded-evidence-')),project=path.join(directory,'project'),steps=[];
process.env.TSUGITE_HOME=path.join(directory,'private-home');
async function run(args){const result=await execute(process.execPath,[cli,...args],{cwd:directory,env:{...process.env},timeout:120000,maxBuffer:2000000});const output=JSON.parse(result.stdout);if(!output.ok)throw new Error('CLI failed');steps.push({command:['tsugite',...args],ok:true});return output;}
let page;
try{
  await run(['init',project]);
  for(const id of ['pixverse','elevenlabs','whisper','fast-edit'])await run(['plugin','add',id,'--project',project]);
  await run(['plugin','knowledge','story','--project',project]);
  await run(['plugin','knowledge','h3-director','--project',project]);
  await run(['plugin','analyze','whisper','assets/intro.mp4','--mock','--output','assets/captions.srt','--project',project]);
  await command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','sine=frequency=220:sample_rate=48000','-t','2',path.join(project,'assets/music.wav')]);
  const config=parse(await fs.readFile(path.join(project,'tsugite.yaml'),'utf8'));Object.assign(config,{length:'8s',execution:'mock',make:[{id:'shot',with:'pixverse',seconds:5,prompt:'synthetic fixture'},{id:'voice',with:'elevenlabs',kind:'audio',seconds:3,prompt:'synthetic fixture',options:{voice_id:'mock-voice'}}],audio:[{path:'assets/music.wav',kind:'bgm',start:0.1,seconds:7.5,loop:true,volume:0.1}],captions:'assets/captions.srt'});await fs.writeFile(path.join(project,'tsugite.yaml'),stringify(config));
  await run(['check','--project',project]);await run(['plan','--no-review','--project',project]);
  page=await review(project);const ui=await browser(page.url);
  for(const stage of ['plan','clips','final']){
    await ui.refresh();const response=await ui.submit('approve',{stage});if(response.status!==303)throw new Error(await response.text());steps.push({action:'automated fixture confirmation form',stage,status:303});
    if(stage==='plan')await run(['make','--project',project]);if(stage==='clips')await run(['export','--project',project]);
  }
  await run(['init','--pack','template.json','--project',project]);await run(['init',path.join(directory,'template-copy'),'--template',path.join(project,'template.json')]);
  await run(['plugin','skill','--to',path.join(directory,'client-skills'),'--project',project]);
  await fs.writeFile(path.join(project,'assets/selections.json'),JSON.stringify({version:1,format:'9:16',segments:[{path:'assets/intro.mp4',start:0.5,end:1.5}]}));
  await run(['plugin','analyze','fast-edit','assets/selections.json','--project',project]);
  await fs.writeFile(path.join(project,'project.yaml'),'name: Fixture v1 final\nmanifest: unused.json\n');
  await run(['init',path.join(directory,'v1-final-copy'),'--from-v1',project,'--flatten','out/final.mp4']);
  const workflow=await status(project),ledger=(await state(project)).ledger;if(workflow.checks.final!=='approved'||ledger.entries.some(entry=>entry.actual!==0))throw new Error('Unexpected credit/check state');
  const evidence={ok:true,node:process.version,directory,project,approval:'Automated form submissions in a run-owned fixture; not human production approval',providers:'Synthetic mocks only; no live request or credential access',runtimeDigest:hash(json({src:await treeHash(path.join(base,'src')),plugins:await treeHash(path.join(base,'plugins')),bin:await treeHash(path.join(base,'bin'))})),output:path.join(project,'out/final.mp4'),sha256:await fileHash(project,'out/final.mp4'),metadata:workflow.output,ledger,steps};
  await fs.writeFile(path.join(directory,'evidence.json'),json(evidence));process.stdout.write(json({ok:true,directory,evidence:path.join(directory,'evidence.json'),output:evidence.output,metadata:evidence.metadata,ledgerEntries:ledger.entries.length,creditsSpent:0,steps:steps.length}));
}finally{if(page)await page.close();}
