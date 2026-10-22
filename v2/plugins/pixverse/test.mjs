import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import mock from './mock.mjs';import live,{request,normalize,normalizeCli,reconcile} from './index.mjs';
import {buildPixverseCliArgs,createCli} from './cli.mjs';
import {runCommand} from './cli-run.mjs';
const task={prompt:'synthetic contract fixture',seconds:5,kind:'video',options:{}};
test('mock quote and fail-closed live entry',async()=>{assert.equal(mock.quote(task).credits,0);assert.equal(mock.quote(task).mock,true);await assert.rejects(live.make(),/disabled/);});
test('unknown receipts never imply refunds',()=>{assert.equal(reconcile({provider_job_id:'fixture',status:'failed'}).releaseReservation,false);assert.equal(reconcile({provider_job_id:'fixture',status:'failed',credits_charged:0}).releaseReservation,true);});
test('request, payload and quote reject invalid estimates without a provider call',()=>{
  assert.equal(typeof mock.normalize,'function');
  assert.equal(mock.normalize(task,{format:'9:16',defaults:{quality:'540p'}}).options.quality,'540p');
  assert.equal(normalize(task).options.model,'v6');
  assert.equal(live.quote({...task,options:{quality:'360p'}}).credits,25);
  assert.equal(live.quote({...task,options:{quality:'360p'}}).estimate,25);
  assert.equal(live.quote({...task,options:{quality:'720p'}}).credits,45);
  assert.equal(live.quote({...task,options:{quality:'720p',audio:true}}).credits,60);
  assert.equal(live.quote({...task,options:{quality:'720p',audio:true}}).estimate,60);
  assert.throws(()=>request({...task,seconds:16}),/Unsupported duration/);
  assert.throws(()=>normalize({...task,options:{quality:'99p'}}),/Unsupported PixVerse/);
  assert.throws(()=>live.quote({...task,options:{quality:'360p',max_credits:24}}),/below the documented estimate/);
  assert.throws(()=>live.quote({...task,options:{quality:'720p',audio:true,max_credits:45}}),/below the documented estimate/);
  assert.throws(()=>request({...task,options:{mode:'image'},inputs:[{path:'assets/first.png',bytes:20*1024*1024+1}]}),/20 MB/);
  assert.throws(()=>request({...task,options:{api_key:'do-not-store'}}),/credentials never belong/);
  assert.throws(()=>mock.quote({...task,options:{quality:'99p'}}),/Unsupported PixVerse/);
  assert.throws(()=>request({...task,options:{mode:'image'}}),/exactly one local image/);
  assert.throws(()=>request({...task,options:{mode:'transition'},inputs:['assets/a.png']}),/first and last/);
  assert.throws(()=>request({...task,options:{mode:'image'},inputs:['assets/clip.mp4']}),/PNG, JPEG or WebP/);
  assert.throws(()=>request({...task,inputs:['assets/a.png']}),/does not take local media/);
  assert.equal(normalize({...task,options:{mode:'image'},inputs:['assets/first.png']}).options.mode,'image');
  assert.equal(normalize({...task,options:{mode:'transition'},inputs:['assets/first.png','assets/last.jpg']}).options.mode,'transition');
  assert.equal(normalize({...task,options:{mode:'extend'},inputs:['assets/intro.mp4']}).options.mode,'extend');
  assert.equal(live.quote({...task,options:{mode:'extend',quality:'720p'},inputs:[{path:'assets/intro.mp4',seconds:3}]}).credits,45);
  assert.equal(live.quote({...task,seconds:3,options:{mode:'upscale'},inputs:[{path:'assets/intro.mp4',seconds:3}]}).credits,15);
  assert.equal(live.quote({...task,seconds:3,options:{mode:'modify',quality:'720p'},inputs:[{path:'assets/intro.mp4',seconds:3}]}).credits,36);
  assert.equal(live.quote({...task,options:{mode:'reference',quality:'360p'},inputs:['assets/first.png']}).credits,25);
  assert.throws(()=>request({...task,options:{mode:'extend'}}),/exactly one local video/);
  assert.throws(()=>request({...task,options:{mode:'extend'},inputs:['assets/first.png']}),/MP4, MOV or WebM/);
  assert.throws(()=>request({...task,options:{mode:'upscale',audio:true},inputs:['assets/intro.mp4']}),/does not generate audio/);
  assert.throws(()=>request({...task,options:{mode:'modify',quality:'1080p'},inputs:['assets/intro.mp4']}),/1080p/);
  assert.throws(()=>live.quote({...task,options:{mode:'upscale'},inputs:['assets/intro.mp4']}),/finite local video duration/);
  assert.throws(()=>request({...task,options:{mode:'extend'},inputs:[{path:'assets/intro.mp4',seconds:36}]}),/40 second/);
  assert.throws(()=>request({...task,seconds:30,options:{mode:'upscale'},inputs:[{path:'assets/intro.mp4',seconds:3}]}),/exceeds the source video/);
  assert.throws(()=>request({...task,seconds:10,options:{mode:'modify',quality:'540p'},inputs:[{path:'assets/intro.mp4',seconds:3}]}),/exceeds the source video/);
  assert.throws(()=>request({...task,seconds:3,options:{mode:'upscale'},inputs:[{path:'assets/intro.mp4',seconds:3,width:3840,height:2160}]}),/Already-4K/);
  assert.throws(()=>request({...task,options:{mode:'reference'}}),/1–8 local image/);
  assert.equal(request({...task,seconds:16,options:{mode:'modify',quality:'540p'},inputs:[{path:'assets/intro.mp4',seconds:20}]}).seconds,16);
  assert.throws(()=>request({...task,seconds:31,options:{mode:'modify',quality:'540p'},inputs:[{path:'assets/intro.mp4',seconds:40}]}),/Unsupported duration/);
  assert.equal(normalizeCli({...task,options:{model:'pixverse-c1'}}).options.model,'pixverse-c1');
  assert.throws(()=>normalizeCli({...task,options:{model:'../nope'}}),/CLI model/);
  const imageArgs=buildPixverseCliArgs({...task,options:{mode:'image',model:'v6',quality:'360p',aspect:'9:16'}},'task-key',['/tmp/a.png']);
  assert.equal(imageArgs[0],'create');
  assert.equal(imageArgs[1],'video');
  assert.ok(imageArgs.includes('--image')&&imageArgs.includes('/tmp/a.png'));
  assert.equal(imageArgs.includes('--aspect-ratio'),false);
  assert.ok(imageArgs.includes('--no-wait')&&imageArgs.includes('--idempotency-key'));
});
test('extend keeps the new tail and CLI errors do not repeat secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-pixverse-extend-'));
  const output = path.join(dir, 'out.mp4');
  let kept = null;
  const cli = createCli({
    command: ['pixverse'],
    invoke: async args => {
      if (args[0] === 'auth') return {authenticated: true};
      if (args[0] === 'create') { assert.equal(args[1], 'extend'); return {video_id: 'job-1'}; }
      if (args[0] === 'task') return {};
      await fs.writeFile(path.join(args[args.indexOf('--dest') + 1], 'clip.mp4'), 'video-bytes');
      return {};
    },
    keepTail: async (file, seconds) => { kept = {file, seconds}; }
  });
  await cli.make({task: {prompt: 'continue', seconds: 5, options: {mode: 'extend', model: 'v6'}}, output, inputs: ['/tmp/source.mp4'], idempotencyKey: 'k', onSubmitted: async () => {}});
  assert.equal(kept.file, output);
  assert.equal(kept.seconds, 5);
  assert.equal(await fs.readFile(output, 'utf8'), 'video-bytes');
  await fs.rm(dir, {recursive: true, force: true});
  await assert.rejects(runCommand([process.execPath, '-e', 'process.stderr.write("token=synthetic-review-token\\n"); process.exit(1)'], []), error => {
    assert.match(error.message, /\[redacted\]/);
    assert.equal(error.message.includes('synthetic-review-token'), false);
    assert.equal(String(error.stderr).includes('synthetic-review-token'), false);
    return true;
  });
});
