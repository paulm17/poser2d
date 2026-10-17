import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {parseMorphPack,solveMorph,buildStaticModelData} from '../src/rig/vendor/morph_runtime.mjs';
import {adapter} from '../src/rig/model-adapter.js';
export function modelData(){
 const b=gunzipSync(readFileSync(new URL('../src/rig/vendor/assets/pose_studio_makehuman.v2.bin.gz',import.meta.url)));
 const pack=parseMorphPack(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)),solved=solveMorph(pack,{});
 return adapter.modelDataFromMorphMessage({...solved,staticData:buildStaticModelData(pack,solved.includeGenitals)});
}
