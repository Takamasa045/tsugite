import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function command(program, args, options = {}) {
  const executable=program==='ffmpeg'?(process.env.TSUGITE_FFMPEG||program):program==='ffprobe'?(process.env.TSUGITE_FFPROBE||program):program;
  return exec(executable, args, { timeout: 120000, maxBuffer: 2e6, windowsHide: true,...options });
}
export function isStillImage(file){return /\.(png|jpe?g|webp)$/i.test(file);}
export async function probe(file,kind='video') {
  if(kind==='image'||(kind==='video'&&isStillImage(file))){
    const {stdout}=await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file]);
    const video=JSON.parse(stdout).streams?.find(x=>x.width&&x.height);
    if(!video)throw new Error('Input must contain a still image');
    return {seconds:0,width:video.width,height:video.height,hasAudio:false,hasCaptions:false,still:true};
  }
  const { stdout } = await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,wav,mp3,flac,ogg', '-show_format', '-show_streams', '-of', 'json', file]);
  const data = JSON.parse(stdout), video = data.streams.find(x => x.codec_type === 'video');
  const audio=data.streams.find(x=>x.codec_type==='audio');
  if ((kind==='video'?!video:!audio) || !Number.isFinite(Number(data.format.duration)) || Number(data.format.duration) <= 0) throw new Error('Input must contain finite '+kind);
  return { seconds: Number(data.format.duration), width: video?.width??0, height: video?.height??0,hasAudio:!!audio,hasCaptions:data.streams.some(x=>x.codec_type==='subtitle') };
}
export async function sample(file, seconds = 3) {
  await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', file]);
}
export default {
  quote: () => ({ service: 'local', credits: 0 }),
  supportsStills: true,
  make: async ({ output, task }) => { await sample(output, task.seconds); return { credits: 0 }; },
  analyze:probe,
  validate:async timeline=>{if(timeline.captions?.length&&timeline.captionMode==='burn'){const {stdout}=await command('ffmpeg',['-hide_banner','-filters']);if(!/\bsubtitles\s/.test(stdout))throw new Error('Caption burn-in requires FFmpeg with libass; configure TSUGITE_FFMPEG before planning');}},
  render: async ({ timeline, inputs, audio=[],output, scratch }) => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const width = timeline.format === '9:16' ? 360 : timeline.format === '1:1' ? 640 : 640;
    const height = timeline.format === '9:16' ? 640 : timeline.format === '1:1' ? 640 : 360;
    const clips = [];
    for (let i = 0; i < inputs.length; i++) {
      const file = join(scratch, `cut-${i}.mp4`);
      const clip=timeline.clips[i];
      const still=clip.still===true||isStillImage(inputs[i]);
      const source=still?['-protocol_whitelist','file,pipe','-loop','1','-i',inputs[i]]:['-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts', ...(clip.loop?['-stream_loop','-1']:[]),'-ss',String(clip.start??0),'-i', inputs[i]];
      await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', ...source,'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-map','0:v:0','-map',clip.audio?'0:a:0':'1:a:0', '-t', String(clip.seconds),'-af',`volume=${clip.volume??1}`,'-c:a','aac','-ar','48000','-ac','2', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, '-r',String(timeline.fps??24), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', file]);
      clips.push(`file 'cut-${i}.mp4'`);
    }
    const list = join(scratch, 'list.txt');
    await writeFile(list, clips.join('\n'));
    const base=join(scratch,'base.mp4');
    await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', list, '-c', 'copy',base]);
    const args=['-nostdin','-v','error','-n','-i',base],filters=[];
    for(let i=0;i<audio.length;i++){
      const track=timeline.audio[i];
      args.push('-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,wav,mp3,flac,ogg',...(track.loop?['-stream_loop','-1']:[]),'-ss',String(track.offset??0),'-i',audio[i]);
      filters.push(`[${i+1}:a]atrim=duration=${track.seconds},asetpts=PTS-STARTPTS,volume=${track.volume},adelay=${Math.round(track.start*1000)}:all=1[a${i}]`);
    }
    const subtitles=timeline.captions??[];
    if(subtitles.length&&timeline.captionMode!=='burn'){
      const stamp=s=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
      await writeFile(join(scratch,'captions.srt'),subtitles.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));
      args.push('-protocol_whitelist','file,pipe','-f','srt','-i',join(scratch,'captions.srt'));
    }
    if(audio.length){filters.push(`[0:a]${audio.map((_,i)=>`[a${i}]`).join('')}amix=inputs=${audio.length+1}:duration=first:normalize=0,alimiter=limit=0.95[mix]`);args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[mix]');}
    else args.push('-map','0:v:0','-map','0:a:0');
    if(subtitles.length&&timeline.captionMode!=='burn')args.push('-map',`${audio.length+1}:0`,'-c:s','mov_text','-disposition:s:0','default');
    if(subtitles.length&&timeline.captionMode==='burn'){
      const time=s=>{const cs=Math.round(s*100);return `${Math.floor(cs/360000)}:${String(Math.floor(cs/6000)%60).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;};
      const safe=text=>text.replace(/\\/g,'＼').replace(/{/g,'｛').replace(/}/g,'｝').replace(/\r/g,'').replace(/\n/g,'\\N');
      const content=`[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${Math.round(height/20)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,16,16,25,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`+subtitles.map(c=>`Dialogue: 0,${time(c.start)},${time(c.end)},Default,,0,0,0,,${safe(c.text)}`).join('\n');
      await writeFile(join(scratch,'captions.ass'),content);
      args.push('-vf','subtitles=filename=captions.ass','-c:v','libx264','-threads','2');
    }else args.push('-c:v','copy');
    args.push('-c:a','aac','-t',String(timeline.seconds),'-movflags','+faststart',output);
    await command('ffmpeg',args,{cwd:scratch});
    return { credits: 0 };
  }
};
