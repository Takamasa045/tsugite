import {test} from 'node:test';import assert from 'node:assert/strict';import mock from './mock.mjs';import live from './index.mjs';
test('mock quote is zero-credit fixture output, not Remotion execution',()=>{assert.equal(mock.quote().credits,0);assert.equal(mock.quote().service,'local');assert.equal(live.quote().credits,0);assert.equal(live.quote().service,'remotion');});
test('live planning runtime fails closed without peers or an absolute browser',async()=>{
  const previous=process.env.TSUGITE_BROWSER;
  try{
    delete process.env.TSUGITE_BROWSER;
    await assert.rejects(live.runtime(),/peer packages|TSUGITE_BROWSER/);
    process.env.TSUGITE_BROWSER='chrome';
    await assert.rejects(live.runtime(),/peer packages|existing browser/);
  }finally{
    if(previous===undefined)delete process.env.TSUGITE_BROWSER;else process.env.TSUGITE_BROWSER=previous;
  }
});
