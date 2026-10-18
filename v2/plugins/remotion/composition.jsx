import React from 'react';
import {AbsoluteFill,Composition,Sequence,registerRoot,staticFile} from 'remotion';
import {Video,Audio} from '@remotion/media';
function Film({timeline,audioNames}){
  const fps=timeline.fps??24;let cursor=0;
  return <AbsoluteFill style={{backgroundColor:'black'}}>
    {timeline.clips.map((clip,i)=>{const from=Math.round(cursor*fps);cursor+=clip.seconds;return <Sequence key={clip.id} from={from} durationInFrames={Math.max(1,Math.round(cursor*fps)-from)}><Video src={staticFile(`clip-${i}.mp4`)} trimBefore={Math.round((clip.start??0)*fps)} loop={clip.loop??false} muted={!clip.audio} volume={clip.volume??1} style={{width:'100%',height:'100%',objectFit:'contain'}}/></Sequence>;})}
    {(timeline.audio??[]).map((track,i)=><Sequence key={track.id} from={Math.round(track.start*fps)} durationInFrames={Math.max(1,Math.round(track.seconds*fps))}><Audio src={staticFile(audioNames[i])} trimBefore={Math.round((track.offset??0)*fps)} loop={track.loop} volume={track.volume}/></Sequence>)}
    {(timeline.captions??[]).map((caption,i)=><Sequence key={i} from={Math.round(caption.start*fps)} durationInFrames={Math.max(1,Math.round((caption.end-caption.start)*fps))}><AbsoluteFill style={{justifyContent:'flex-end',alignItems:'center',padding:25,fontFamily:'sans-serif',fontSize:28,color:'white',textAlign:'center',whiteSpace:'pre-line',textShadow:'0 1px 4px black'}}>{caption.text}</AbsoluteFill></Sequence>)}
  </AbsoluteFill>;
}
const Root=()=> <Composition id="Tsugite" component={Film} durationInFrames={24} fps={24} width={640} height={360} defaultProps={{timeline:{clips:[],seconds:1,format:'16:9'},audioNames:[]}} calculateMetadata={({props})=>({fps:props.timeline.fps??24,durationInFrames:Math.max(1,Math.round(props.timeline.seconds*(props.timeline.fps??24))),width:props.timeline.format==='9:16'?360:640,height:props.timeline.format==='16:9'?360:640})}/>;
registerRoot(Root);
