import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const run=promisify(execFile),repo=fileURLToPath(new URL('../../',import.meta.url)),definition=JSON.parse(await fs.readFile(new URL('../labs/components.json',import.meta.url),'utf8'));
export async function exportLabs(destination){
  const root=path.resolve(destination);await fs.mkdir(root,{recursive:false});
  const {stdout}=await run('git',['ls-tree','-r','--name-only',definition.sourceCommit],{cwd:repo,maxBuffer:4000000}),tracked=stdout.trim().split('\n'),summary=[];
  await fs.copyFile(new URL('../labs/README.md',import.meta.url),path.join(root,'README.md'));
  for(const [id,prefixes] of Object.entries(definition.components)){
    const directory=path.join(root,'packages',id);await fs.mkdir(path.join(directory,'legacy'),{recursive:true});const inventory=[];
    for(const name of tracked.filter(name=>prefixes.some(prefix=>prefix.endsWith('/')?name.startsWith(prefix):name===prefix))){
      if(/(?:^|\/)(?:node_modules|projects|dist|\.git|runtime)(?:\/|$)/.test(name)||name.endsWith('package-lock.json')||!(/\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|yaml|yml|css|html|txt)$/.test(name)))continue;
      if(path.isAbsolute(name)||name.split('/').includes('..'))throw Error('Unsafe tracked source path');
      const {stdout:bytes}=await run('git',['show',definition.sourceCommit+':'+name],{cwd:repo,encoding:'buffer',maxBuffer:2000000});const target=path.join(directory,'legacy',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});inventory.push({path:'legacy/'+name,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    if(!inventory.length)throw Error('No tracked compatibility sources for '+id);
    const unresolved=[],external=new Set(),included=new Set(inventory.map(file=>file.path.slice(7)));
    for(const file of inventory.filter(file=>/\.(?:mjs|cjs|js|jsx|ts|tsx)$/.test(file.path))){const original=file.path.slice(7),text=await fs.readFile(path.join(directory,file.path),'utf8');for(const match of text.matchAll(/\b(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)){const reference=match[1];if(reference.startsWith('.')){const target=path.posix.normalize(path.posix.join(path.posix.dirname(original),reference));if(!included.has(target))unresolved.push({from:original,reference,typescriptSource:included.has(target.replace(/\.js$/,'.ts'))});}else if(!reference.startsWith('node:'))external.add(reference);}}
    const missingPrefixes=prefixes.filter(prefix=>!tracked.some(name=>prefix.endsWith('/')?name.startsWith(prefix):name===prefix));
    const data={version:1,id,sourceCommit:definition.sourceCommit,scope:'v1-compatibility-source; not a v2 renderer/provider',files:inventory,unresolvedRelativeImports:unresolved,externalImports:[...external].sort(),missingPrefixes};await fs.writeFile(path.join(directory,'inventory.json'),JSON.stringify(data,null,2)+'\n');
    await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'tsugite-labs-'+id,version:'2.0.0-alpha.1',private:true,type:'module',license:'MIT',scripts:{test:'node --test test.mjs'},tsugite:{apiVersion:1,id:'labs-'+id,capabilities:['analysis'],network:false,tier:'labs',entry:'index.mjs',mock:'mock.mjs',constraints:'constraints.md'}},null,2)+'\n');
    await fs.writeFile(path.join(directory,'index.mjs'),"import fs from 'node:fs/promises';import {createHash} from 'node:crypto';import inventory from './inventory.json' with {type:'json'};export default {quote:()=>({service:'local',credits:0}),async analyze(){for(const file of inventory.files){const bytes=await fs.readFile(new URL(file.path,import.meta.url));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Compatibility source changed');}return {format:'compatibility-source-inspection',id:inventory.id,sourceCommit:inventory.sourceCommit,files:inventory.files.length,executionSupported:false,applied:false};}};\n");
    await fs.writeFile(path.join(directory,'mock.mjs'),"export {default} from './index.mjs';\n");
    await fs.writeFile(path.join(directory,'test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';import mock from './mock.mjs';test('zero-cost source integrity',async()=>{assert.equal(mock.quote().credits,0);assert.equal((await mock.analyze()).executionSupported,false);});\n");
    await fs.writeFile(path.join(directory,'constraints.md'),'# Experimental compatibility source\n\nThis package advertises local source inspection only. It does not execute its legacy code, create generation tasks, control editors or approve checks. The legacy modules require their original v1 infrastructure and separately installed/selected runtimes. Keep original license notices. Live v2 execution is not implemented or claimed by this snapshot; this is an explicit porting boundary, not a catalog-as-capability promise.\n');
    const {stdout:license}=await run('git',['show',definition.sourceCommit+':LICENSE'],{cwd:repo,maxBuffer:20000});await fs.writeFile(path.join(directory,'LICENSE'),license);summary.push({id,files:inventory.length});
  }
  await fs.writeFile(path.join(root,'export.json'),JSON.stringify({sourceCommit:definition.sourceCommit,originalsPreserved:true,remoteCreated:false,packages:summary},null,2)+'\n');return {directory:root,sourceCommit:definition.sourceCommit,packages:summary};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(process.argv.length!==3)throw Error('Choose one new output directory');console.log(JSON.stringify(await exportLabs(process.argv[2]),null,2));}
