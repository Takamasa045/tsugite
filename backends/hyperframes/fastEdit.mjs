import { browserSceneSource } from "../fastEditScene.mjs";
import { resolveOutputDimensions } from "../outputDimensions.mjs";
export function fastEditRuntime(manifest) {
  return `${browserSceneSource(manifest, resolveOutputDimensions(manifest))}
window.gsap={timeline:()=>{
 const draw=createFastEditDom(FAST_MANIFEST,FAST_SIZE,document.getElementById('fe-overlay'),Array.from(document.querySelectorAll('video')));
 let t=0,scale=1; const duration=FAST_MANIFEST.meta.target_duration_seconds;
 const timeline={seek(v){t=Number(v);draw(t);return timeline;},time(v){return v===undefined?t:timeline.seek(v);},totalTime(v){return timeline.time(v);},duration(){return duration;},totalDuration(){return duration;},pause(){return timeline;},play(){return timeline;},timeScale(v){if(v===undefined)return scale;scale=v;return timeline;},progress(v){return v===undefined?t/duration:timeline.seek(v*duration);},getChildren(){return [];},getTweensOf(){return [];},eventCallback(){return timeline;}};
 draw(0);return timeline;
}};`;
}
export function fastEditHtml(manifest) {
  const size = resolveOutputDimensions(manifest);
  let start = 0;
  const esc = (v) =>
    String(v)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  const clips = manifest.clips
    .map((c, i) => {
      const from = start;
      start += c.duration;
      return `<video id="clip-${i}" src="${esc(c.src)}" data-start="${from}" data-duration="${c.duration}" data-media-start="${c.in}" data-track-index="${i}" muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}#tsugite-render{position:relative;width:${size.width}px;height:${size.height}px;overflow:hidden}#fe-overlay{position:absolute;inset:0;pointer-events:none}video{position:absolute;inset:0}</style><script src="./tsugite-gsap-runtime.js"></script></head><body><div id="tsugite-render" data-composition-id="tsugite-render" data-start="0" data-duration="${start}" data-width="${size.width}" data-height="${size.height}">${clips}<div id="fe-overlay"></div></div><script>window.__timelines={"tsugite-render":gsap.timeline({paused:true})};</script></body></html>`;
}
