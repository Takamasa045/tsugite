import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture,settings,page} from './helpers.mjs';
import {plan,make,exportVideo} from '../src/core.mjs';
import {addPlugin} from '../src/plugins.mjs';
import {document} from '../plugins/hyperframes/index.mjs';
import {command,probe} from '../plugins/local/index.mjs';
import hyperframes from '../plugins/hyperframes/index.mjs';
test('existing HyperFrames runtime exports real sound and timed captions',{skip:!process.env.TSUGITE_HYPERFRAMES||!process.env.TSUGITE_GSAP||!process.env.TSUGITE_BROWSER},async t=>{
  const {root,home}=await fixture(t),scratch=path.join(home,'hf-scratch'),output=path.join(home,'hyperframes.mp4');await fs.mkdir(scratch);
  const tone=path.join(root,'assets/tone.wav');await command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1',tone]);
  await addPlugin(root,fileURLToPath(new URL('../plugins/hyperframes/',import.meta.url)));
  await settings(root,{length:'2s',export:'hyperframes',audio:[{path:'assets/tone.wav',start:0,seconds:2,volume:0.2,loop:true,kind:'bgm'},{path:'assets/tone.wav',start:0.5,seconds:0.5,volume:0.1,kind:'sfx'}],captions:[{start:0,end:2,text:'HYPERFRAMES TEST'}]});await plan(root);const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);const media=await exportVideo(root),final=path.join(root,'out/final.mp4');assert.ok(Math.abs(media.seconds-2)<0.15);assert.equal(media.width,360);assert.equal(media.hasAudio,true);
  assert.equal(media.hasCaptions,true,'Soft HyperFrames captions must remain selectable');
  const {stderr}=await command('ffmpeg',['-ss','1.3','-i',final,'-t','0.4','-af','volumedetect','-f','null','-']);assert.match(stderr,/mean_volume: -\d+/);assert.doesNotMatch(stderr,/mean_volume: -inf/);
  if(process.env.TSUGITE_TEST_EVIDENCE){await fs.mkdir(process.env.TSUGITE_TEST_EVIDENCE,{recursive:true});await fs.copyFile(final,path.join(process.env.TSUGITE_TEST_EVIDENCE,'hyperframes.mp4'));await fs.writeFile(path.join(process.env.TSUGITE_TEST_EVIDENCE,'hyperframes-runtime.json'),JSON.stringify(await hyperframes.runtime(),null,2));}
});
test('optional Remotion renderer consumes the same timeline without cloud execution',{skip:!process.env.TSUGITE_BROWSER},async t=>{
  const {root}=await fixture(t),directory=fileURLToPath(new URL('../plugins/remotion/',import.meta.url));
  await addPlugin(root,directory);
  // Only the isolated test fixture receives peer dependency links. Real plugin
  // users install the peer packages; no shared installation is mutated.
  const dependencyDir=path.join(root,'.tsugite/plugins/remotion/node_modules');
  await fs.symlink(process.env.TSUGITE_RENDERER_PEERS??fileURLToPath(new URL('../../node_modules/',import.meta.url)),dependencyDir,process.platform==='win32'?'junction':'dir');
  // Registry excludes node_modules; this cannot change the approved plugin code.
  await command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.5',path.join(root,'assets/tone.wav')]);
  await settings(root,{length:'1s',export:'remotion',captions:[{start:0,end:1,text:'REMOTION TEST'}],audio:[{path:'assets/tone.wav',start:0.1,volume:0.2}]});await plan(root);
  const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);
  const result=await exportVideo(root);assert.ok(Math.abs(result.seconds-1)<0.15);assert.equal(result.width,360);assert.equal(result.height,640);assert.equal(result.hasAudio,true);
  assert.equal(result.hasCaptions,true,'Soft Remotion captions must remain a selectable subtitle track');
  const {stderr}=await command('ffmpeg',['-i',path.join(root,'out/final.mp4'),'-af','volumedetect','-f','null','-']);assert.match(stderr,/mean_volume: -\d+/);assert.doesNotMatch(stderr,/mean_volume: -inf/);
  if(process.env.TSUGITE_TEST_EVIDENCE){await fs.mkdir(process.env.TSUGITE_TEST_EVIDENCE,{recursive:true});await fs.copyFile(path.join(root,'out/final.mp4'),path.join(process.env.TSUGITE_TEST_EVIDENCE,'remotion.mp4'));}
});
test('Remotion soft captions leave pixels unchanged; burn captions change pixels without a second preview track',{skip:!process.env.TSUGITE_BROWSER},async t=>{
  const {root,home}=await fixture(t);await addPlugin(root,fileURLToPath(new URL('../plugins/remotion/',import.meta.url)));await fs.symlink(process.env.TSUGITE_RENDERER_PEERS??fileURLToPath(new URL('../../node_modules/',import.meta.url)),path.join(root,'.tsugite/plugins/remotion/node_modules'),process.platform==='win32'?'junction':'dir');
  await command('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','color=c=black:s=360x640:r=24','-t','0.5','-c:v','libx264',path.join(root,'assets/black.mp4')]);
  const pixels=async file=>(await command('ffmpeg',['-v','error','-ss','0.2','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer'})).stdout;
  const outputs={};for(const mode of ['burn','soft']){await settings(root,{length:'0.5s',use:[{path:'assets/black.mp4',seconds:0.5}],export:'remotion',caption_mode:mode,captions:[{start:0,end:0.5,text:'VISIBLE CAPTION'}]});await plan(root);const ui=await page(t,root);await ui.submit('approve',{stage:'plan'});await make(root);const result=await exportVideo(root);await ui.refresh();const final=path.join(home,mode+'.mp4');await fs.copyFile(path.join(root,'out/final.mp4'),final);outputs[mode]=await pixels(final);assert.equal(result.hasCaptions,mode==='soft');if(mode==='soft'){assert.match(ui.html,/<track[^>]+captions\.vtt/);const {stdout}=await command('ffmpeg',['-v','error','-i',final,'-map','0:s:0','-f','srt','-']);assert.match(stdout,/VISIBLE CAPTION/);}else assert.doesNotMatch(ui.html,/<track\b/);}
  const bright=buffer=>buffer.reduce((n,v)=>n+(v>100?1:0),0);assert.equal(bright(outputs.soft),0,'Soft captions must not be burnt into black video');assert.ok(bright(outputs.burn)>100,'Burn captions must appear in actual rendered pixels');
});
test('HyperFrames contract uses timed local media and escapes caption text',()=>{
  const timeline={format:'9:16',seconds:3,clips:[{seconds:3,start:0,audio:false}],audio:[],captionMode:'burn',captions:[{start:0,end:1,text:'<script>alert(1)</script>'}]},html=document(timeline,[]);
  assert.match(html,/data-composition-id="tsugite"/);assert.match(html,/data-duration="3"/);assert.match(html,/gsap.timeline\(\{paused:true\}\)/);assert.doesNotMatch(html,/<script>alert/);assert.doesNotMatch(html,/https?:/);
  assert.match(html,/&lt;script&gt;alert/);assert.doesNotMatch(document({...timeline,captionMode:'soft'},[]),/id="caption-0"|&lt;script&gt;alert/);
});
test('Remotion synthetic mock plans without peers or a browser',async t=>{
  const {root}=await fixture(t);await addPlugin(root,fileURLToPath(new URL('../plugins/remotion/',import.meta.url)));
  const previous=process.env.TSUGITE_BROWSER;delete process.env.TSUGITE_BROWSER;
  t.after(()=>{if(previous===undefined)delete process.env.TSUGITE_BROWSER;else process.env.TSUGITE_BROWSER=previous;});
  await settings(root,{length:'1s',export:'remotion',execution:'mock'});await plan(root);
  const ui=await page(t,root);assert.match(ui.html,/MOCK: synthetic/);await ui.submit('approve',{stage:'plan'});await make(root);const result=await exportVideo(root);assert.ok(Math.abs(result.seconds-1)<0.15);
});
test('Remotion live planning fails closed without peers or an absolute browser',async t=>{
  const {root}=await fixture(t);await addPlugin(root,fileURLToPath(new URL('../plugins/remotion/',import.meta.url)));
  const previous=process.env.TSUGITE_BROWSER;delete process.env.TSUGITE_BROWSER;
  t.after(()=>{if(previous===undefined)delete process.env.TSUGITE_BROWSER;else process.env.TSUGITE_BROWSER=previous;});
  await settings(root,{export:'remotion'});await assert.rejects(plan(root),/peer packages|TSUGITE_BROWSER/);
});
test('HyperFrames synthetic mock renders without enabling the unverified runtime',async t=>{
  const {root}=await fixture(t);await addPlugin(root,fileURLToPath(new URL('../plugins/hyperframes/',import.meta.url)));await settings(root,{length:'1s',export:'hyperframes',execution:'mock'});await plan(root);
  const ui=await page(t,root);assert.match(ui.html,/MOCK: synthetic/);await ui.submit('approve',{stage:'plan'});await make(root);const result=await exportVideo(root);assert.ok(Math.abs(result.seconds-1)<0.15);
});
