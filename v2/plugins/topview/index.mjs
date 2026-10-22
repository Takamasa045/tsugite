import definition from './contract.json' with {type: 'json'};
import {createCli} from './cli.mjs';
const OPTION_KEYS = ['model', 'aspect', 'resolution', 'sound', 'max_credits', 'mode'];
const RESOLUTIONS = [480, 540, 720, 768, 1080, 2160];
function media(value) {return typeof value === 'string' ? value : value?.path;}
export function request(task) {
  if (typeof task.prompt !== 'string' || !task.prompt.trim() || !Number.isFinite(task.seconds) || task.seconds <= 0) throw new Error('Invalid source request');
  if ((task.kind ?? 'video') !== definition.kind) throw new Error('Unsupported media kind');
  if (definition.durations && !definition.durations.includes(task.seconds)) throw new Error('Unsupported duration');
  const options = task.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !OPTION_KEYS.includes(key))) throw new Error('Unsupported source options (credentials never belong in a project)');
  if (typeof options.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(options.model)) throw new Error('Choose a TopView model explicitly');
  if (options.max_credits !== undefined && (!Number.isFinite(options.max_credits) || options.max_credits < 0)) throw new Error('Invalid service credit maximum');
  if (options.aspect && !['16:9', '9:16', '1:1'].includes(options.aspect)) throw new Error('Unsupported aspect');
  if (options.resolution !== undefined && !RESOLUTIONS.includes(options.resolution)) throw new Error('Unsupported TopView resolution');
  if (options.sound !== undefined && typeof options.sound !== 'boolean') throw new Error('Invalid sound switch');
  const mode = options.mode ?? 'text';
  if (!['text', 'image'].includes(mode)) throw new Error('Unsupported TopView mode');
  const files = task.inputs ?? [];
  if (mode === 'text' && files.length) throw new Error('Text generation does not take local media inputs');
  if (mode === 'image') {
    if (files.length !== 1) throw new Error('Image-to-video needs exactly one local image input');
    const file = media(files[0]);
    if (typeof file !== 'string' || !file.startsWith('assets/') || file.includes('..') || !/\.(png|jpe?g|webp)$/i.test(file)) throw new Error('Image source must be a local PNG, JPEG or WebP under assets/');
  }
  return {service: definition.id, kind: definition.kind, prompt: task.prompt, seconds: task.seconds, options};
}
export function reconcile(receipt) {
  if (!receipt || typeof receipt.provider_job_id !== 'string' || !['pending', 'completed', 'failed', 'unknown'].includes(receipt.status)) throw new Error('Invalid provider receipt');
  const known = Number.isFinite(receipt.credits_charged) && receipt.credits_charged >= 0;
  return {providerJobId: receipt.provider_job_id, status: receipt.status, actualCredits: known ? receipt.credits_charged : null, releaseReservation: receipt.status === 'failed' && known && receipt.credits_charged === 0};
}
export function normalize(task, {format = '16:9', defaults = {}} = {}) {
  const options = {aspect: format, resolution: 720, mode: 'text', ...defaults, ...task.options};
  const value = {...task, options};
  request(value);
  return value;
}
const implementation = {normalize, quote(task) {request(task);const maximum = task.options?.max_credits;if (!Number.isFinite(maximum) || maximum <= 0) throw new Error('An explicit positive provider credit maximum is required');return {service: 'topview', credits: maximum};}, connect(connection) {if (connection.transport === 'http') throw new Error('TopView v2 uses the subscription CLI, not an HTTP credential');return {...implementation, async make(args) {return createCli({command: connection.command}).make(args);}};}, async make() {throw new Error('Live execution is disabled without an explicit configured connection');}};
export default implementation;
