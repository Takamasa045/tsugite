import { browserSceneSource } from "../fastEditScene.mjs";
import { resolveOutputDimensions } from "../outputDimensions.mjs";
export function fastEditClient(manifest) {
  return `${browserSceneSource(manifest, resolveOutputDimensions(manifest))}
await customElements.whenDefined('ef-timegroup');
const root=document.getElementById('root');
const drawers=new WeakMap();
// Offline export clones the timegroup and copies onFrame (not addFrameTask).
// Resolve nodes within the callback element so the render clone, not the live
// preview or another composition with identical IDs, receives every update.
root.onFrame=({currentTime,element})=>{
 let draw=drawers.get(element);
 if(!draw){draw=createFastEditDom(FAST_MANIFEST,FAST_SIZE,element.querySelector('#fe-overlay'),Array.from(element.querySelectorAll('ef-video')));drawers.set(element,draw);}
 draw(currentTime);
};
root.onFrame({currentTime:0,element:root});`;
}
