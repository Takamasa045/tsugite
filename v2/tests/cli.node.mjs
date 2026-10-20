import {test} from 'node:test';
import assert from 'node:assert/strict';
import {help,main,browser} from '../src/cli.mjs';
import {fixture} from './helpers.mjs';

function captureIo(t) {
  const stdout=[], stderr=[];
  const writeOut=process.stdout.write.bind(process.stdout);
  const writeErr=process.stderr.write.bind(process.stderr);
  process.stdout.write=(chunk,...rest)=>{stdout.push(String(chunk));return true;};
  process.stderr.write=(chunk,...rest)=>{stderr.push(String(chunk));return true;};
  t.after(()=>{process.stdout.write=writeOut;process.stderr.write=writeErr;});
  return {stdout,stderr,text:parts=>parts.join('')};
}

function stubBrowser(t) {
  const opened=[];
  const original=browser.open;
  browser.open=url=>{opened.push(url);};
  t.after(()=>{browser.open=original;});
  return opened;
}

test('plan help documents --open and treats --no-open as deprecated',()=>{
  assert.match(help,/plan \[--no-review] \[--open] \[--no-open]/);
  assert.match(help,/does not open a browser unless --open/);
  assert.match(help,/--no-open is deprecated and ignored/);
});

test('plan prints the confirmation URL and does not open a browser by default',async t=>{
  const {root}=await fixture(t), opened=stubBrowser(t), io=captureIo(t);
  const page=await main(['plan','--project',root]);
  t.after(()=>page.close());
  const payload=JSON.parse(io.text(io.stdout));
  assert.equal(payload.ok,true);
  assert.equal(payload.opened,false);
  assert.match(payload.url,/^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(io.text(io.stderr),`確認画面: ${payload.url} （開くには --open）\n`);
  assert.deepEqual(opened,[]);
});

test('plan --open opens the confirmation page and --no-open stays a no-op',async t=>{
  const {root}=await fixture(t), opened=stubBrowser(t), io=captureIo(t);
  const page=await main(['plan','--project',root,'--open','--no-open']);
  t.after(()=>page.close());
  const payload=JSON.parse(io.text(io.stdout));
  assert.equal(payload.opened,true);
  assert.deepEqual(opened,[payload.url]);
  assert.equal(io.text(io.stderr),'');
});

test('plan --no-open alone is accepted and still does not open a browser',async t=>{
  const {root}=await fixture(t), opened=stubBrowser(t), io=captureIo(t);
  const page=await main(['plan','--project',root,'--no-open']);
  t.after(()=>page.close());
  const payload=JSON.parse(io.text(io.stdout));
  assert.equal(payload.opened,false);
  assert.match(io.text(io.stderr),/確認画面: http:\/\/127\.0\.0\.1:\d+\/ （開くには --open）\n/);
  assert.deepEqual(opened,[]);
});
