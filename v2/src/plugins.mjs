import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJSON, read, write, inside, treeHash, fail } from './files.mjs';
const builtin = fileURLToPath(new URL('../plugins/local/', import.meta.url));
export async function bundledPlugin(id){pluginID(id);const directory=fileURLToPath(new URL(`../plugins/${id}/`,import.meta.url));try{await fs.access(path.join(directory,'package.json'));return directory;}catch{return null;}}
export const pluginID = value => { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('Invalid plugin id'); return value; };
export async function inspectPlugin(directory) {
  const pkg = await readJSON(directory, 'package.json'), m = pkg.tsugite;
  if (!m || m.apiVersion !== 1 || !pkg.name || !pkg.version || !pkg.license) fail('Plugin requires package metadata and tsugite API v1');
  pluginID(m.id);
  if (!Array.isArray(m.capabilities) || !m.capabilities.length || m.capabilities.some(x => !['source','renderer','analysis'].includes(x))) fail('Invalid plugin capabilities');
  if(m.mediaKinds&&(!Array.isArray(m.mediaKinds)||!m.mediaKinds.length||m.mediaKinds.some(kind=>!['video','audio'].includes(kind))))fail('Invalid plugin media kinds');
  if (typeof m.network !== 'boolean' || !['community','labs'].includes(m.tier)) fail('Plugin must declare network and community/labs tier');
  for (const key of ['entry','mock','constraints']) { if (!m[key]) fail('Plugin missing ' + key); await read(directory, m[key]); }
  return { ...m, package: pkg.name, version: pkg.version, license: pkg.license, digest: await treeHash(directory) };
}
export async function plugin(root, id, execute = false,{mode='offline'} = {}) {
  pluginID(id);
  const registry = await readJSON(root, '.tsugite/plugins.json', {});
  const directory = id === 'local' ? builtin : await inside(root, `.tsugite/plugins/${id}`);
  if (id !== 'local' && !Object.hasOwn(registry,id)) fail('Plugin not installed: ' + id);
  const manifest = await inspectPlugin(directory);
  if (manifest.id !== id || (id !== 'local' && registry[id] !== manifest.digest)) fail('Plugin changed; reinstall and replan');
  // alpha deliberately has no live provider path. Manifests do not sandbox code.
  if (manifest.network && mode!=='mock' && execute) fail('Network plugins are disabled in this offline alpha');
  if (!execute) return { manifest };
  const module = await import(pathToFileURL(await inside(directory, mode==='mock'?manifest.mock:manifest.entry)).href + '?v=' + manifest.digest);
  const implementation = module.default;
  if (!implementation || typeof implementation.quote !== 'function') fail('Plugin missing quote');
  return { manifest, implementation };
}
export async function addPlugin(root, source) {
  const directory = await fs.realpath(source), manifest = await inspectPlugin(directory);
  if (manifest.id === 'local') fail('Built-in local plugin cannot be replaced');
  const destination = await inside(root, `.tsugite/plugins/${manifest.id}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(directory, destination, { recursive: true, force: false, errorOnExist: true, filter: p => !['node_modules','.git'].includes(path.basename(p)) });
  const registry = await readJSON(root, '.tsugite/plugins.json', {});
  registry[manifest.id] = (await inspectPlugin(destination)).digest;
  await write(root, '.tsugite/plugins.json', registry);
  return manifest;
}
export async function newPlugin(destination, id) {
  pluginID(id);
  await fs.mkdir(destination, { recursive: false });
  const tsugite = { apiVersion: 1, id, capabilities: ['source'], network: false, tier: 'community', entry: 'index.mjs', mock: 'mock.mjs', constraints: 'constraints.md' };
  await write(destination, 'package.json', { name: `tsugite-plugin-${id}`, version: '0.1.0', type: 'module', license: 'MIT', scripts: { test: 'node --test test.mjs' }, tsugite });
  await write(destination, 'constraints.md', '# Constraints\n\nOffline copy scaffold. Requires a local input clip; requested duration must match that clip. Both real and mock entries copy the sample into the assigned output without keys or network. Replace this fixture implementation before claiming generation support.\n');
  const copySource = `import { copyFile } from 'node:fs/promises';\nexport default { quote: () => ({service: '${id}', credits: 0}), make: async ({output, sample}) => { if (!sample) throw new Error('Copy scaffold requires a local sample input'); await copyFile(sample, output); return {credits: 0}; } };\n`;
  await write(destination, 'index.mjs', copySource);
  await write(destination, 'mock.mjs', copySource);
  await write(destination, 'test.mjs', `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs/promises';\nimport os from 'node:os';\nimport path from 'node:path';\nimport mock from './mock.mjs';\ntest('offline output contract', async t => {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tsugite-plugin-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const sample=path.join(dir,'sample'),output=path.join(dir,'output');await fs.writeFile(sample,'fixture bytes');assert.equal(mock.quote().credits, 0);assert.equal((await mock.make({sample,output})).credits, 0);assert.equal(await fs.readFile(output,'utf8'),'fixture bytes');await assert.rejects(mock.make({output}),/local sample/);});\n`);
  return { directory: destination, id };
}
