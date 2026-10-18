import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import crossSpawn from 'cross-spawn';
import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';

const root=resolve(import.meta.dirname,'..');
const lock=async folder=>JSON.parse(await readFile(resolve(root,folder,'package-lock.json'),'utf8')).packages;
const versions=(packages,names)=>names.map(name=>packages['node_modules/'+name]?.version);
describe('installed production dependency families',()=>{
  it('keeps all Remotion runtime packages at one exact version',async()=>{
    const selected=versions(await lock('.'),['remotion','@remotion/bundler','@remotion/renderer','@remotion/media']);
    expect(selected.every(Boolean)).toBe(true);expect(new Set(selected).size).toBe(1);
  });
  it('keeps React and React DOM paired in the renderer and local Viewer',async()=>{
    for(const folder of['.','apps/workflow-viewer']){const selected=versions(await lock(folder),['react','react-dom']);expect(selected.every(Boolean)).toBe(true);expect(new Set(selected).size).toBe(1);}
  });
  it('keeps Vitest and its coverage provider paired in both test lanes',async()=>{
    for(const folder of['.','apps/workflow-viewer']){const selected=versions(await lock(folder),['vitest','@vitest/coverage-v8']);expect(selected.every(Boolean)).toBe(true);expect(new Set(selected).size).toBe(1);}
  });
  it('resolves the same pinned YAML from a root-only install and the independent v2 package',async()=>{
    const manifest=JSON.parse(await readFile(resolve(root,'v2/package.json'),'utf8')),packages=await lock('.');
    expect(packages['node_modules/yaml'].version).toBe(manifest.dependencies.yaml);
    const requireFromRoot=createRequire(resolve(root,'package.json'));
    expect(JSON.parse(await readFile(requireFromRoot.resolve('yaml/package.json'),'utf8')).version).toBe(manifest.dependencies.yaml);
  });
  it('runs the independent v2 entry from the repository without an approval operation',()=>{
    const help=crossSpawn.sync('npm',['run','--silent','v2','--','--help'],{cwd:root,encoding:'utf8',timeout:30000});expect(help.status).toBe(0);expect(help.stdout).toContain('confirmation page');
    const rejected=crossSpawn.sync('npm',['run','--silent','v2','--','approve'],{cwd:root,encoding:'utf8',timeout:30000});expect(rejected.status).toBe(1);expect(rejected.stderr).toContain('Unknown');
  });
});
