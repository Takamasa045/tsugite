import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './helpers.mjs';
import {write,readJSON,fileHash} from '../src/files.mjs';
import {migrate} from '../src/migrate.mjs';
test('complex legacy data can be preserved beside an explicit final copy without credentials or approval',async t=>{
  const {root,home}=await fixture(t),destination=path.join(home,'preserved'),before=await fileHash(root,'assets/intro.mp4');await write(root,'project.yaml','name: Legacy graph\nmanifest: manifest.json\n');await write(root,'manifest.json',{meta:{aspect:'9:16'},clips:[{src:'assets/intro.mp4'}],native_edit:{payload:{layers:[{src:'assets/intro.mp4',kind:'video'}]}},api_key:'never-copy-this',approvals:{plan:'not-valid'}});
  const result=await migrate(root,destination,{flatten:'assets/intro.mp4',archive:true}),archive=await readJSON(destination,result.legacyArchive.path);assert.equal(archive.executionSupported,false);assert.equal(archive.approvalsImported,false);assert.equal(archive.files.length,1);assert.ok(!JSON.stringify(archive).includes('never-copy-this'));assert.equal(archive.manifest.native_edit.payload.layers[0].src,archive.files[0].path);assert.equal(await fileHash(destination,archive.files[0].path),before);assert.equal(await fileHash(root,'assets/intro.mp4'),before);
});
test('legacy archives reject symlinks, traversal and remote source references',async t=>{
  const {root,home}=await fixture(t);await write(root,'project.yaml','name: Unsafe graph\nmanifest: manifest.json\n');await fs.symlink(path.join(root,'assets/intro.mp4'),path.join(root,'assets/link.mp4'));
  for(const [i,src] of ['../outside.mp4','https://example.invalid/a.mp4','assets/link.mp4'].entries()){await write(root,'manifest.json',{native_edit:{assets:[{src}]}});await assert.rejects(migrate(root,path.join(home,'bad-'+i),{flatten:'assets/intro.mp4',archive:true}));}
});
test('character snapshots retain their lock and relative files, and reject an altered identity',async t=>{
  const {root,home}=await fixture(t);await write(root,'project.yaml','name: Character archive\nmanifest: manifest.json\n');await write(root,'assets/person/prompt.txt','synthetic character prompt');const hash=await fileHash(root,'assets/person/prompt.txt');await write(root,'assets/person/character-lock.json',{schema_version:1,source:{kind:'shitate'},files:[{role:'prompt',path:'prompt.txt',sha256:hash}]});await write(root,'manifest.json',{speakers:[{id:'fixture',source:{kind:'shitate',lockPath:'assets/person/character-lock.json'}}]});
  const destination=path.join(home,'character-copy');await migrate(root,destination,{flatten:'assets/intro.mp4',archive:true});const archive=await readJSON(destination,'assets/legacy-v1/archive.json'),lock=archive.manifest.speakers[0].source.lockPath;assert.equal((await readJSON(destination,lock)).files[0].sha256,hash);assert.equal(await fileHash(destination,path.posix.dirname(lock)+'/prompt.txt'),hash);
  await write(root,'assets/person/prompt.txt','changed');await assert.rejects(migrate(root,path.join(home,'altered'),{flatten:'assets/intro.mp4',archive:true}),/snapshot hash/);
});
test('archives preserve prototype-named JSON data and reject credentials in referenced JSON',async t=>{
  const {root,home}=await fixture(t);await write(root,'project.yaml','name: JSON archive\nmanifest: manifest.json\n');await write(root,'manifest.json','{"__proto__":{"label":"ordinary data"}}');const destination=path.join(home,'json-copy');await migrate(root,destination,{flatten:'assets/intro.mp4',archive:true});const archive=await readJSON(destination,'assets/legacy-v1/archive.json');assert.equal(Object.hasOwn(archive.manifest,'__proto__'),true);assert.equal(archive.manifest.__proto__.label,'ordinary data');
  await write(root,'assets/private.json',{api_key:'fixture-do-not-copy'});await write(root,'manifest.json',{native_edit:{assets:[{src:'assets/private.json'}]}});await assert.rejects(migrate(root,path.join(home,'private-copy'),{flatten:'assets/intro.mp4',archive:true}),e=>/Credential fields/.test(e.message)&&!e.message.includes('fixture-do-not-copy'));
});
test('legacy archives omit nested credential aliases and reject aliases in referenced JSON without exposing values',async t=>{
  const {root,home}=await fixture(t);await write(root,'project.yaml','name: Credential alias fixture\nmanifest: manifest.json\n');
  const names=['access_token','refresh_token','client_secret','aws_access_key_id','aws_secret_access_key','sessionToken','Authorization','private-key','apiKey','password_hash','credentials','oauth_client_secret','AWSAccessKeyId','myAccessToken','x-api-key'];
  const secrets=Object.fromEntries(names.map((name,i)=>[name,'DUMMY-ARCHIVE-SECRET-'+i]));await write(root,'manifest.json',{native_edit:{nested:[secrets]},safe:{token_count:4,secretary:'editor'}});
  const destination=path.join(home,'alias-copy');await migrate(root,destination,{flatten:'assets/intro.mp4',archive:true});const serialized=await fs.readFile(path.join(destination,'assets/legacy-v1/archive.json'),'utf8');for(const value of Object.values(secrets))assert.ok(!serialized.includes(value),'Dummy credential value must be omitted');assert.equal(JSON.parse(serialized).manifest.safe.secretary,'editor');
  for(const [i,name]of names.entries()){await write(root,'assets/private.json',{nested:[{[name]:'DUMMY-REFERENCED-SECRET'}]});await write(root,'manifest.json',{native_edit:{src:'assets/private.json'}});const failed=path.join(home,'alias-rejected-'+i);await assert.rejects(migrate(root,failed,{flatten:'assets/intro.mp4',archive:true}),e=>/Credential fields/.test(e.message)&&!e.message.includes('DUMMY-REFERENCED-SECRET'));await assert.rejects(fs.access(path.join(failed,'assets/legacy-v1/archive.json')));}
});
