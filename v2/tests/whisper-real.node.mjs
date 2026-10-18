import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './helpers.mjs';
import {addPlugin,bundledPlugin} from '../src/plugins.mjs';
import {analyze} from '../src/analysis.mjs';
import {command} from '../plugins/local/index.mjs';
test('existing local Whisper model transcribes speech without a download',async t=>{
  if(!process.env.TSUGITE_WHISPER||!process.env.TSUGITE_WHISPER_MODEL||!process.env.TSUGITE_WHISPER_SAMPLE)return t.skip('Select an existing binary, model and licensed speech sample explicitly');
  const {root}=await fixture(t);await addPlugin(root,await bundledPlugin('whisper'));
  await command('ffmpeg',['-nostdin','-v','error','-n','-i',process.env.TSUGITE_WHISPER_SAMPLE,'-t','4','-ac','1','-ar','16000',path.join(root,'assets/speech.wav')]);
  const result=await analyze(root,'whisper','assets/speech.wav',{model:process.env.TSUGITE_WHISPER_MODEL,output:'assets/transcript.srt'});
  assert.equal(result.mock,false);assert.match(result.text,/fellow|Americans/i);assert.match(result.engine.modelSha256,/^[a-f0-9]{64}$/);assert.equal(await fs.readFile(path.join(root,'assets/transcript.srt'),'utf8'),result.text);
  if(process.env.TSUGITE_TEST_EVIDENCE){await fs.mkdir(process.env.TSUGITE_TEST_EVIDENCE,{recursive:true});await fs.writeFile(path.join(process.env.TSUGITE_TEST_EVIDENCE,'whisper-real.json'),JSON.stringify(result,null,2));}
});
