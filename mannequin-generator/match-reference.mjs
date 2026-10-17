import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from './upstream/web/vendor/three/three.module.js';
import {parseMorphPack,solveMorph} from './upstream/web/pose_studio/morph_runtime.mjs';
const bytes=zlib.gunzipSync(fs.readFileSync(new URL('./upstream/web/pose_studio/assets/pose_studio_makehuman.v2.bin.gz',import.meta.url)));
const pack=parseMorphPack(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const model=solveMorph(pack,{});
const directions={pelvis:[.32,.92,-.22],spine_01:[.32,.92,-.22],spine_02:[.32,.92,-.22],spine_03:[.32,.92,-.22],neck_01:[-.05,1,.05],head:[-.08,1,.05],thigh_l:[-.85,.9,.2],thigh_r:[-.60,.76,.25],calf_l:[-.30,-1,.15],calf_r:[.02,-1,.15],foot_l:[-.65,-.25,.6],foot_r:[-.65,-.25,.6],upperarm_r:[-.6,.9,0],lowerarm_r:[1,.3,.05],hand_r:[1,.12,.15],upperarm_l:[-.08,-1,.12],lowerarm_l:[-.9,.45,.3],hand_l:[-1,.05,.1]};
const global=new Map(), bones={};
for(let i=0;i<pack.bones.length;i++){
 const b=pack.bones[i], parent=global.get(b.parent)||new THREE.Quaternion();
 let q=parent.clone();
 if(directions[b.name]){
  const a=new THREE.Vector3(...model.bonePositions.slice(i*6,i*6+3));const t=new THREE.Vector3(...model.bonePositions.slice(i*6+3,i*6+6));
  q=new THREE.Quaternion().setFromUnitVectors(t.sub(a).normalize(),new THREE.Vector3(...directions[b.name]).normalize());
 }
 global.set(b.name,q);const local=parent.clone().invert().multiply(q);const e=new THREE.Euler().setFromQuaternion(local);bones[b.name]=[e.x,e.y,e.z].map(v=>v*180/Math.PI);
}
const pose={bones,modelRotation:[0,0,0],camera:{posX:0,posY:1,posZ:19,targetX:-.6,targetY:1,targetZ:0}};
fs.writeFileSync(new URL('../reclining-pose.json',import.meta.url),JSON.stringify(pose,null,2));
