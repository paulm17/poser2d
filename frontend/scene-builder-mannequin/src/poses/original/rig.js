import * as THREE from 'three';
import data from './rig.json' with {type:'json'};
import {convertBlenderPose} from './blender-retarget.js';
import {applyExactPose,jointNodes} from './exact-state.js';

export function createOriginalRig(){
 const nodes=data.nodes.map(d=>{const n=new THREE.Object3D();n.position.fromArray(d.position);n.quaternion.fromArray(d.quaternion);n.scale.fromArray(d.scale);return n;});
 data.nodes.forEach((d,i)=>{if(d.parent!==null)nodes[d.parent].add(nodes[i]);});
 const m=nodes[0],joints={};
 for(const [name,d]of Object.entries(data.joints)){const n=nodes[d.node];n.imageWrapper=nodes[d.wrapper];n.yVal=d.yVal;joints[name]=n;}
 for(const [name,n]of Object.entries(joints)){
  const [base,part]=name.split('.');if(part)joints[base][part]=n;else m[name]=n;
 }
 Object.defineProperty(m.body,'turn',{get(){this.rotation.reorder('ZXY');return THREE.MathUtils.radToDeg(this.rotation.y);},set(v){this.rotation.reorder('ZXY');this.rotation.y=THREE.MathUtils.degToRad(v);}});
 m.updateMatrixWorld(true);return m;
}

// Execute the unchanged original conversion on its measured transform hierarchy.
// Gallery and scrub preserve body.position in the original editor.
export function evaluateOriginal(record,reference,scratch=createOriginalRig()){
 const anchor=scratch.body.position.clone(),pose=convertBlenderPose(record,reference,scratch);
 pose.joints.body.position=anchor.toArray();applyExactPose(scratch,pose);return scratch;
}
export {jointNodes};
