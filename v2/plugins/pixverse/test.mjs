import {test} from 'node:test';import assert from 'node:assert/strict';import mock from './mock.mjs';import live,{reconcile} from './index.mjs';
const task={prompt:'synthetic contract fixture',seconds:5,kind:'video',options:{}};
test('mock quote and fail-closed live entry',async()=>{assert.equal(mock.quote(task).credits,0);await assert.rejects(live.make(),/disabled/);});
test('unknown receipts never imply refunds',()=>{assert.equal(reconcile({provider_job_id:'fixture',status:'failed'}).releaseReservation,false);assert.equal(reconcile({provider_job_id:'fixture',status:'failed',credits_charged:0}).releaseReservation,true);});
