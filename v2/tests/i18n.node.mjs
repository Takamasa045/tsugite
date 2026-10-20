import {test} from 'node:test';
import assert from 'node:assert/strict';
import {help,main} from '../src/cli.mjs';
import {plan} from '../src/core.mjs';
import {review} from '../src/review.mjs';
import {
  DEFAULT_LANGUAGE,
  extractLangOption,
  loadCatalog,
  missingCatalogKeys,
  normalizeLanguage,
  resolveLanguage,
  resolveLanguageFromEnvironment,
  t
} from '../src/i18n.mjs';
import {fixture,page,settings} from './helpers.mjs';

test('v2 default language stays English and help matches the previous text', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  assert.match(help, /plan \[--no-review] \[--open] \[--no-open]/);
  assert.match(help, /does not open a browser unless --open/);
  assert.equal(t('review.plan_storyboard'), 'Plan & storyboard');
  assert.equal(t('cli.path_notice', { url: 'http://127.0.0.1:9/' }), '確認画面: http://127.0.0.1:9/ （開くには --open）\n');
});

test('ja catalog covers every English key and falls back to en', () => {
  assert.deepEqual(missingCatalogKeys(), []);
  assert.deepEqual(Object.keys(loadCatalog('en')).sort(), Object.keys(loadCatalog('ja')).sort());
  assert.equal(t('review.plan_storyboard', undefined, 'ja'), '計画と絵コンテ');
  assert.equal(t('review.missing.key', undefined, 'ja'), 'review.missing.key');
});

test('language resolution order is CLI, env, user, project, then en', () => {
  assert.deepEqual(resolveLanguage({
    cliLang: 'ja',
    envLang: 'en',
    userConfigLang: 'en',
    projectLang: 'en'
  }), { language: 'ja', source: 'cli' });
  assert.deepEqual(resolveLanguage({ envLang: 'ja', projectLang: 'en' }), { language: 'ja', source: 'env' });
  assert.deepEqual(resolveLanguage({ projectLang: 'ja' }), { language: 'ja', source: 'project' });
  assert.deepEqual(resolveLanguage({}), { language: 'en', source: 'default' });
  assert.equal(normalizeLanguage('ja-JP'), 'ja');
  assert.equal(normalizeLanguage('fr'), undefined);
});

test('extractLangOption removes --lang from argv', () => {
  assert.deepEqual(extractLangOption(['--lang', 'ja', 'plan', '--open']), { argv: ['plan', '--open'], lang: 'ja' });
  assert.deepEqual(extractLangOption(['plan', '--project', 'x']), { argv: ['plan', '--project', 'x'], lang: undefined });
});

test('default confirmation page stays English', async t => {
  const {root} = await fixture(t);
  await plan(root);
  const ui = await page(t, root);
  assert.match(ui.html, /<html lang="en">/);
  assert.match(ui.html, /Plan & storyboard/);
  assert.match(ui.html, /Approve plan/);
  assert.doesNotMatch(ui.html, /計画と絵コンテ/);
});

test('review --lang ja switches the confirmation page', async t => {
  const {root} = await fixture(t);
  await plan(root);
  const ja = await review(root, { lang: 'ja' });
  t.after(() => ja.close());
  const jaHtml = await (await fetch(ja.url)).text();
  assert.match(jaHtml, /<html lang="ja">/);
  assert.match(jaHtml, /計画と絵コンテ/);
  assert.match(jaHtml, /計画を承認/);
  assert.doesNotMatch(jaHtml, /Plan & storyboard/);
});

test('plan keeps the Japanese path notice by default', async t => {
  const stderr = [];
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = writeErr; });
  const {root} = await fixture(t);
  const page = await main(['plan', '--project', root]);
  t.after(() => page.close());
  assert.equal(stderr.join(''), `確認画面: ${page.url} （開くには --open）\n`);
});

test('help --lang ja prints the Japanese catalog', async t => {
  const stdout = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  t.after(() => { process.stdout.write = writeOut; });
  await main(['--lang', 'ja', '--help']);
  assert.match(stdout.join(''), /使い方: tsugite/);
  assert.doesNotMatch(stdout.join(''), /Usage: tsugite/);
});

test('unsupported --lang fails closed', async () => {
  await assert.rejects(() => main(['--lang', 'fr', 'plan']), /Unsupported language/);
});

test('tsugite.yaml lang: ja switches the confirmation page', async t => {
  const {root} = await fixture(t);
  await settings(root, { lang: 'ja' });
  await plan(root);
  const ui = await page(t, root);
  assert.match(ui.html, /<html lang="ja">/);
  assert.match(ui.html, /計画と絵コンテ/);
});

test('TSUGITE_LANG is ignored by t() itself', () => {
  assert.equal(t('review.plan_storyboard'), 'Plan & storyboard');
  assert.equal(resolveLanguageFromEnvironment({
    env: { TSUGITE_LANG: 'ja' }
  }).language, 'ja');
  assert.equal(resolveLanguageFromEnvironment({
    env: { TSUGITE_LANG: 'en' },
    projectLang: 'ja'
  }).language, 'en');
});
