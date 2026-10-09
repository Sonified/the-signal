// ImageGen supplies enhanced photographic texture. Mechanical atlas packing
// preserves the original 64 identities, positions, silhouettes and alpha.
// Usage: node tools/pack-botanical-upscale-poc.mjs /path/to/imagegen-source.png
// Requires ImageMagick's `magick` command; does not change production assets.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../assets/kaleidoscope/', import.meta.url));
const originalPath = path.join(root, 'botanical-atlas-meditation-draft.png');
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Pass the generated source PNG path');
function magick(args, input) {
  const p = spawnSync('magick', args, { input, maxBuffer: 64 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(p.stderr.toString());
  return p.stdout;
}
function decode(file) {
  const [width, height] = magick(['identify','-format','%w %h',file]).toString().split(' ').map(Number);
  return { width, height, pixels: magick([file,'-depth','8','rgba:-']) };
}
const original = decode(originalPath), generated = decode(sourcePath);
if (original.width !== 512 || original.height !== 512 || generated.width !== generated.height) throw new Error('Unexpected atlas dimensions');
const size=1536, tile=192;
// Match the production loader's removal of near-transparent matte/speckles.
// Upsample the cleaned source alpha, rather than preserving its faint debris.
const cleanOriginal=Buffer.from(original.pixels);
for(let p=3;p<cleanOriginal.length;p+=4) if(cleanOriginal[p]<40) cleanOriginal[p]=0;
const original3x = magick(['-size','512x512','-depth','8','rgba:-','-filter','Lanczos','-resize',`${size}x${size}!`,'-depth','8','rgba:-'],cleanOriginal);
const output = Buffer.alloc(size*size*4);
function bounds(pixels, width, height, threshold) {
  let x0=width, y0=height, x1=-1, y1=-1;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(pixels[(y*width+x)*4+3]>=threshold) {
    x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y);
  }
  if(x1<0) throw new Error('Empty sprite');
  return { x:x0,y:y0,width:x1-x0+1,height:y1-y0+1 };
}
function crop(image, x,y,width,height) {
  const pixels=Buffer.alloc(width*height*4);
  for(let row=0;row<height;row++) image.pixels.copy(pixels,row*width*4,((y+row)*image.width+x)*4,((y+row)*image.width+x+width)*4);
  return {width,height,pixels};
}
// Keep the main opaque component for measuring the generated body, excluding
// isolated fringe blobs. Dilate its RGB through the rest of the tile, so the
// original alpha can expose a soft edge without sampling a colored matte.
function bodyTexture(image) {
  const {width,height,pixels}=image, count=width*height;
  const seen=new Uint8Array(count), queue=new Int32Array(count);
  let largest=[];
  for(let seed=0;seed<count;seed++) {
    if(seen[seed] || pixels[seed*4+3]<200) continue;
    let head=0,tail=1;queue[0]=seed;seen[seed]=1;
    while(head<tail) {
      const p=queue[head++],x=p%width,y=Math.floor(p/width);
      for(const n of [x>0?p-1:-1,x+1<width?p+1:-1,y>0?p-width:-1,y+1<height?p+width:-1]) {
        if(n<0 || seen[n] || pixels[n*4+3]<200) continue;
        seen[n]=1;queue[tail++]=n;
      }
    }
    if(tail>largest.length) largest=Array.from(queue.subarray(0,tail));
  }
  if(!largest.length) throw new Error('Generated tile has no opaque body');
  const mask=Buffer.alloc(count*4), filled=new Uint8Array(count);
  let head=0,tail=0;
  for(const p of largest) { pixels.copy(mask,p*4,p*4,p*4+3);mask[p*4+3]=255;filled[p]=1;queue[tail++]=p; }
  const box=bounds(mask,width,height,200);
  while(head<tail) {
    const p=queue[head++],x=p%width,y=Math.floor(p/width);
    for(const n of [x>0?p-1:-1,x+1<width?p+1:-1,y>0?p-width:-1,y+1<height?p+width:-1]) {
      if(n<0 || filled[n]) continue;
      mask.copy(mask,n*4,p*4,p*4+3);mask[n*4+3]=255;filled[n]=1;queue[tail++]=n;
    }
  }
  return { image:{width,height,pixels:mask}, box };
}
for(let index=0;index<64;index++) {
  const column=index%8,row=Math.floor(index/8);
  const oldTile=crop(original,column*64,row*64,64,64), oldBox=bounds(oldTile.pixels,64,64,40);
  const gx=Math.round(column*generated.width/8), gy=Math.round(row*generated.height/8);
  const right=Math.round((column+1)*generated.width/8), bottom=Math.round((row+1)*generated.height/8);
  const { image:clean,box }=bodyTexture(crop(generated,gx,gy,right-gx,bottom-gy));
  const body=crop(clean,box.x,box.y,box.width,box.height);
  const w=oldBox.width*3,h=oldBox.height*3;
  const rgb=magick(['-size',`${body.width}x${body.height}`,'-depth','8','rgba:-','-filter','Lanczos','-resize',`${w}x${h}!`,'-depth','8','rgba:-'],body.pixels);
  for(let y=0;y<tile;y++) for(let x=0;x<tile;x++) {
    const destination=((row*tile+y)*size+column*tile+x)*4;
    const alpha=original3x[destination+3];
    if(alpha<8) continue;
    const sx=Math.max(0,Math.min(w-1,x-oldBox.x*3)),sy=Math.max(0,Math.min(h-1,y-oldBox.y*3));
    rgb.copy(output,destination,(sy*w+sx)*4,(sy*w+sx)*4+3);
    output[destination+3]=alpha;
  }
}
const basename='botanical-atlas-meditation-draft-upscaled-3x-poc';
const pngPath=path.join(root,basename+'.png');
magick(['-size',`${size}x${size}`,'-depth','8','rgba:-',pngPath],output);
await mkdir(path.join(root,'botanical-upscale-poc-source'),{recursive:true});
const sourceRelative='botanical-upscale-poc-source/imagegen-texture.png';
if(path.resolve(sourcePath)!==path.join(root,sourceRelative)) await copyFile(sourcePath,path.join(root,sourceRelative));
const manifest=JSON.parse(await readFile(path.join(root,'botanical-atlas-meditation-draft.manifest.json'),'utf8'));
manifest.pack='botanical-atlas-meditation-upscaled-3x-poc';manifest.image=basename+'.png';
manifest.width=manifest.height=size;manifest.tileSize=tile;manifest.padding*=3;
manifest.sha256=createHash('sha256').update(await readFile(pngPath)).digest('hex');
manifest.status='proof-of-concept';manifest.source=sourceRelative;
manifest.method='ImageGen reconstructed textures, per-tile Lanczos packing, original silhouettes with production alpha cutoff resampled 3x';
for(const value of Object.values(manifest)) if(Array.isArray(value)) for(const item of value) {
  if(typeof item?.index==='number') for(const key of ['x','y','width','height']) if(typeof item[key]==='number') item[key]*=3;
}
await writeFile(path.join(root,basename+'.manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({image:pngPath,width:size,height:size,motifs:64,tileSize:tile,alpha:'original silhouettes preserved'},null,2));
