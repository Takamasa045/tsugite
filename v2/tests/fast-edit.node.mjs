import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,settings,page} from './helpers.mjs';
import {plan,make,exportVideo,currentPlan} from '../src/core.mjs';
import {addPlugin,bundledPlugin} from '../src/plugins.mjs';
import {validate,CARDS} from '../plugins/fast-edit/validate.mjs';
import {sampleFastEdit} from '../plugins/fast-edit/scene.mjs';
import {compile} from '../plugins/fast-edit/index.mjs';
import {migrate} from '../src/migrate.mjs';
import {read,write,fileHash} from '../src/files.mjs';
import {parse} from 'yaml';
import {command} from '../plugins/local/index.mjs';
function graph(cards=CARDS){return {version:1,global:{style:'energetic',color:'warm',caption_style:'bold',energy:'high',progress_bar:'bottom'},words:cards.map((card,i)=>({id:'w'+i,text:card.toUpperCase(),start:i,end:i+1})),beats:cards.map((card,i)=>({id:'b'+i,start:i,end:i+1,word_ids:['w'+i],edit:{visual_needed:true,card,text_effect:['none','pop','rise','typewriter'][i%4],transition:['cut','fade','zoom','wipe'][i%4],face_zoom:['none','medium','close'][i%3],sfx:['pop','whoosh','chime','none'][i%4],emphasis_word_id:'w'+i}}))};}
test('all eighteen Fast Edit cards and bounded edit choices produce frame-time scenes',()=>{
  const value=validate(graph(),18);for(let i=0;i<18;i++){const scene=sampleFastEdit({fast_edit:value,meta:{target_duration_seconds:18}},i+0.6,{width:360,height:640});assert.ok(scene.layers.some(n=>n.id==='fe-card'));assert.ok(scene.layers.some(n=>n.id==='fe-progress'));assert.equal(typeof scene.video.transform,'string');}
  for(const mutate of [v=>v.beats[0].edit.card='code()',v=>v.words[0].end=20,v=>v.beats[0].word_ids=['missing'],v=>v.beats[1].start=0.5,v=>v.beats[0].edit.emphasis_word_id='w1',v=>v.global.path='../x']){const bad=graph();mutate(bad);assert.throws(()=>validate(bad,18));}
  assert.equal(compile({version:1,segments:[{path:'assets/a.mp4',start:0,end:18}],fast_edit:value}).export,'fast-edit');
});
test('Fast Edit renderer exports all cards, emphasis, transitions, zoom and SFX through checks',{skip:!process.env.TSUGITE_BROWSER},async t=>{
  const {root}=await fixture(t);await addPlugin(root,await bundledPlugin('fast-edit'));await fs.symlink(process.env.TSUGITE_RENDERER_PEERS??fileURLToPath(new URL('../../node_modules/',import.meta.url)),path.join(root,'.tsugite/plugins/fast-edit/node_modules'),process.platform==='win32'?'junction':'dir');
  await settings(root,{length:'18s',export:'fast-edit',renderer_options:graph()});await plan(root);const ui=await page(t,root);assert.match(ui.html,/Renderer options/);assert.match(ui.html,/keyword/);await ui.submit('approve',{stage:'plan'});await make(root);const result=await exportVideo(root);assert.ok(Math.abs(result.seconds-18)<0.15);assert.equal(result.hasAudio,true);
  const {stderr}=await command('ffmpeg',['-i',path.join(root,'out/final.mp4'),'-af','volumedetect','-f','null','-']);assert.match(stderr,/mean_volume: -\d+/);
  if(process.env.TSUGITE_TEST_EVIDENCE){await fs.mkdir(process.env.TSUGITE_TEST_EVIDENCE,{recursive:true});await fs.copyFile(path.join(root,'out/final.mp4'),path.join(process.env.TSUGITE_TEST_EVIDENCE,'fast-edit-18-cards.mp4'));}
});
test('v1 Fast Edit decisions migrate as editable renderer options without importing approval',async t=>{
  const {root,home}=await fixture(t),before=await fileHash(root,'assets/intro.mp4'),destination=path.join(home,'v2-copy');
  await write(root,'project.yaml','name: Legacy Fast Edit\nmanifest: manifest.json\n');await write(root,'manifest.json',{meta:{aspect:'9:16',fps:24},clips:[{id:'clip',src:'assets/intro.mp4',in:0,out:1,duration:1}],fast_edit:graph(['keyword'])});await migrate(root,destination);const project=parse(await read(destination,'tsugite.yaml'));assert.equal(project.export,'fast-edit');assert.deepEqual(project.renderer_options,graph(['keyword']));assert.equal(await fileHash(root,'assets/intro.mp4'),before);await settings(destination,{execution:'mock'});await plan(destination);const ui=await page(t,destination);await ui.submit('approve',{stage:'plan'});await make(destination);await ui.refresh();await ui.submit('approve',{stage:'clips'});await exportVideo(destination);
});
