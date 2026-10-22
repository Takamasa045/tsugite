import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture, settings, page} from './helpers.mjs';
import {write} from '../src/files.mjs';
import {addPlugin, bundledPlugin} from '../src/plugins.mjs';
import {plan, make, state} from '../src/core.mjs';
import {pluginSettings} from '../src/settings.mjs';
import {discoverTopviewCommand} from '../plugins/topview/cli.mjs';
import {createCli as createKlingCli} from '../plugins/kling/cli.mjs';
import {knownCredits} from '../plugins/pixverse/cli-run.mjs';

const fakeSource = `import {appendFileSync, copyFileSync, mkdirSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CLI_LOG, JSON.stringify(args) + '\\n');
const kind = process.env.CLI_KIND;
const loginFailed = process.env.CLI_LOGIN === 'no';
if (kind === 'pixverse' && args[0] === 'auth') {
  if (loginFailed) { process.stdout.write(JSON.stringify({authenticated:false,message:'Not logged in'})); process.exit(3); }
  process.stdout.write(JSON.stringify({authenticated:true,credits:9999}));
  process.exit(0);
}
if (kind === 'kling' && args[0] === 'who_am_i') {
  if (loginFailed) { process.stderr.write('please login\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ok:true,user:{userId:'fixture-user'}}));
  process.exit(0);
}
if (kind === 'topview' && args.includes('status')) {
  if (loginFailed) { process.stdout.write('Not logged in.\\n'); process.exit(1); }
  process.stdout.write('Logged in\\n');
  process.exit(0);
}
if (kind === 'pixverse' && args[0] === 'create') { process.stdout.write(JSON.stringify({video_id:'pix-job-1'})); process.exit(0); }
if (kind === 'pixverse' && args[0] === 'task') {
  const body = {};
  if (process.env.CLI_CREDITS) body.credits = Number(process.env.CLI_CREDITS);
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}
if (kind === 'pixverse' && args[0] === 'asset') {
  const dest = args[args.indexOf('--dest') + 1];
  mkdirSync(dest, {recursive:true});
  copyFileSync(process.env.CLI_MEDIA, dest + '/clip.mp4');
  process.stdout.write('{}');
  process.exit(0);
}
if (kind === 'kling' && args[0] === 'text_to_video') {
  const file = process.env.CLI_LOG + '.mp4';
  copyFileSync(process.env.CLI_MEDIA, file);
  const body = {generationId:'kling-job-1', works:[{url:file}]};
  if (process.env.CLI_CREDITS) body.creditsConsumed = Number(process.env.CLI_CREDITS);
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}
if (kind === 'topview' && args[0] === 'run') {
  const dest = args[args.indexOf('--output-dir') + 1];
  mkdirSync(dest, {recursive:true});
  copyFileSync(process.env.CLI_MEDIA, dest + '/clip.mp4');
  const body = {taskId:'topview-job-1', status:'success'};
  if (process.env.CLI_CREDITS) body.costCredit = Number(process.env.CLI_CREDITS);
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}
process.stderr.write('unexpected fake cli args\\n');
process.exit(1);
`;

async function installFake(t, home, kind) {
  const script = path.join(home, 'fake-cli.mjs');
  const log = path.join(home, 'cli.log');
  await fs.writeFile(script, fakeSource);
  const command = [process.execPath, script];
  const previous = {PIXVERSE_CLI: process.env.PIXVERSE_CLI, KLING_CLI: process.env.KLING_CLI, TSUGITE_TOPVIEW_VIDEO_COMMAND: process.env.TSUGITE_TOPVIEW_VIDEO_COMMAND};
  delete process.env.PIXVERSE_CLI; delete process.env.KLING_CLI; delete process.env.TSUGITE_TOPVIEW_VIDEO_COMMAND;
  process.env.CLI_LOG = log; process.env.CLI_KIND = kind; process.env.CLI_MEDIA = path.join(home, 'project', 'assets', 'intro.mp4');
  delete process.env.CLI_LOGIN; delete process.env.CLI_CREDITS;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete process.env.CLI_LOG; delete process.env.CLI_KIND; delete process.env.CLI_MEDIA; delete process.env.CLI_LOGIN; delete process.env.CLI_CREDITS;
  });
  return {script, log, command};
}
async function cliConfig(plugin, command) {
  await fs.mkdir(process.env.TSUGITE_HOME, {recursive: true});
  await write(process.env.TSUGITE_HOME, 'config.json', {version: 1, plugins: {[plugin]: {connection: {enabled: true, transport: 'cli', command}}}});
}
async function lines(log) {
  try { return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

test('subscription CLI helpers are copied with each plugin', async () => {
  const plugins = fileURLToPath(new URL('../plugins/', import.meta.url));
  const read = name => fs.readFile(path.join(plugins, name, 'cli-run.mjs'), 'utf8');
  const pixverse = await read('pixverse');
  assert.equal(await read('kling'), pixverse);
  assert.equal(await read('topview'), pixverse);
  assert.match(pixverse, /export function knownCredits/);
});

test('an enabled connection without HTTP fields is the CLI subscription default', async t => {
  const {home} = await fixture(t);
  await fs.mkdir(process.env.TSUGITE_HOME, {recursive: true});
  await write(process.env.TSUGITE_HOME, 'config.json', {version: 1, plugins: {pixverse: {connection: {enabled: true}}}});
  const selected = await pluginSettings('pixverse');
  assert.equal(selected.connection.transport, 'cli');
  assert.equal(selected.connection.credential_env, undefined);
  await assert.rejects(pluginSettings('pixverse').then(() => write(process.env.TSUGITE_HOME, 'config.json', {version: 1, plugins: {pixverse: {connection: {enabled: true, transport: 'cli', base_url: 'https://api.fixture.test'}}}}).then(() => pluginSettings('pixverse'))), /CLI connection or an HTTP/);
  await write(process.env.TSUGITE_HOME, 'config.json', {version: 1, plugins: {pixverse: {connection: {enabled: true, command: 'pixverse; rm -rf /'}}}});
  await assert.rejects(pluginSettings('pixverse'), /shell line/);
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-topview-missing-'));
  t.after(() => fs.rm(empty, {recursive: true, force: true}));
  assert.throws(() => discoverTopviewCommand(empty, {}), /not installed/);
  assert.equal(knownCredits({authenticated: true, credits: null}), null);
  assert.equal(knownCredits({cost: {credits: 4}}), 4);
  assert.equal(home.length > 0, true);
});

test('PixVerse CLI runs only after approval, ignores account balance, and keeps an unknown charge reserved', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'pixverse');
  await addPlugin(root, await bundledPlugin('pixverse'));
  await cliConfig('pixverse', fake.command);
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'pixverse', prompt: 'fixture request', seconds: 3, options: {max_credits: 30}}], budget: {pixverse: 30}});
  const planned = await plan(root);
  assert.equal(planned.plan.tasks[0].quote.credits, 30);
  assert.equal(planned.plan.tasks[0].quote.estimate, undefined);
  assert.equal(planned.plan.plugins.pixverse.settings.connection.transport, 'cli');
  await assert.rejects(make(root), /Waiting for plan/);
  assert.deepEqual(await lines(fake.log), []);
  const ui = await page(t, root);
  assert.match(ui.html, /&quot;transport&quot;: &quot;cli&quot;/);
  assert.doesNotMatch(ui.html, /9999|credential_env|api\.fixture/);
  await ui.submit('approve', {stage: 'plan'});
  const made = await make(root);
  assert.equal(made.made, 1);
  const argv = await lines(fake.log);
  assert.ok(argv.some(args => args[0] === 'auth' && args[1] === 'status'));
  assert.ok(argv.some(args => args[0] === 'create' && args.includes('--no-wait') && args.includes('--idempotency-key')));
  assert.equal(argv.some(args => args.includes('9999')), false);
  const saved = await state(root);
  assert.equal(saved.jobs[planned.plan.tasks[0].key].status, 'done');
  assert.equal(saved.jobs[planned.plan.tasks[0].key].providerJobId, 'pix-job-1');
  assert.equal(saved.ledger.entries[0].status, 'uncertain');
  assert.equal(saved.ledger.entries[0].actual, undefined);
});

test('PixVerse CLI rejects a missing command before create and keeps the reservation', async t => {
  const {root} = await fixture(t);
  await addPlugin(root, await bundledPlugin('pixverse'));
  await cliConfig('pixverse', ['/no/such/pixverse-cli-4b34']);
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'pixverse', prompt: 'fixture request', seconds: 3, options: {max_credits: 30}}], budget: {pixverse: 30}});
  await plan(root);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await assert.rejects(make(root), /not installed/);
  assert.equal((await state(root)).ledger.entries[0].status, 'uncertain');
});

test('PixVerse CLI rejects a logged-out command before create', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'pixverse');
  await addPlugin(root, await bundledPlugin('pixverse'));
  await cliConfig('pixverse', fake.command);
  process.env.CLI_LOGIN = 'no';
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'pixverse', prompt: 'fixture request', seconds: 3, options: {max_credits: 30}}], budget: {pixverse: 30}});
  await plan(root);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await assert.rejects(make(root), /not logged in/);
  assert.equal((await lines(fake.log)).some(args => args[0] === 'create'), false);
  assert.equal((await state(root)).ledger.entries[0].status, 'uncertain');
});

test('PixVerse CLI settles a numeric charge from the wait result', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'pixverse');
  await addPlugin(root, await bundledPlugin('pixverse'));
  await cliConfig('pixverse', fake.command);
  process.env.CLI_CREDITS = '4';
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'pixverse', prompt: 'fixture request', seconds: 3, options: {max_credits: 30}}], budget: {pixverse: 30}});
  await plan(root);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await make(root);
  const saved = await state(root);
  assert.equal(saved.ledger.entries.at(-1).status, 'settled');
  assert.equal(saved.ledger.entries.at(-1).actual, 4);
});

test('Kling CLI downloads no credentialed URL, settles a reported amount, and stops when logged out', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'kling');
  await addPlugin(root, await bundledPlugin('kling'));
  await cliConfig('kling', fake.command);
  process.env.CLI_CREDITS = '1.25';
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'kling', prompt: 'fixture request', seconds: 5, options: {model: 'kling-v3', max_credits: 5}}], budget: {kling: 5}});
  const planned = await plan(root);
  assert.equal(planned.plan.tasks[0].options.model, 'kling-v3');
  assert.equal(planned.plan.tasks[0].quote.credits, 5);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await make(root);
  const saved = await state(root);
  assert.equal(saved.jobs[planned.plan.tasks[0].key].providerJobId, 'kling-job-1');
  assert.equal(saved.ledger.entries[0].status, 'settled');
  assert.equal(saved.ledger.entries[0].actual, 1.25);
  const bytes = await fs.readFile(path.join(root, 'assets', 'intro.mp4'));
  let headers;
  const transport = createKlingCli({command: ['kling'], invoke: async args => args[0] === 'who_am_i' ? {user: {userId: 'fixture'}} : {generationId: 'job_9', works: [{url: 'https://cdn.example/a.mp4'}]}, fetch: async (url, options) => { headers = options.headers; assert.equal(options.redirect, 'error'); assert.equal(url.hostname, 'cdn.example'); return new Response(bytes); }});
  const file = path.join(home, 'remote.mp4');
  const result = await transport.make({task: planned.plan.tasks[0], output: file, onSubmitted: async () => {}});
  assert.equal(result.credits, null);
  assert.equal(headers, undefined);
});

test('Kling CLI stops before text_to_video when logged out', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'kling');
  await addPlugin(root, await bundledPlugin('kling'));
  await cliConfig('kling', fake.command);
  process.env.CLI_LOGIN = 'no';
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'kling', prompt: 'fixture request', seconds: 5, options: {model: 'kling-v3', max_credits: 5}}], budget: {kling: 5}});
  await plan(root);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await assert.rejects(make(root), /not logged in/);
  assert.equal((await lines(fake.log)).some(args => args[0] === 'text_to_video'), false);
  assert.equal((await state(root)).ledger.entries[0].status, 'uncertain');
});

test('TopView CLI requires an explicit ceiling and treats a missing cost as unknown', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'topview');
  await addPlugin(root, await bundledPlugin('topview'));
  await cliConfig('topview', fake.command);
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'topview', prompt: 'fixture request', seconds: 5, options: {model: 'Standard'}}], budget: {topview: 9}});
  await assert.rejects(plan(root), /explicit positive/);
  await settings(root, {make: [{id: 'shot', with: 'topview', prompt: 'fixture request', seconds: 5, options: {model: 'Standard', max_credits: 9}}]});
  const planned = await plan(root);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await make(root);
  const saved = await state(root);
  assert.equal(saved.jobs[planned.plan.tasks[0].key].providerJobId, 'topview-job-1');
  assert.equal(saved.ledger.entries[0].status, 'uncertain');
  const argv = await lines(fake.log);
  assert.ok(argv.some(args => args.includes('status')));
  assert.ok(argv.some(args => args[0] === 'run' && args.includes('--type') && args.includes('t2v') && args.includes('--json')));
});

test('TopView CLI stops before run when logged out', async t => {
  const {root, home} = await fixture(t);
  const fake = await installFake(t, home, 'topview');
  await addPlugin(root, await bundledPlugin('topview'));
  await cliConfig('topview', fake.command);
  process.env.CLI_LOGIN = 'no';
  await settings(root, {execution: 'live', make: [{id: 'shot', with: 'topview', prompt: 'fixture request', seconds: 5, options: {model: 'Standard', max_credits: 9}}], budget: {topview: 9}});
  await plan(root);
  const ui = await page(t, root); await ui.submit('approve', {stage: 'plan'});
  await assert.rejects(make(root), /not logged in/);
  assert.equal((await lines(fake.log)).some(args => args[0] === 'run'), false);
  assert.equal((await state(root)).ledger.entries[0].status, 'uncertain');
});

test('ElevenLabs does not accept a CLI connection', async t => {
  const {root} = await fixture(t);
  await addPlugin(root, await bundledPlugin('elevenlabs'));
  await fs.mkdir(process.env.TSUGITE_HOME, {recursive: true});
  await write(process.env.TSUGITE_HOME, 'config.json', {version: 1, plugins: {elevenlabs: {connection: {enabled: true}}}});
  await settings(root, {execution: 'live', make: [{id: 'voice', with: 'elevenlabs', kind: 'audio', prompt: 'fixture voice', seconds: 3, options: {voice_id: 'fixture', max_credits: 4}}], budget: {elevenlabs: 4}});
  await assert.rejects(plan(root), /no CLI subscription connection/);
});
