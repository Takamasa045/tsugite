import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTransport as pixverse,payload as pixPayload,liveBody,generatePath} from '../plugins/pixverse/transport.mjs';
import {createTransport as kling,billing,payload as klingPayload} from '../plugins/kling/transport.mjs';
import {createTransport as elevenlabs,payload as voicePayload} from '../plugins/elevenlabs/transport.mjs';
import {channel} from '../plugins/pixverse/http.mjs';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}}),key='fixture-secret-never-real',video={prompt:'synthetic fixture',seconds:5,options:{}},config={baseURL:'https://api.fixture.test',key,origins:['https://media.fixture.test'],wait:async()=>{}};
async function output(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tsugite-v2-transport-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return path.join(dir,'clip.mp4');}
// Synthetic schema fixtures based on the linked official references; these are
// neither captured paid responses nor evidence that a vendor executed a job.
test('PixVerse submission persists its task before polling, with isolated media headers',async t=>{
  const file=await output(t),calls=[];let persisted=false;
  const transport=pixverse({...config,fetch:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'error');if(url.includes('/text/generate')){assert.equal(options.headers['API-KEY'],key);assert.equal(JSON.parse(options.body).model,'v6');return json({ErrCode:0,Resp:{video_id:123,credits:25}});}if(url.includes('/result/')){assert.ok(persisted);return json({ErrCode:0,Resp:{id:123,status:1,url:'https://media.fixture.test/clip.mp4'}});}assert.deepEqual(options.headers,{});return new Response('fixture video bytes');}});
  const result=await transport.make({task:video,output:file,onSubmitted:async r=>{assert.equal(r.providerJobId,'123');persisted=true;}});
  assert.equal(calls.length,3);assert.equal(result.credits,null);assert.equal(await fs.readFile(file,'utf8'),'fixture video bytes');assert.notEqual(calls[0].options.headers['Ai-trace-id'],calls[1].options.headers['Ai-trace-id']);
});
test('PixVerse business errors, unknown outcomes and polling expiry never repeat submission',async t=>{
  const file=await output(t);for(const kind of ['business','network','pending','failed']){let posts=0;const transport=pixverse({...config,fetch:async(url,options)=>{if(options.method==='POST'){posts++;if(kind==='network')throw Error(key);return json(kind==='business'?{ErrCode:999,ErrMsg:key}:{ErrCode:0,Resp:{video_id:123}});}return json({ErrCode:0,Resp:{id:123,status:kind==='failed'?8:5}});}});await assert.rejects(kind==='pending'?transport.resume({providerJobId:'123',output:file,maxPolls:2}):transport.make({task:video,output:file,onSubmitted:async()=>{}}),e=>!e.message.includes(key));assert.equal(posts,kind==='pending'?0:1);}
});
test('Kling queries its external identity before creating and resumes an existing job',async t=>{
  const file=await output(t),calls=[];let persisted=false;const transport=kling({...config,fetch:async(url,options)=>{calls.push({url,options});assert.equal(options.headers?.Authorization??'',url.includes('media.')?'':'Bearer '+key);if(url.includes('external_task_ids='))return json({code:0,data:[{id:'job_1',external_id:'stable_key',status:'processing'}]});if(url.includes('task_ids=')){assert.ok(persisted);return json({code:0,data:[{id:'job_1',status:'succeeded',outputs:[{type:'video',url:'https://media.fixture.test/a.mp4'}],billing:[{charge_type:'unit',package_type:'video',amount:'1.250000'}]}]});}return new Response('video');}});
  assert.equal((await transport.make({task:video,idempotencyKey:'stable_key',output:file,onSubmitted:async()=>{persisted=true;}})).credits,1.25);assert.ok(!calls.some(x=>x.options.method==='POST'));
});
test('Kling new task payload is versioned and cash billing is never converted to credits',async t=>{
  const file=await output(t);let submitted=false;const transport=kling({...config,fetch:async(url,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);assert.equal(body.settings.resolution,'720p');assert.equal(body.options.external_task_id,'new_key');assert.equal(body.settings.multi_shot,false);submitted=true;return json({code:0,data:{id:'new_job'}});}if(url.includes('external_task_ids='))return json({code:0,data:[]});if(url.includes('task_ids='))return json({code:0,data:[{id:'new_job',status:'succeeded',outputs:[{type:'video',url:'https://media.fixture.test/a.mp4'}],billing:[{charge_type:'cash',currency:'USD',amount:'2'}]}]});return new Response('video');}});
  assert.equal((await transport.make({task:video,idempotencyKey:'new_key',output:file,onSubmitted:async()=>{}})).credits,null);assert.ok(submitted);assert.equal(billing([{charge_type:'unit',package_type:'audio',amount:'1'}]),null);assert.equal(billing([]),null);
});
test('ElevenLabs uses chosen voice and default model, and retains unknown billing',async t=>{
  const file=await output(t),task={prompt:'spoken fixture',seconds:3,options:{voice_id:'fixture_voice'}};let calls=0;const transport=elevenlabs({...config,fetch:async(url,options)=>{calls++;assert.match(url,/fixture_voice\/with-timestamps/);assert.equal(options.headers['xi-api-key'],key);assert.equal(JSON.parse(options.body).model_id,'eleven_multilingual_v2');return json({audio_base64:Buffer.from('fixture audio').toString('base64'),alignment:null});},convert:async(input,out)=>fs.copyFile(input,out)});
  assert.equal((await transport.make({task,output:file,onSubmitted:async()=>{}})).credits,null);assert.equal(calls,1);assert.equal(await fs.readFile(file,'utf8'),'fixture audio');
});
test('HTTP transport rejects redirects, oversized bodies, unapproved URLs and secret error echoes',async()=>{
  let count=0;const http=channel({...config,header:'API-KEY',fetch:async()=>{count++;return new Response('x',{headers:{'content-length':'999999999'}});}});await assert.rejects(http.json('/a'),/Invalid or oversized/);for(const value of ['http://media.fixture.test/a','https://api.fixture.test/a','https://user:pass@media.fixture.test/a','https://127.0.0.1/a'])await assert.rejects(http.media(value),/origin/);assert.equal(count,1);
  const redirect=channel({...config,header:'API-KEY',fetch:async(_,o)=>{assert.equal(o.redirect,'error');throw Error(key);}});await assert.rejects(redirect.json('/a'),e=>!e.message.includes(key));assert.throws(()=>kling({...config,key:undefined,fetch:async()=>{}}),/credential/);
});
test('PixVerse image and transition upload before generate, and never send JSON content-type on multipart',async t=>{
  const file=await output(t),frame=path.join(path.dirname(file),'frame.png');
  await fs.writeFile(frame,'fixture-png-bytes');
  const imageTask={prompt:'synthetic fixture',seconds:5,options:{mode:'image',quality:'360p'}};
  const transitionTask={prompt:'synthetic fixture',seconds:5,options:{mode:'transition',quality:'540p',audio:true}};
  assert.equal(generatePath(imageTask),'/openapi/v2/video/img/generate');
  assert.equal(generatePath(transitionTask),'/openapi/v2/video/transition/generate');
  assert.deepEqual(liveBody(imageTask,['123456789']),{model:'v6',prompt:'synthetic fixture',duration:5,quality:'360p',img_id:123456789,generate_audio_switch:false});
  assert.deepEqual(liveBody(transitionTask,['1','2']),{model:'v6',prompt:'synthetic fixture',duration:5,quality:'540p',first_frame_img:1,last_frame_img:2,generate_audio_switch:true});
  assert.equal(liveBody(video,[]).generate_audio_switch,undefined);
  assert.equal(liveBody({...video,options:{audio:true}},[]).generate_audio_switch,true);
  const calls=[];let persisted=false;
  const transport=pixverse({...config,fetch:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/image/upload')){
      assert.equal(options.headers['Content-Type'],undefined);
      assert.equal(options.headers['API-KEY'],key);
      assert.ok(options.body instanceof FormData);
      return json({ErrCode:0,Resp:{img_id:123456789,img_url:'https://media.fixture.test/frame.png'}});
    }
    if(url.includes('/img/generate')){
      assert.equal(JSON.parse(options.body).img_id,123456789);
      assert.equal(JSON.parse(options.body).aspect_ratio,undefined);
      return json({ErrCode:0,Resp:{video_id:99}});
    }
    if(url.includes('/result/')){assert.ok(persisted);return json({ErrCode:0,Resp:{id:99,status:1,url:'https://media.fixture.test/clip.mp4'}});}
    assert.deepEqual(options.headers,{});
    return new Response('fixture video bytes');
  }});
  const result=await transport.make({task:imageTask,output:file,inputs:[frame],onSubmitted:async r=>{assert.equal(r.providerJobId,'99');persisted=true;}});
  assert.equal(result.credits,null);
  assert.equal(await fs.readFile(file,'utf8'),'fixture video bytes');
  assert.equal(calls.filter(x=>x.url.includes('/image/upload')).length,1);
  assert.throws(()=>liveBody(imageTask,[]),/uploaded image id/);
});
test('ElevenLabs forwards documented models and voice settings without inventing credits',async t=>{
  const file=await output(t),task={prompt:'spoken fixture',seconds:3,options:{voice_id:'fixture_voice',model:'eleven_turbo_v2_5',stability:0.4,similarity_boost:0.8,style:0.1,speed:1.1,use_speaker_boost:false,language_code:'ja',apply_text_normalization:'on'}};
  let body;
  const transport=elevenlabs({...config,fetch:async(url,options)=>{assert.match(url,/fixture_voice\/with-timestamps/);body=JSON.parse(options.body);return json({audio_base64:Buffer.from('fixture audio').toString('base64'),alignment:null});},convert:async(input,out)=>fs.copyFile(input,out)});
  assert.equal((await transport.make({task,output:file,onSubmitted:async()=>{}})).credits,null);
  assert.deepEqual(body,{text:'spoken fixture',model_id:'eleven_turbo_v2_5',voice_settings:{stability:0.4,similarity_boost:0.8,style:0.1,speed:1.1,use_speaker_boost:false},language_code:'ja',apply_text_normalization:'on'});
});
test('unsupported models, task identifiers and settings fail before any request',()=>{
  assert.throws(()=>pixPayload({...video,options:{model:'unsupported'}}));assert.throws(()=>klingPayload(video,'../escape'));assert.throws(()=>voicePayload({...video,options:{voice_id:'../voice'}}));assert.throws(()=>pixPayload({...video,seconds:16}));
  assert.throws(()=>voicePayload({prompt:'spoken',seconds:3,options:{voice_id:'fixture_voice',model:'eleven_v4_turbo'}}));
  assert.throws(()=>voicePayload({prompt:'spoken',seconds:3,options:{voice_id:'fixture_voice',speed:0.5}}));
  assert.throws(()=>pixPayload({...video,options:{mode:'other'}}));
});
