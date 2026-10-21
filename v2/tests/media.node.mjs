import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,settings,page} from './helpers.mjs';
import {plan,make,exportVideo,currentPlan,state} from '../src/core.mjs';
import {write,fileHash} from '../src/files.mjs';
import {addPlugin} from '../src/plugins.mjs';
import {command,probe} from '../plugins/local/index.mjs';
import {migrate} from '../src/migrate.mjs';
const plugins=fileURLToPath(new URL('../plugins/',import.meta.url));
const tone=async(file)=>command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3',file]);
async function render(t,root){await plan(root);const ui=await page(t,root);assert.equal((await ui.submit('approve',{stage:'plan'})).status,303);await make(root);await ui.refresh();if((await ui.submit('approve',{stage:'clips'})).status!==303)throw new Error('Clips approval failed');return exportVideo(root);}
test('audio mix, trims, SRT and portrait reframing produce audible captioned MP4',async t=>{
  const {root}=await fixture(t);await tone(path.join(root,'assets/tone.wav'));await write(root,'assets/titles.srt','1\n00:00:00,200 --> 00:00:01,800\nCAPTION TEST\n');
  await write(root,'taste/checks.json',[{kind:'max_bgm_start',value:0.5}]);
  await settings(root,{length:'2s',use:[{path:'assets/intro.mp4',start:0.5,seconds:2}],audio:[{path:'assets/tone.wav',start:0.1,seconds:1.8,volume:0.2,kind:'bgm'}],captions:'assets/titles.srt',format:'16:9'});
  const output=await render(t,root);assert.equal(output.width,640);assert.equal(output.height,360);assert.equal((await probe(path.join(root,'out/final.mp4'))).hasAudio,true);
  const {stderr}=await command('ffmpeg',['-i',path.join(root,'out/final.mp4'),'-af','volumedetect','-f','null','-']);assert.doesNotMatch(stderr,/mean_volume: -inf/);assert.match(stderr,/mean_volume: -\d+/);
  assert.equal((await probe(path.join(root,'out/final.mp4'))).hasCaptions,true);
  const {stdout:extracted}=await command('ffmpeg',['-v','error','-i',path.join(root,'out/final.mp4'),'-map','0:s:0','-f','srt','-']);assert.match(extracted,/CAPTION TEST/);
  const ui=await page(t,root),vtt=await fetch(ui.url+'captions.vtt',{headers:{Cookie:ui.cookie}});assert.match(await vtt.text(),/CAPTION TEST/);assert.match(ui.html,/approved timeline schedule/);
  if(process.env.TSUGITE_TEST_EVIDENCE){await fs.mkdir(process.env.TSUGITE_TEST_EVIDENCE,{recursive:true});await fs.copyFile(path.join(root,'out/final.mp4'),path.join(process.env.TSUGITE_TEST_EVIDENCE,'audio-captions.mp4'));}
});
test('burned captions are preflighted against the actual FFmpeg build',async t=>{
  const {root}=await fixture(t);await settings(root,{caption_mode:'burn',captions:[{start:0,end:1,text:'BURN TEST'}]});
  const {stdout}=await command('ffmpeg',['-hide_banner','-filters']);
  if(!/\bsubtitles\s/.test(stdout))await assert.rejects(plan(root),/requires FFmpeg with libass/);
  else {const result=await render(t,root);assert.ok(result.seconds>0);const ui=await page(t,root);assert.doesNotMatch(ui.html,/<track\b/);assert.equal(result.hasCaptions,false);}
});
test('audio/subtitle modification invalidates plan and unsafe media inputs fail',async t=>{
  const {root}=await fixture(t);await tone(path.join(root,'assets/tone.wav'));await settings(root,{audio:[{path:'assets/tone.wav'}],captions:[{start:0,end:1,text:'safe'}]});await plan(root);
  await fs.appendFile(path.join(root,'assets/tone.wav'),'changed');await assert.rejects(currentPlan(root),/no longer matches/);
  await settings(root,{audio:[{path:'../escape.wav'}]});await assert.rejects(plan(root),/assets/);
  await settings(root,{audio:[],captions:[{start:1,end:0,text:'invalid'}]});await assert.rejects(plan(root),/caption end/);
});
test('still images need explicit seconds and render as held frames',async t=>{
  const {root}=await fixture(t);
  await command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','color=c=red:s=360x640','-frames:v','1',path.join(root,'assets/hold.png')]);
  await settings(root,{length:'1s',use:[{path:'assets/hold.png'}]});
  await assert.rejects(plan(root),/explicit seconds/);
  await settings(root,{use:[{path:'assets/hold.png',seconds:1,audio:true}]});
  await assert.rejects(plan(root),/no source audio/);
  await settings(root,{use:[{path:'assets/hold.png',seconds:1}]});
  const output=await render(t,root);
  assert.equal(output.width,360);
  assert.equal(output.height,640);
  assert.ok(Math.abs(output.seconds-1)<0.15);
});
test('PixVerse image mocks bind local still hashes and reject text-mode inputs',async t=>{
  const {root}=await fixture(t);await addPlugin(root,path.join(plugins,'pixverse'));
  await command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','color=c=blue:s=360x640','-frames:v','1',path.join(root,'assets/first.png')]);
  await settings(root,{length:'5s',use:[],execution:'mock',make:[{id:'shot',with:'pixverse',prompt:'mock picture',seconds:5,options:{mode:'image'}}]});
  await assert.rejects(plan(root),/exactly one local image/);
  await settings(root,{make:[{id:'shot',with:'pixverse',prompt:'mock picture',seconds:5,inputs:['assets/first.png']}]});
  await assert.rejects(plan(root),/does not take local media/);
  await settings(root,{make:[{id:'shot',with:'pixverse',prompt:'mock picture',seconds:5,options:{mode:'image'},inputs:['assets/first.png']}]});
  const planned=await plan(root);
  assert.equal(planned.plan.tasks[0].options.mode,'image');
  assert.equal(planned.plan.tasks[0].inputs[0].path,'assets/first.png');
  assert.equal(planned.plan.tasks[0].inputs[0].hash,await fileHash(root,'assets/first.png'));
  assert.ok(planned.plan.tasks[0].inputs[0].bytes>0);
  await fs.appendFile(path.join(root,'assets/first.png'),'changed');
  await assert.rejects(currentPlan(root),/no longer matches/);
  await settings(root,{make:[{id:'shot',with:'pixverse',prompt:'mock picture',seconds:5,options:{audio:true}}]});
  const voiced=await plan(root);
  assert.equal(voiced.plan.timeline.clips.find(clip=>clip.id==='shot').audio,true);
  await fs.writeFile(path.join(root,'assets/oversize.png'),Buffer.alloc(20*1024*1024+1));
  await settings(root,{make:[{id:'shot',with:'pixverse',prompt:'mock picture',seconds:5,options:{mode:'image'},inputs:['assets/oversize.png']}]});
  await assert.rejects(plan(root),/20 MB/);
});
test('PixVerse video modes and ElevenLabs music/SFX bind local contracts without credits',async t=>{
  const {root}=await fixture(t);await addPlugin(root,path.join(plugins,'pixverse'));await addPlugin(root,path.join(plugins,'elevenlabs'));
  await settings(root,{length:'5s',use:[],execution:'mock',make:[{id:'shot',with:'pixverse',prompt:'continue the scene',seconds:5,options:{mode:'extend'},inputs:['assets/intro.mp4']}]});
  const extended=await plan(root);
  assert.equal(extended.plan.tasks[0].options.mode,'extend');
  assert.equal(extended.plan.tasks[0].inputs[0].path,'assets/intro.mp4');
  assert.ok(extended.plan.tasks[0].inputs[0].seconds>0);
  await settings(root,{length:'8s',use:[{path:'assets/intro.mp4',loop:true}],make:[{id:'score',with:'elevenlabs',kind:'audio',prompt:'upbeat cue',seconds:8,options:{mode:'music',force_instrumental:true}}]});
  const music=await plan(root);
  assert.equal(music.plan.tasks[0].options.mode,'music');
  assert.equal(music.plan.tasks[0].options.model,'music_v2_5');
  await settings(root,{length:'2s',use:[{path:'assets/intro.mp4',seconds:2}],make:[{id:'hit',with:'elevenlabs',kind:'audio',prompt:'door slam',seconds:1.5,options:{mode:'sfx',prompt_influence:0.4}}]});
  const sfx=await plan(root);
  assert.equal(sfx.plan.tasks[0].options.mode,'sfx');
  assert.equal(sfx.plan.tasks[0].options.model,'eleven_text_to_sound_v2');
  await settings(root,{length:'5s',use:[],make:[{id:'shot',with:'pixverse',prompt:'continue',seconds:5,options:{mode:'extend'}}]});
  await assert.rejects(plan(root),/exactly one local video/);
  await settings(root,{use:[{path:'assets/intro.mp4',loop:true}],make:[{id:'score',with:'elevenlabs',kind:'audio',prompt:'cue',seconds:2,options:{mode:'music'}}]});
  await assert.rejects(plan(root),/3–600/);
});
test('service video and narration mocks run with zero provider credits and are content bound',async t=>{
  const {root}=await fixture(t);await addPlugin(root,path.join(plugins,'pixverse'));await addPlugin(root,path.join(plugins,'elevenlabs'));
  await settings(root,{length:'8s',execution:'mock',make:[{id:'shot',with:'pixverse',prompt:'mock picture',seconds:5},{id:'voice',with:'elevenlabs',kind:'audio',prompt:'mock voice',seconds:3,options:{voice_id:'fixture-voice'}}]});
  const result=await render(t,root);assert.equal(result.hasAudio,true);assert.equal((await state(root)).ledger.entries.reduce((s,e)=>s+e.actual,0),0);assert.equal(Object.values((await state(root)).jobs).length,2);
  await settings(root,{execution:'offline'});await assert.rejects(plan(root),/Network plugins are disabled/);
});
test('v1 migration copies unequal trims, audio and plain captions without altering sources',async t=>{
  const {root,home}=await fixture(t);await tone(path.join(root,'assets/tone.wav'));
  await write(root,'project.yaml','name: v1 copy\nmanifest: manifest.json\n');await write(root,'manifest.json',{meta:{aspect:'9:16',fps:24},clips:[{id:'a',src:'assets/intro.mp4',in:0.5,out:1.5,duration:1,audio:false},{id:'b',src:'assets/intro.mp4',in:0,out:2,duration:2,audio:false}],audio:{bgm:[{src:'assets/tone.wav',start:0,end:3,volume:0.2}],narration:[],sfx:[]},captions:[{start:0.1,end:1,text:'migrated'}]});
  const before=await fileHash(root,'assets/intro.mp4'),dest=path.join(home,'migrated');await migrate(root,dest);await plan(dest);assert.equal((await currentPlan(dest)).plan.timeline.clips[0].start,0.5);await render(t,dest);assert.equal(await fileHash(root,'assets/intro.mp4'),before);
});
