import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {createOriginalOracle} from './original-oracle.mjs';
import {modelData} from './model-data.mjs';
import {createRigFromData} from '../src/rig/model.js';
const o=await createOriginalOracle(),m=o.model,joints=o.jointNodes(m),included=new Set([m]);
for(const n of Object.values(joints)){
 included.add(n.imageWrapper);let p=n;while(p&&p!==m){included.add(p);p=p.parent;}
}
const nodes=[...included],index=n=>nodes.indexOf(n);
const snapshot={version:1,provenance:{},nodes:nodes.map(n=>({parent:n===m?null:index(n.parent),position:n.position.toArray(),quaternion:n.quaternion.toArray(),scale:n.scale.toArray()})),joints:Object.fromEntries(Object.entries(joints).map(([k,n])=>[k,{node:index(n),wrapper:index(n.imageWrapper),yVal:n.yVal}]))};
for(const p of ['src/poses/blender-retarget.js','src/poses/exact-state.js'])snapshot.provenance[p]=createHash('sha256').update(readFileSync(new URL('../../scene-builder/'+p,import.meta.url))).digest('hex');
const target=createRigFromData(modelData(),{mesh:false}),rest=target.userData.restWorld;
const normalize=n=>n==='Head'?'head':n;
const children={torso:'neck',neck:'head',l_arm:'l_elbow',l_elbow:'l_wrist',r_arm:'r_elbow',r_elbow:'r_wrist',l_leg:'l_knee',l_knee:'l_ankle',r_leg:'r_knee',r_knee:'r_ankle'};
for(const side of ['l','r'])for(let i=0;i<5;i++){children[`${side}_finger_${i}`]=`${side}_finger_${i}.mid`;children[`${side}_finger_${i}.mid`]=`${side}_finger_${i}.tip`;}
const map={version:1,mapped:{},extras:{Root:{mode:'rest'},spine_01:{mode:'rest'},spine_02:{mode:'rest'},clavicle_l:{mode:'rest'},clavicle_r:{mode:'rest'},ball_l:{mode:'rest'},ball_r:{mode:'rest'}}};
const pos=n=>n.getWorldPosition(new T.Vector3()),quat=n=>n.getWorldQuaternion(new T.Quaternion()),v=a=>new T.Vector3().fromArray(a),q=a=>new T.Quaternion().fromArray(a);
function basis(y,x){y.normalize();x.addScaledVector(y,-x.dot(y)).normalize();return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,new T.Vector3().crossVectors(x,y).normalize()));}
// Fixed anatomical coordinate changes: each source physical segment maps onto
// the actual target joint-to-joint vector, including wrapper transforms.
for(const [name,sourceBone]of Object.entries(o.BONE_MAP)){
 const bone=normalize(sourceBone),n=joints[name],b=target.bones[bone];let correction;
 if(name==='body')correction=quat(n).invert().multiply(q(rest[bone].quaternion));
 else{
  let direction,targetDirection,endpoint;
  if(children[name]){
   const child=children[name],targetChild=normalize(o.BONE_MAP[child]);
   direction=pos(joints[child]).sub(pos(n));targetDirection=v(rest[targetChild].position).sub(v(rest[bone].position));endpoint={sourceJoint:child,targetJoint:targetChild};
  }else if(name.endsWith('_wrist')){
   const side=name[0];direction=pos(joints[`${side}_finger_2`]).sub(pos(n));targetDirection=v(rest[`middle_01_${side}`].position).sub(v(rest[bone].position));endpoint={sourceJoint:`${side}_finger_2`,targetJoint:`middle_01_${side}`};
  }else{
   const local=name.endsWith('_ankle')?new T.Vector3(n.yVal,0,0):new T.Vector3(0,n.yVal,0);
   direction=n.imageWrapper.localToWorld(local.clone()).sub(pos(n));
   const targetEnd=name.endsWith('_ankle')?`ball_${name[0]}`:null;
   targetDirection=targetEnd?v(rest[targetEnd].position).sub(v(rest[bone].position)):v(b.userData.tailPos).sub(v(b.userData.headPos));
   if(targetEnd)targetDirection.y=0;
   endpoint={sourceWrapperPoint:local.toArray(),...(targetEnd?{targetRestDirection:targetDirection.clone().normalize().toArray(),sourceWrapperUp:[0,1,0],targetRestUp:[0,1,0]}:{targetTail:true})};
  }
  let aligned=q(rest[bone].quaternion).premultiply(new T.Quaternion().setFromUnitVectors(targetDirection.clone().normalize(),direction.clone().normalize()));
  if(name.endsWith('_wrist')){
   const side=name[0],sourceAcross=pos(joints[`${side}_finger_1`]).sub(pos(joints[`${side}_finger_4`])),targetAcross=v(rest[`index_01_${side}`].position).sub(v(rest[`pinky_01_${side}`].position));
   aligned=basis(direction.clone(),sourceAcross).multiply(basis(targetDirection.clone(),targetAcross).invert()).multiply(q(rest[bone].quaternion));
  }
  if(name.endsWith('_ankle')){
   const up=n.imageWrapper.localToWorld(new T.Vector3(0,1,0)).sub(pos(n));
   aligned=basis(direction.clone(),up).multiply(basis(targetDirection.clone(),new T.Vector3(0,1,0)).invert()).multiply(q(rest[bone].quaternion));
  }
  correction=quat(n).invert().multiply(aligned);
  map.mapped[bone]={source:name,correction:correction.toArray(),endpoint};continue;
 }
 map.mapped[bone]={source:name,correction:correction.toArray()};
}
writeFileSync(new URL('../src/poses/original/rig.json',import.meta.url),JSON.stringify(snapshot,null,2)+'\n');
writeFileSync(new URL('../src/poses/rig-mapping.json',import.meta.url),JSON.stringify(map,null,2)+'\n');
console.log(`Captured ${nodes.length} original transform nodes, ${Object.keys(joints).length} joints and ${Object.keys(map.mapped).length} mapped bones.`);
