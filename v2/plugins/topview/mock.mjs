import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request} from './index.mjs';
import definition from './contract.json' with {type: 'json'};
export default {quote(task){request(task);return {service: definition.id, credits: 0, mock: true};}, async make({task, output}) {request(task);await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', String(task.seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', output], {timeout: 120000, windowsHide: true});return {credits: 0, mock: true};}};
