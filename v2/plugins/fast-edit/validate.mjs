export const CARDS=['keyword','quote','stat','question','list','steps','comparison','definition','highlight','warning','tip','checklist','timeline','counter','title','lower_third','callout','cta'];
const globals={style:['energetic','minimal','editorial'],color:['source','warm','cool','mono'],caption_style:['bold','outlined','clean'],energy:['high','medium','low'],progress_bar:['bottom','top','none']};
const edits={card:CARDS,text_effect:['none','pop','rise','typewriter'],transition:['cut','fade','zoom','wipe'],face_zoom:['none','medium','close'],sfx:['none','whoosh','pop','chime']};
function fields(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k))||names.some(k=>!Object.hasOwn(value,k)))throw new Error('Invalid Fast Edit fields');}
function id(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value))throw new Error('Invalid Fast Edit identity');}
function range(start,end,total){if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>total+0.001)throw new Error('Invalid Fast Edit time range');}
export function validate(value,total){
  fields(value,['version','global','words','beats']);if(value.version!==1||!Number.isFinite(total)||total<=0||JSON.stringify(value).length>2000000)throw new Error('Invalid Fast Edit version/size');
  fields(value.global,Object.keys(globals));for(const [key,values] of Object.entries(globals))if(!values.includes(value.global[key]))throw new Error('Unsupported Fast Edit global option');
  if(!Array.isArray(value.words)||!value.words.length||value.words.length>10000||!Array.isArray(value.beats)||!value.beats.length||value.beats.length>2000)throw new Error('Invalid Fast Edit item count');
  const words=new Map(),assigned=new Set(),beats=new Set();let lastEnd=0,cursor=0;
  for(const word of value.words){fields(word,['id','text','start','end']);id(word.id);range(word.start,word.end,total);if(words.has(word.id)||word.start<lastEnd-0.001||typeof word.text!=='string'||!word.text.trim()||word.text.length>200)throw new Error('Invalid or overlapping Fast Edit word');words.set(word.id,word);lastEnd=word.end;}
  for(const beat of value.beats){
    fields(beat,['id','start','end','word_ids','edit']);id(beat.id);range(beat.start,beat.end,total);if(beats.has(beat.id)||Math.abs(beat.start-cursor)>0.001||!Array.isArray(beat.word_ids)||beat.word_ids.length>200)throw new Error('Fast Edit beats must be contiguous and unique');beats.add(beat.id);cursor=beat.end;
    fields(beat.edit,[...Object.keys(edits),'visual_needed','emphasis_word_id']);for(const [key,values] of Object.entries(edits))if(!values.includes(beat.edit[key]))throw new Error('Unsupported Fast Edit option');if(typeof beat.edit.visual_needed!=='boolean'||beat.edit.emphasis_word_id!==null&&!beat.word_ids.includes(beat.edit.emphasis_word_id))throw new Error('Invalid Fast Edit emphasis');
    for(const wid of beat.word_ids){const word=words.get(wid);if(!word||assigned.has(wid)||word.start<beat.start-0.001||word.end>beat.end+0.001)throw new Error('Word must belong to exactly one beat');assigned.add(wid);}
  }
  if(assigned.size!==words.size||Math.abs(cursor-total)>0.001)throw new Error('Fast Edit words/beats must cover the timeline');return structuredClone(value);
}
