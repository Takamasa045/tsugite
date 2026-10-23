import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, status } from '../src/core.mjs';
import { fixture, page } from './helpers.mjs';

test('native confirmation forms preserve their origin and accept a UTF-8 form submission', async t => {
  const { root } = await fixture(t);
  await plan(root);
  const ui = await page(t, root);
  const response = await fetch(ui.url);
  // no-referrer makes a browser navigation-mode POST send Origin:null.
  // Keep the server's exact-origin guard, correct the page policy instead.
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
  for (const Origin of ['null', 'https://other.example', '']) {
    const rejected = await ui.submit('approve', { stage: 'plan' }, { headers: { Origin } });
    assert.equal(rejected.status, 403);
    assert.equal((await status(root)).checks.plan, 'waiting');
    assert.match(await rejected.text(), /Return to review/);
  }
  const accepted = await ui.submit('approve', { stage: 'plan' }, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(accepted.status, 303);
  assert.equal((await status(root)).checks.plan, 'approved');
  assert.equal((await status(root)).checks.final, 'waiting');
});

test('an invalid page token shows a recoverable error and records no approval', async t => {
  const { root } = await fixture(t);
  await plan(root);
  const ui = await page(t, root);
  const response = await ui.submit('approve', { stage: 'plan', csrf: 'stale' });
  assert.equal(response.status, 403);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const body = await response.text();
  assert.match(body, /Review needed/);
  assert.match(body, /href="\/"/);
  assert.equal((await status(root)).checks.plan, 'waiting');
});
