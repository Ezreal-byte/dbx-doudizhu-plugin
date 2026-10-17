import {ImageSource,Texture} from 'pixi.js';
const urls=new Map<string,Promise<string>>();
export function assetUrl(path:string):Promise<string>{
  if(!urls.has(path)) urls.set(path,(async()=>{await window.dbxPlugin?.ready;return window.dbxPlugin?window.dbxPlugin.readAssetUrl(path):`./${path}`;})());
  return urls.get(path)!;
}
export async function imageAsset(path:string):Promise<{image:HTMLImageElement;texture:Texture}>{
  const image=new Image(); image.decoding='async';
  image.src=await assetUrl(path); await image.decode();
  return {image,texture:new Texture({source:new ImageSource({resource:image})})};
}
export async function installFont():Promise<void>{
  try {await window.dbxPlugin?.ready;await Promise.all([['garden-sans.woff2','400'],['garden-sans-bold.woff2','700']].map(async([file,weight])=>{const font=new FontFace('GardenSans',`url(${await assetUrl(`assets/${file}`)})`,{weight});document.fonts.add(await font.load());}));} catch { /* system CJK fonts remain readable if the bundled font fails */ }
}
export async function releaseAssets(){for(const p of urls.values()){const u=await p;if(u.startsWith('blob:'))URL.revokeObjectURL(u);}urls.clear();}
const portraits=new Map<number,Promise<string>>();
export const CHARACTER_COUNT=5;
const originalRows=[0,355/1448,790/1448,1098/1448,1] as const;
const extraRows=[0,377/1536,950/1536,1233/1536,1] as const;
export function characterAtlas(index:number){
  index=Math.max(0,Math.min(CHARACTER_COUNT-1,Math.trunc(index)||0));
  return index<3
    ?{path:'assets/characters.png',columns:3,column:index,rows:originalRows}
    :{path:'assets/characters-extra.png',columns:2,column:index-3,rows:extraRows};
}
export function characterPortrait(index:number):Promise<string>{
  index=Math.max(0,Math.min(CHARACTER_COUNT-1,Math.trunc(index)||0));
  if(!portraits.has(index))portraits.set(index,(async()=>{
    const atlas=characterAtlas(index),image=new Image();image.src=await assetUrl(atlas.path);await image.decode();
    const cv=document.createElement('canvas');cv.width=256;cv.height=256;const ctx=cv.getContext('2d')!;
    // Trim transparent margins so the new, wider atlas cells do not produce
    // smaller portraits. The head keeps its painted aspect ratio.
    const width=Math.round(image.width/atlas.columns),height=Math.round(image.height*atlas.rows[1]);
    const sample=document.createElement('canvas');sample.width=width;sample.height=height;
    const sampleContext=sample.getContext('2d')!;sampleContext.drawImage(image,atlas.column*width,0,width,height,0,0,width,height);
    const pixels=sampleContext.getImageData(0,0,width,height).data;
    let left=width,top=height,right=0,bottom=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4+3]!>90){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
    const headWidth=right-left+1,headHeight=bottom-top+1,scale=Math.min(238/headWidth,238/headHeight);
    ctx.drawImage(sample,left,top,headWidth,headHeight,(256-headWidth*scale)/2,(256-headHeight*scale)/2,headWidth*scale,headHeight*scale);
    return cv.toDataURL('image/png');
  })());
  return portraits.get(index)!;
}
