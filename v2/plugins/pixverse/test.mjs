import {test} from 'node:test';import assert from 'node:assert/strict';import mock from './mock.mjs';import live,{request,normalize,reconcile} from './index.mjs';
const task={prompt:'synthetic contract fixture',seconds:5,kind:'video',options:{}};
test('mock quote and fail-closed live entry',async()=>{assert.equal(mock.quote(task).credits,0);assert.equal(mock.quote(task).mock,true);await assert.rejects(live.make(),/disabled/);});
test('unknown receipts never imply refunds',()=>{assert.equal(reconcile({provider_job_id:'fixture',status:'failed'}).releaseReservation,false);assert.equal(reconcile({provider_job_id:'fixture',status:'failed',credits_charged:0}).releaseReservation,true);});
test('request, payload and quote reject invalid estimates without a provider call',()=>{
  assert.equal(typeof mock.normalize,'function');
  assert.equal(mock.normalize(task,{format:'9:16',defaults:{quality:'540p'}}).options.quality,'540p');
  assert.equal(normalize(task).options.model,'v6');
  assert.equal(live.quote({...task,options:{quality:'360p'}}).credits,25);
  assert.equal(live.quote({...task,options:{quality:'360p'}}).estimate,25);
  assert.throws(()=>request({...task,seconds:16}),/Unsupported duration/);
  assert.throws(()=>normalize({...task,options:{quality:'99p'}}),/Unsupported PixVerse/);
  assert.throws(()=>live.quote({...task,options:{quality:'360p',max_credits:24}}),/below the documented estimate/);
  assert.throws(()=>request({...task,options:{api_key:'do-not-store'}}),/credentials never belong/);
  assert.throws(()=>mock.quote({...task,options:{quality:'99p'}}),/Unsupported PixVerse/);
});
