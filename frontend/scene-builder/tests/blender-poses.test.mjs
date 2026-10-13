import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import * as THREE from 'three';
import {BONE_MAP,calibratedWorldRotation} from '../src/poses/blender-retarget.js';
import {jointNodes,captureExactPose,applyExactPose} from '../src/poses/exact-state.js';

test('reference orientation maps exactly to calibrated target, including twist',()=>{
 const source=new THREE.Quaternion().setFromEuler(new THREE.Euler(.4,-.7,1.2));
 const target=new THREE.Quaternion().setFromEuler(new THREE.Euler(-.5,.2,-1));
 assert(calibratedWorldRotation(source.toArray(),source.toArray(),target.toArray()).angleTo(target)<1e-7);
 const twist=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),.8);
 const expected=twist.clone().multiply(target);
 assert(calibratedWorldRotation(twist.clone().multiply(source).toArray(),source.toArray(),target.toArray()).angleTo(expected)<1e-7);
});
function mockMannequin(){
 const m=new THREE.Group();
 for(const name of ['body','pelvis','torso','neck','head','l_arm','l_elbow','l_wrist','r_arm','r_elbow','r_wrist','l_leg','l_knee','l_ankle','r_leg','r_knee','r_ankle']){m[name]=new THREE.Group();m.add(m[name]);}
 for(const side of ['l','r'])for(let i=0;i<5;i++){const node=m[`${side}_finger_${i}`]=new THREE.Group();node.mid=new THREE.Group();node.tip=new THREE.Group();m.add(node);node.add(node.mid);node.mid.add(node.tip);}
 return m;
}
test('exact pose round-trip preserves fingers and joint precision without changing scene transforms',()=>{
 const m=mockMannequin();m.position.set(3,5,-2);m.rotation.set(.2,.5,.3);m.scale.setScalar(.03);
 const scene=[...m.position.toArray(),...m.rotation.toArray(),...m.scale.toArray()];
 let i=0;for(const node of Object.values(jointNodes(m)))node.rotation.set(.1234567+i++/100,.2222222,-.3333333);
 const saved=captureExactPose(m);for(const node of Object.values(jointNodes(m)))node.quaternion.identity();applyExactPose(m,JSON.parse(JSON.stringify(saved)));
 assert.deepEqual(captureExactPose(m),saved);assert.deepEqual([...m.position.toArray(),...m.rotation.toArray(),...m.scale.toArray()],scene);
});
test('invalid exact pose is rejected before any joint changes',()=>{
 const m=mockMannequin(),before=captureExactPose(m),bad=structuredClone(before);bad.joints.body.quaternion=[0,0,.5,.5];bad.joints.head.position=[NaN,0,0];
 assert.throws(()=>applyExactPose(m,bad),/Invalid position/);assert.deepEqual(captureExactPose(m),before);
});
test('254 selected frames have matching thumbnails and complete 3D bone data',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../src/poses/manifest2.json',import.meta.url),'utf8'));
 const frames=JSON.parse(await readFile(new URL('../scripts/pose2-frames.json',import.meta.url),'utf8'));
 assert.equal(manifest.length,254);assert.equal(new Set(manifest.map(e=>e.id)).size,254);assert.equal(manifest.filter(e=>e.library===1).length,120);assert.equal(manifest.filter(e=>e.library===2).length,134);
 for(const entry of manifest){
  assert.equal(entry.frame,frames[entry.id]);assert(entry.frame>=entry.range[0]&&entry.frame<=entry.range[1]);
  const record=JSON.parse(await readFile(new URL('../public/'+entry.data,import.meta.url),'utf8'));
  assert.equal(record.frame,entry.frame);assert.equal(record.action,entry.name);assert.equal(record.library,entry.library);
  assert((await stat(new URL('../public/'+entry.thumbnail,import.meta.url))).size>0);
  for(const name of Object.values(BONE_MAP)){
   const bone=record.bones[name];assert(bone,entry.id+':'+name);
   for(const key of ['position','tail','quaternion'])assert(bone[key].every(Number.isFinite));
   assert(Math.abs(new THREE.Quaternion().fromArray(bone.quaternion).length()-1)<1e-5);
  }
 }
});

test('crawl manual placement includes every integer frame from 0 through 65',async()=>{
 const clip=JSON.parse(await readFile(new URL('../public/poses2/ual1-Crawl_Fwd_Loop-frames.json',import.meta.url),'utf8'));
 assert.equal(clip.fps,30);assert.equal(clip.frames.length,66);
 assert.deepEqual(clip.frames.map(f=>f.frame),Array.from({length:66},(_,i)=>i));
 for(const frame of clip.frames)for(const bone of Object.values(BONE_MAP))assert(frame.bones[bone].quaternion.every(Number.isFinite));
 const selected=JSON.parse(await readFile(new URL('../public/poses2/ual1-Crawl_Fwd_Loop.json',import.meta.url),'utf8'));
 for(const bone of Object.values(BONE_MAP))assert(new THREE.Vector3(...selected.bones[bone].position).distanceTo(new THREE.Vector3(...clip.frames[selected.frame].bones[bone].position))<1e-5);
});

test('all animation previews include a CEF-compatible WebM container',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../src/poses/manifest2.json',import.meta.url),'utf8'));
 for(const entry of manifest){
  const video=await readFile(new URL(`../public/poses2/${entry.id}.webm`,import.meta.url));
  assert(video.length>100,entry.id);
  assert.equal(video.subarray(0,4).toString('hex'),'1a45dfa3',entry.id);
 }
});
