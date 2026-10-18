import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { inside, read, write, fileHash, fail } from './files.mjs';

// Conservative, copy-only migration: v1 production stays authoritative.
export async function migrate(source, destination) {
  source = await fs.realpath(source);
  const config = parse(await read(source, 'project.yaml'), { maxAliasCount: 0 });
  const manifest = JSON.parse(await read(source, config.manifest || 'manifest.json'));
  if (!Array.isArray(manifest.clips) || !manifest.clips.length || manifest.clips.some(c => !c.src || (c.in ?? 0) !== 0 || c.audio === true) || manifest.captions?.length || Object.values(manifest.audio || {}).some(a => Array.isArray(a) && a.length)) fail('Migration supports untrimmed, silent local clips only; captions/audio/generation need manual conversion');
  if(!['9:16','16:9','1:1'].includes(manifest.meta?.aspect))fail('Migration needs a supported aspect ratio');
  for(const clip of manifest.clips) {
    if(!Number.isFinite(clip.duration)||clip.duration<=0||Object.keys(clip).some(key=>!['id','src','in','out','duration','fps','resolution','audio'].includes(key)))fail('Migration needs explicit durations and no unsupported clip transforms');
  }
  const media = [];
  for (const clip of manifest.clips) {
    const src = await inside(source, clip.src);
    const { probe } = await import('../plugins/local/index.mjs');
    const metadata = await probe(src);
    if (clip.duration && Math.abs(clip.duration - metadata.seconds) > 0.15) fail('Migration cannot silently discard trims');
    media.push({ src, original: clip.src, hash: await fileHash(source, clip.src) });
  }
  if (new Set(manifest.clips.map(x => x.duration)).size > 1) fail('Unequal clip durations require manual timeline conversion');
  await fs.mkdir(destination, { recursive: false });
  await fs.mkdir(await inside(destination, 'assets'));
  for (let i=0; i<media.length; i++) await fs.copyFile(media[i].src, await inside(destination, `assets/clip-${i}.mp4`));
  await write(destination, 'tsugite.yaml', stringify({ version:2, name:config.name || config.slug || path.basename(source), format:manifest.meta?.aspect || '16:9', length:manifest.clips.reduce((s,c) => s+c.duration,0), use:media.map((_,i)=>`assets/clip-${i}.mp4`), export:'local', budget:{} }));
  await write(destination, '.tsugite/migration.json', { version:1, copied:media.map(({original,hash},i) => ({source:original,destination:`assets/clip-${i}.mp4`,hash})), warnings:['v1 approvals, credentials and execution state are never imported','Renderer changes to local video-only; review the new plan'] });
  return { project:destination, copied:media.length, approvalsImported:false, sourceUntouched:true };
}
