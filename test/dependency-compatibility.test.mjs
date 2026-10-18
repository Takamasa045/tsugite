import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
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
  it('keeps the independently installable v2 Remotion peers aligned with the repository runtime',async()=>{
    const installed=await lock('.');
    for(const id of ['remotion','fast-edit']){
      const plugin=JSON.parse(await readFile(resolve(root,'v2/plugins/'+id+'/package.json'),'utf8'));
      for(const [name,version] of Object.entries(plugin.peerDependencies))expect(installed['node_modules/'+name]?.version,name).toBe(version);
    }
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
  it('keeps repository test discovery outside nested worktree copies',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'tsugite-test-discovery-'));
    try{
      for(const file of['test/main.test.mjs','.work/copy/test/extra.test.mjs','.claude/worktrees/copy/test/extra.test.mjs','projects/.worktree-archives/copy/test/extra.test.mjs']){await mkdir(resolve(directory,file,'..'),{recursive:true});await writeFile(join(directory,file),'');}
      const manifest=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
      for(const script of['test','test:coverage']){
        const exclude=[...manifest.scripts[script].matchAll(/--exclude="([^"]+)"/g)].map(m=>'--exclude='+m[1]);
        const result=crossSpawn.sync(process.execPath,[resolve(root,'node_modules/vitest/vitest.mjs'),'list','--filesOnly','--json','--root',directory,...exclude],{encoding:'utf8',timeout:10000});
        expect(result.status).toBe(0);expect(JSON.parse(result.stdout).map(x=>basename(x.file))).toEqual(['main.test.mjs']);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  },15000);
});
