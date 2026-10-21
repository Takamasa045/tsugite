import path from 'node:path';
export function publicClipName(index,file){
  const ext=path.extname(file).toLowerCase();
  return `clip-${index}${ext||'.mp4'}`;
}
export function isStillClip(name){
  return /\.(png|jpe?g|webp)$/i.test(name);
}
