import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function command(program, args) {
  return exec(program, args, { timeout: 120000, maxBuffer: 2e6, windowsHide: true });
}
export async function probe(file) {
  const { stdout } = await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts', '-show_format', '-show_streams', '-of', 'json', file]);
  const data = JSON.parse(stdout), video = data.streams.find(x => x.codec_type === 'video');
  if (!video || !Number.isFinite(Number(data.format.duration)) || Number(data.format.duration) <= 0) throw new Error('Input must contain finite video');
  return { seconds: Number(data.format.duration), width: video.width, height: video.height };
}
export async function sample(file, seconds = 3) {
  await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', file]);
}
export default {
  quote: () => ({ service: 'local', credits: 0 }),
  make: async ({ output, task }) => { await sample(output, task.seconds); return { credits: 0 }; },
  render: async ({ timeline, inputs, output, scratch }) => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const width = timeline.format === '9:16' ? 360 : timeline.format === '1:1' ? 640 : 640;
    const height = timeline.format === '9:16' ? 640 : timeline.format === '1:1' ? 640 : 360;
    const clips = [];
    for (let i = 0; i < inputs.length; i++) {
      const file = join(scratch, `cut-${i}.mp4`);
      await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts', '-stream_loop', '-1', '-i', inputs[i], '-t', String(timeline.clips[i].seconds), '-an', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', file]);
      clips.push(`file 'cut-${i}.mp4'`);
    }
    const list = join(scratch, 'list.txt');
    await writeFile(list, clips.join('\n'));
    await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', list, '-c', 'copy', '-movflags', '+faststart', output]);
    return { credits: 0 };
  }
};
