import * as THREE from 'three';

import { jointNodes, captureExactPose } from './exact-state.js';

export const BONE_MAP={body:'pelvis',torso:'spine_03',neck:'neck_01',head:'Head',l_arm:'upperarm_l',l_elbow:'lowerarm_l',l_wrist:'hand_l',r_arm:'upperarm_r',r_elbow:'lowerarm_r',r_wrist:'hand_r',l_leg:'thigh_l',l_knee:'calf_l',l_ankle:'foot_l',r_leg:'thigh_r',r_knee:'calf_r',r_ankle:'foot_r'};
for(const side of ['l','r'])for(const [i,finger] of ['thumb','index','middle','ring','pinky'].entries())for(const [j,suffix] of ['', '.mid','.tip'].entries())BONE_MAP[`${side}_finger_${i}${suffix}`]=`${finger}_0${j+1}_${side}`;
const q=value=>new THREE.Quaternion().fromArray(value);
const v=value=>new THREE.Vector3().fromArray(value);
export function calibratedWorldRotation(pose,reference,targetReference){
 return q(pose).multiply(q(reference).invert()).multiply(q(targetReference)).normalize();
}
function calibrate(scratch,reference){
 scratch.position.set(0,0,0);scratch.rotation.set(0,0,0);scratch.scale.setScalar(1);
 const nodes=jointNodes(scratch);
 for(const node of Object.values(nodes))node.rotation.set(0,0,0);
 scratch.body.turn=-90;
 scratch.updateWorldMatrix(true,true);
 for(const [jointName,childName] of [['torso','neck'],['neck','head'],['l_arm','l_elbow'],['l_elbow','l_wrist'],['r_arm','r_elbow'],['r_elbow','r_wrist'],['l_leg','l_knee'],['l_knee','l_ankle'],['r_leg','r_knee'],['r_knee','r_ankle']]){
  const bone=reference[BONE_MAP[jointName]];
  alignSegment(nodes[jointName],nodes[childName],v(bone.tail).sub(v(bone.position)));
 }
 // Finger and wrist axes use their actual imageWrapper, including the thumb base.
 for(const side of ['l','r']){
  const node=scratch[`${side}_wrist`];node.updateWorldMatrix(true,true);
  const sourceFrame=palmFrame(v(reference[`hand_${side}`].tail).sub(v(reference[`hand_${side}`].position)),v(reference[`index_01_${side}`].position).sub(v(reference[`pinky_01_${side}`].position)));
  const handPosition=node.getWorldPosition(new THREE.Vector3());
  const targetFrame=palmFrame(scratch[`${side}_finger_2`].getWorldPosition(new THREE.Vector3()).sub(handPosition),scratch[`${side}_finger_1`].getWorldPosition(new THREE.Vector3()).sub(scratch[`${side}_finger_4`].getWorldPosition(new THREE.Vector3())));
  const world=node.getWorldQuaternion(new THREE.Quaternion()).premultiply(sourceFrame.multiply(targetFrame.invert()));
  node.quaternion.copy(node.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));node.updateWorldMatrix(true,true);
 }
 for(const name of Object.keys(BONE_MAP).filter(n=>n.includes('finger'))){
  const node=nodes[name],bone=reference[BONE_MAP[name]];
  const endpoint=new THREE.Object3D();endpoint.position.set(0,node.yVal||1,0);node.imageWrapper.add(endpoint);
  alignSegment(node,endpoint,v(bone.tail).sub(v(bone.position)));node.imageWrapper.remove(endpoint);
 }
 scratch.updateWorldMatrix(true,true);
 return Object.fromEntries(Object.keys(BONE_MAP).map(name=>[name,nodes[name].getWorldQuaternion(new THREE.Quaternion()).toArray()]));
}
export function convertBlenderPose(record,referenceRecord,scratch){
 if(record.version!==1)throw Error('Unsupported Blender pose version.');
 const reference=referenceRecord.reference;
 for(const bone of Object.values(BONE_MAP))for(const data of [record.bones[bone],reference[bone]])if(!data||data.quaternion.length!==4||!data.quaternion.every(Number.isFinite))throw Error(`Missing or invalid Blender bone: ${bone}`);
 const baseline=calibrate(scratch,reference),nodes=jointNodes(scratch);
 // Process in scene hierarchy order so each desired world orientation is converted
 // against its already-applied parent, including the joint's imageWrapper.
 const names=Object.keys(BONE_MAP).sort((a,b)=>depth(nodes[a])-depth(nodes[b]));
 for(const name of names){
  const bone=BONE_MAP[name];
  const desired=calibratedWorldRotation(record.bones[bone].quaternion,reference[bone].quaternion,baseline[name]);
  // Share the measured arm correction with the MakeHuman export.
  const side=name.startsWith('l_')?'l':name.startsWith('r_')?'r':null;
  if(record.limbBoneCorrections?.[bone])desired.premultiply(q(record.limbBoneCorrections[bone])).normalize();
  else if(side&&record.limbClearance?.[side]&&(/_(arm|elbow|wrist|finger_)/.test(name)))desired.premultiply(q(record.limbClearance[side])).normalize();
  if(side&&record.legacyArmClearance?.[side]&&(/_(arm|elbow|wrist|finger_)/.test(name)))desired.premultiply(q(record.legacyArmClearance[side])).normalize();
  const parent=nodes[name].parent.getWorldQuaternion(new THREE.Quaternion());
  nodes[name].quaternion.copy(parent.invert().multiply(desired));nodes[name].updateWorldMatrix(true,true);
 }
 return captureExactPose(scratch);
}
function depth(node){let n=0;while(node.parent){n++;node=node.parent;}return n;}

function palmFrame(forward,across){
 const y=forward.normalize();const x=across.addScaledVector(y,-across.dot(y)).normalize();const z=new THREE.Vector3().crossVectors(x,y).normalize();
 if(x.lengthSq()<.5||y.lengthSq()<.5)throw Error('Invalid hand calibration.');
 return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));
}

const position = node => node.getWorldPosition(new THREE.Vector3());
export function alignSegment(joint, child, direction) {
  joint.updateWorldMatrix(true,true);
  const current = position(child).sub(position(joint)).normalize();
  if (direction.lengthSq()<1e-10 || current.lengthSq()<.5) throw Error('Pose contains a collapsed limb.');
  const world = joint.getWorldQuaternion(new THREE.Quaternion());
  world.premultiply(new THREE.Quaternion().setFromUnitVectors(current,direction.clone().normalize()));
  const parent = joint.parent.getWorldQuaternion(new THREE.Quaternion());
  joint.quaternion.copy(parent.invert().multiply(world));
  joint.updateWorldMatrix(true,true);
}
