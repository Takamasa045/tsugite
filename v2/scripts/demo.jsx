import React from 'react';
import {AbsoluteFill,Composition,registerRoot,useCurrentFrame,interpolate,staticFile} from 'remotion';
import {Video} from '@remotion/media';
const steps=[
  ['01','Start with your own folder','tsugite init my-video','No account. No API key. Local sample footage.'],
  ['02','See the plan before it runs','tsugite plan','Storyboard, timing and each service’s credit limit.'],
  ['03','You approve the plan','Approve plan','The confirmation page records this exact plan.'],
  ['04','Make and check the clips','tsugite make','Review new clips before exporting.'],
  ['05','Export your first video','tsugite export','Watch out/final.mp4, then approve the final.'],
  ['06','Keep what you learned','tsugite note "Shorter opening"','Your preferences become context for the next plan.']
];
function Demo(){const frame=useCurrentFrame(),index=Math.min(5,Math.floor(frame/150)),local=frame%150,step=steps[index],opacity=interpolate(local,[0,10,140,149],[0,1,1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});return <AbsoluteFill style={{background:'#efece2',color:'#163b34',fontFamily:'Arial, sans-serif',padding:56}}>
  <div style={{display:'flex',justifyContent:'space-between',fontSize:24,letterSpacing:1}}><b>継手 / TSUGITE</b><span>V2 ALPHA · FREE LOCAL SAMPLE</span></div>
  <div style={{display:'flex',flex:1,gap:50,alignItems:'center',opacity}}>
    <div style={{flex:1}}><div style={{fontSize:28,color:'#658377'}}>STEP {step[0]} / 06</div><h1 style={{fontSize:66,lineHeight:1.06,margin:'20px 0 32px',letterSpacing:-2}}>{step[1]}</h1><div style={{fontFamily:'monospace',fontSize:29,background:'#163b34',color:'#fff9e9',padding:24,borderRadius:10}}>{step[2]}</div><p style={{fontSize:27,lineHeight:1.4,maxWidth:660}}>{step[3]}</p></div>
    <div style={{width:290,height:490,borderRadius:22,overflow:'hidden',background:'#163b34',position:'relative',boxShadow:'0 20px 60px #163b3430'}}><Video src={staticFile('sample.mp4')} style={{width:'100%',height:'100%',objectFit:'cover'}} muted loop/><div style={{position:'absolute',bottom:18,left:18,right:18,background:'#f8f5e8',borderRadius:12,padding:18,fontSize:21,color:'#163b34'}}><b>{index<3?'Plan check':index<5?'Final preview':'Taste note'}</b><div style={{marginTop:10}}>{index===2?'✓ This plan approved':index===3?'Review the clips':index===4?'Local export complete':index===5?'“Shorter opening”':'Provider credits: 0'}</div></div></div>
  </div><div style={{height:5,background:'#d5ddce'}}><div style={{height:'100%',width:`${(frame+1)/900*100}%`,background:'#b34f2d'}}/></div><div style={{display:'flex',justifyContent:'space-between',fontSize:19,marginTop:18}}><span>Review before execution. Keep your preferences.</span><span>Synthetic sample · illustrative workflow</span></div>
</AbsoluteFill>;}
registerRoot(()=> <Composition id="TsugiteDemo" component={Demo} durationInFrames={900} fps={30} width={1280} height={720}/>);
