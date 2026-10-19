import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { inside, read, write, fileHash, fail } from './files.mjs';
import {migrationExtension,addPlugin,bundledPlugin} from './plugins.mjs';
import {archiveLegacy} from './legacy-archive.mjs';

// Conservative, copy-only migration: v1 production stays authoritative.
export async function migrate(source, destination,{flatten,archive=false}={}) {
  source = await fs.realpath(source);
  const config = parse(await read(source, 'project.yaml'), { maxAliasCount: 0 });
  if(flatten){
    const {probe,command}=await import('../plugins/local/index.mjs'),input=await inside(source,flatten),metadata=await probe(input),digest=await fileHash(source,flatten);
    if(metadata.seconds>3600)fail('Migration source exceeds one-hour project limit');
    let captions=[];
    if(metadata.hasCaptions){const {parseSRT}=await import('./timeline.mjs');const {stdout}=await command('ffmpeg',['-v','error','-protocol_whitelist','file,pipe','-i',input,'-map','0:s:0','-f','srt','-']);captions=parseSRT(stdout);}
    await fs.mkdir(destination,{recursive:false});await fs.mkdir(await inside(destination,'assets'));
    await fs.copyFile(input,await inside(destination,'assets/original-final.mp4'));
    if(await fileHash(destination,'assets/original-final.mp4')!==digest||await fileHash(source,flatten)!==digest)fail('Source changed during flattened migration');
    const format=metadata.width===metadata.height?'1:1':metadata.width>metadata.height?'16:9':'9:16';
    await write(destination,'tsugite.yaml',stringify({version:2,name:config.name||config.slug||'Migrated final',format,length:metadata.seconds,use:[{path:'assets/original-final.mp4',seconds:metadata.seconds,audio:metadata.hasAudio}],captions,export:'local',budget:{}}));
    await write(destination,'.tsugite/migration.json',{version:2,mode:'explicit-final-snapshot',source:flatten,hash:digest,originalPreserved:true,approvalsImported:false,warnings:copyWarnings(config,'local',true)});
    const preserved=archive?await archiveLegacy(source,destination,config.manifest||'manifest.json'):null;
    if(preserved)await write(destination,'.tsugite/legacy-archive.json',preserved);
    return {project:destination,copied:1,flattened:true,sourceUntouched:true,approvalsImported:false,legacyArchive:preserved};
  }
  const manifest = JSON.parse(await read(source, config.manifest || 'manifest.json'));
  if (!Array.isArray(manifest.clips) || !manifest.clips.length) fail('Migration needs local clips');
  if(manifest.native_edit||manifest.images?.length||manifest.speakers?.length||manifest.presentation)fail('Native edits, images, speakers and presentation need explicit conversion');
  if(!['9:16','16:9','1:1'].includes(manifest.meta?.aspect))fail('Migration needs a supported aspect ratio');
  for(const clip of manifest.clips) {
    if(!Number.isFinite(clip.duration)||clip.duration<=0||Object.keys(clip).some(key=>!['id','src','in','out','duration','fps','resolution','audio'].includes(key)))fail('Migration needs explicit durations and no unsupported clip transforms');
  }
  const media = [],use=[],audio=[],captions=[];
  for (const clip of manifest.clips) {
    const src = await inside(source, clip.src);
    const { probe } = await import('../plugins/local/index.mjs');
    const metadata = await probe(src);
    const start=clip.in??0;
    if(!Number.isFinite(start)||start<0||start+clip.duration>metadata.seconds+0.02||clip.out!==undefined&&Math.abs(clip.out-start-clip.duration)>0.02)fail('Migration trim exceeds source or has inconsistent duration');
    if(clip.audio&&!metadata.hasAudio)fail('Requested source audio is absent');
    use.push({path:`assets/clip-${use.length}.mp4`,start,seconds:clip.duration,audio:clip.audio??false});
    media.push({ src, original: clip.src, hash: await fileHash(source, clip.src) });
  }
  const total=manifest.clips.reduce((s,c)=>s+c.duration,0);
  const extension=await migrationExtension(manifest,total);
  for(const [kind,tracks] of Object.entries(manifest.audio??{})){
    if(!['bgm','narration','sfx'].includes(kind)||!Array.isArray(tracks))fail('Unsupported audio group');
    for(const track of tracks){
      if(!track.src||Object.keys(track).some(k=>!['id','src','start','end','volume','offset','loop'].includes(k)))fail('Unsupported audio transform');
      const {probe}=await import('../plugins/local/index.mjs');const src=await inside(source,track.src),metadata=await probe(src,'audio');
      const start=track.start??0,offset=track.offset??0,seconds=(track.end??Math.min(total,start+metadata.seconds-offset))-start;
      if(!Number.isFinite(start)||start<0||!Number.isFinite(seconds)||seconds<=0||start+seconds>total+0.02||offset<0||!track.loop&&offset+seconds>metadata.seconds+0.02)fail('Audio range exceeds migrated timeline');
      const relative=`assets/audio-${audio.length}${path.extname(track.src)||'.wav'}`;
      media.push({src,original:track.src,hash:await fileHash(source,track.src),destination:relative});audio.push({path:relative,start,offset,seconds,volume:track.volume??1,loop:track.loop??false,kind});
    }
  }
  for(const caption of manifest.captions??[]){
    if(caption.visual||caption.pose||caption.speaker||caption.emphasis?.length)fail('Styled/character captions need explicit conversion');
    if(typeof caption.text!=='string'||!caption.text.trim()||!Number.isFinite(caption.start)||!Number.isFinite(caption.end)||caption.start<0||caption.end<=caption.start||caption.end>total+0.02)fail('Invalid migrated caption');
    captions.push({start:caption.start,end:caption.end,text:caption.text});
  }
  await fs.mkdir(destination, { recursive: false });
  await fs.mkdir(await inside(destination, 'assets'));
  for (let i=0; i<media.length; i++) {const file=media[i];file.destination??=`assets/clip-${i}.mp4`;await fs.copyFile(file.src, await inside(destination,file.destination));if(await fileHash(destination,file.destination)!==file.hash||await fileHash(source,file.original)!==file.hash)fail('Source changed during migration copy');}
  await write(destination, 'tsugite.yaml', stringify({ version:2, name:config.name || config.slug || path.basename(source), format:manifest.meta.aspect, length:total,fps:manifest.meta.fps??24,use,audio,captions, export:extension?.plugin??'local',...(extension?{renderer_options:extension.options}:{}),budget:{} }));
  if(extension)await addPlugin(destination,await bundledPlugin(extension.plugin));
  await write(destination, '.tsugite/migration.json', { version:2, copied:media.map(({original,hash,destination}) => ({source:original,destination,hash})), warnings:copyWarnings(config,extension?.plugin??'local',false) });
  const preserved=archive?await archiveLegacy(source,destination,config.manifest||'manifest.json'):null;
  if(preserved)await write(destination,'.tsugite/legacy-archive.json',preserved);
  return { project:destination, copied:media.length, approvalsImported:false, sourceUntouched:true,legacyArchive:preserved };
}

function copyWarnings(config,exportPlugin,flattened){
  const warnings=flattened
    ?['Final media is a bit-identical source snapshot, not an editable v1 effect graph','New rendering uses contain fit and may letterbox; review the new plan and final','No prior approval, provider key or execution state is imported']
    :['v1 approvals, credentials and execution state are never imported','Animated/native/character constructs require explicit conversion'];
  if(typeof config.edit?.backend==='string'&&config.edit.backend!==exportPlugin)warnings.push('v1 edit.backend is not imported as a v2 renderer; copied clips keep local export unless Fast Edit decisions are present');
  if(config.generation||(config.audio&&typeof config.audio==='object'&&(config.audio.adapter||config.audio.connection)))warnings.push('v1 generation adapters, requests and credentials are not imported');
  return warnings;
}
