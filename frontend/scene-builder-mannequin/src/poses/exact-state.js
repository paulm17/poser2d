import { BONE_NAMES, RIG } from '../rig/model.js';
export function jointNodes(m){return m.bones;}
export function isExactPose(state) {
 const finite=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(Number.isFinite);
 return state?.version===1&&state.rig===RIG&&state.joints&&Object.keys(state.joints).length===BONE_NAMES.length&&BONE_NAMES.every(name=>{
  const j=state.joints[name];return j&&finite(j.quaternion,4)&&Math.abs(Math.hypot(...j.quaternion)-1)<0.001&&finite(j.position,3)&&finite(j.scale,3)&&j.scale.every(v=>v>0);
 });
}
export function captureExactPose(m){return {version:1,rig:RIG,joints:Object.fromEntries(Object.entries(m.bones).map(([n,b])=>[n,{quaternion:b.quaternion.toArray(),position:b.position.toArray(),scale:b.scale.toArray()}]))};}
export function applyExactPose(m,state){
 if(!isExactPose(state))throw Error('Invalid MakeHuman pose. Legacy mannequin poses are not supported.');
 for(const [n,j]of Object.entries(state.joints)){const b=m.bones[n];b.quaternion.fromArray(j.quaternion);b.position.fromArray(j.position);b.scale.fromArray(j.scale);}
 m.updateWorldMatrix(true,true);
}
