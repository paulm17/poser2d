// Run the installed, unchanged Male and original converter without a renderer.
// Only the scene bootstrap and texture loading are replaced; rig construction,
// geometry, joint methods, calibration and pose conversion execute unmodified.
import { registerHooks } from 'node:module';
import * as THREE from 'three';
export async function createOriginalOracle(){
 const hook=registerHooks({load(url,context,next){
  if(url.endsWith('/mannequin-js/src/scene.js'))return {format:'module',shortCircuit:true,source:"import * as THREE from 'three'; export const scene=new THREE.Scene();"};
  return next(url,context);
 }});
 const load=THREE.TextureLoader.prototype.load;THREE.TextureLoader.prototype.load=function(){return new THREE.Texture();};
 let Male;
 try{({Male}=await import('../../node_modules/mannequin-js/src/bodies/Male.js'));}finally{THREE.TextureLoader.prototype.load=load;hook.deregister();}
 const {convertBlenderPose,BONE_MAP}=await import('../../scene-builder/src/poses/blender-retarget.js');
 const {jointNodes,applyExactPose,captureExactPose}=await import('../../scene-builder/src/poses/exact-state.js');
 const model=new Male(),scratch=new Male();model.position.set(0,.25,0);
 const initial=captureExactPose(model);
 function evaluate(record,reference){
  const result=convertBlenderPose(record,reference,scratch);
  result.joints.body.position=[...initial.joints.body.position];
  applyExactPose(model,result);return model;
 }
 return {model,scratch,evaluate,jointNodes,captureExactPose,BONE_MAP};
}
