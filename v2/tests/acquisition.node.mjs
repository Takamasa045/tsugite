import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {fixture} from './helpers.mjs';
import {unpack,npmSpec,acquireNpm,addArchive} from '../src/acquire.mjs';
import {plugin} from '../src/plugins.mjs';
function archive(entries){
  const chunks=[];for(const entry of entries){const header=Buffer.alloc(512),data=Buffer.from(entry.text??'');header.write(entry.name,0,100);header.write('0000644\0',100);header.write((entry.size??data.length).toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header[156]=(entry.type??'0').charCodeAt(0);header.write('ustar\0',257);header.write(header.reduce((s,b)=>s+b,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));}chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks));
}
const validEntries=[
  {name:'package/package.json',text:JSON.stringify({name:'fixture-plugin',version:'1.0.0',license:'MIT',type:'module',tsugite:{apiVersion:1,id:'fixture-source',network:false,tier:'community',capabilities:['source'],entry:'index.mjs',mock:'mock.mjs',constraints:'constraints.md'}})},
  {name:'package/index.mjs',text:'export default {quote:()=>({service:"local",credits:0})};'},
  {name:'package/mock.mjs',text:'export {default} from "./index.mjs";'},
  {name:'package/constraints.md',text:'# Fixture only\n'}
];
test('local plugin tarball installs bounded files and registers only the inspected package',async t=>{
  const {root,home}=await fixture(t),file=path.join(home,'plugin.tgz');await fs.writeFile(file,archive(validEntries));await addArchive(root,file);assert.equal((await plugin(root,'fixture-source')).manifest.version,'1.0.0');
});
test('tar traversal, links, duplicate entries, extensions and oversized declarations are rejected',async t=>{
  const {home}=await fixture(t);let i=0;
  for(const entry of [{name:'package/../../escape',text:'no'},{name:'package/drive:file',text:'no'},{name:'package/NUL.txt',text:'no'},{name:'package/file.',text:'no'},{name:'package/link',type:'2'},{name:'package/extended',type:'x'},{name:'package/large',size:17*1024*1024}]){
    const dest=path.join(home,'extract-'+i++);await fs.mkdir(dest);await assert.rejects(unpack(archive([...validEntries,entry]),dest));
  }
  const dest=path.join(home,'duplicate');await fs.mkdir(dest);await assert.rejects(unpack(archive([...validEntries,validEntries[0]]),dest),/Duplicate/);await assert.rejects(fs.access(path.join(home,'escape')));
});
test('registry acquisition requires an exact selected package and ignores lifecycle scripts',async t=>{
  const {root}=await fixture(t);assert.equal(npmSpec('@community/fixture@1.2.3'),'@community/fixture@1.2.3');const spec=npmSpec('fixture-plugin@1.0.0');let called=false;
  await acquireNpm(root,spec,{run:async(program,args,options)=>{
    called=true;assert.ok(args.includes('--ignore-scripts'));assert.equal(options.env.npm_config_ignore_scripts,'true');assert.ok(!options.shell);const dir=args[args.indexOf('--pack-destination')+1];await fs.writeFile(path.join(dir,'fixture.tgz'),archive(validEntries));return {stdout:JSON.stringify([{filename:'fixture.tgz'}])};
  }});assert.equal(called,true);assert.equal((await plugin(root,'fixture-source')).manifest.id,'fixture-source');
  for(const bad of ['name@latest','name','git+ssh://example/plugin','https://example/plugin.tgz','name@file:../x','name@1.0.0;echo nope'])assert.throws(()=>npmSpec(bad));
});
test('hostile npm output cannot choose an archive outside acquisition workspace',async t=>{
  const {root}=await fixture(t);await assert.rejects(acquireNpm(root,'fixture@1.0.0',{run:async()=>({stdout:JSON.stringify([{filename:'../../private.tgz'}])})}),/filename/);
});
test('a registry archive cannot substitute a different package or version',async t=>{
  const {root}=await fixture(t);await assert.rejects(acquireNpm(root,'another-plugin@2.0.0',{run:async(_,args)=>{const directory=args[args.indexOf('--pack-destination')+1];await fs.writeFile(path.join(directory,'fixture.tgz'),archive(validEntries));return {stdout:JSON.stringify([{filename:'fixture.tgz'}])};}}),/package identity/);await assert.rejects(plugin(root,'fixture-source'),/not installed/);
});
