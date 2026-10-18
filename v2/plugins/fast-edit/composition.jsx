import React from 'react';
import {AbsoluteFill,Composition,Sequence,registerRoot,staticFile,useCurrentFrame} from 'remotion';
import {Video,Audio} from '@remotion/media';
import {sampleFastEdit} from './scene.mjs';
function Film({timeline,audioNames}){
  const size={width:timeline.format==='9:16'?360:640,height:timeline.format==='16:9'?360:640},scene=sampleFastEdit({fast_edit:timeline.rendererOptions,meta:{target_duration_seconds:timeline.seconds}},useCurrentFrame()/(timeline.fps??24),size);
  const node=n=>React.createElement(n.style.display==='inline'?'span':'div',{key:n.id,id:n.id,style:n.style},n.text,...n.children.map(node));
  const fps=timeline.fps??24;let cursor=0;
  return <AbsoluteFill style={{backgroundColor:'black'}}>
    {timeline.clips.map((clip,i)=>{const from=Math.round(cursor*fps);cursor+=clip.seconds;return <Sequence key={clip.id} from={from} durationInFrames={Math.max(1,Math.round(cursor*fps)-from)}><Video src={staticFile(`clip-${i}.mp4`)} trimBefore={Math.round((clip.start??0)*fps)} loop={clip.loop??false} muted={!clip.audio} volume={clip.volume??1} style={scene.video}/></Sequence>;})}
    {(timeline.audio??[]).map((track,i)=><Sequence key={track.id} from={Math.round(track.start*fps)} durationInFrames={Math.max(1,Math.round(track.seconds*fps))}><Audio src={staticFile(audioNames[i])} trimBefore={Math.round((track.offset??0)*fps)} loop={track.loop} volume={track.volume}/></Sequence>)}
    {scene.layers.map(node)}
    {(timeline.captions??[]).map((caption,i)=><Sequence key={i} from={Math.round(caption.start*fps)} durationInFrames={Math.max(1,Math.round((caption.end-caption.start)*fps))}><AbsoluteFill style={{justifyContent:'flex-end',alignItems:'center',padding:25,fontFamily:'sans-serif',fontSize:28,color:'white',textAlign:'center',whiteSpace:'pre-line',textShadow:'0 1px 4px black'}}>{caption.text}</AbsoluteFill></Sequence>)}
  </AbsoluteFill>;
}
const Root=()=> <Composition id="Tsugite" component={Film} durationInFrames={24} fps={24} width={640} height={360} defaultProps={{timeline:{clips:[],seconds:1,format:'16:9'},audioNames:[]}} calculateMetadata={({props})=>({fps:props.timeline.fps??24,durationInFrames:Math.max(1,Math.round(props.timeline.seconds*(props.timeline.fps??24))),width:props.timeline.format==='9:16'?360:640,height:props.timeline.format==='16:9'?360:640})}/>;
registerRoot(Root);
