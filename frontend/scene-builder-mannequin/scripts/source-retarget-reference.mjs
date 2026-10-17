/** Independent source-constraint evaluation -> proportioned free-space rig. */
import * as THREE from 'three';
/** Independently reconstruct the measured constant anatomical track fit. */
export function applyHipTracks(data,reference,fit){
 const world=Object.fromEntries(Object.entries(reference.world).map(([n,m])=>[n,m.clone()])),parents=Object.fromEntries(data.bones.map(b=>[b.name,b.parent]));
 for(const side of ['l','r']){
  const root='thigh_'+side,angle=side==='l'?fit.leftDegrees:fit.rightDegrees,delta=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().fromArray(fit.axis).normalize(),THREE.MathUtils.degToRad(angle));
  for(const bone of data.bones){let ancestor=bone.name;while(ancestor&&ancestor!==root)ancestor=parents[ancestor];if(ancestor!==root)continue;
   const n=bone.name,p=bone.parent,local=reference.world[p].clone().invert().multiply(reference.world[n]),position=new THREE.Vector3(),q=new THREE.Quaternion(),scale=new THREE.Vector3();local.decompose(position,q,scale);if(n===root)q.premultiply(delta);world[n]=world[p].clone().multiply(new THREE.Matrix4().compose(position,q,scale));
   if(n==='foot_'+side){world[n].decompose(position,new THREE.Quaternion(),new THREE.Vector3());reference.world[n].decompose(new THREE.Vector3(),q,scale);world[n].compose(position,q,scale);}
  }
 }
 const locals={};for(const bone of data.bones){const n=bone.name,m=bone.parent?world[bone.parent].clone().invert().multiply(world[n]):world[n],p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();m.decompose(p,q,s);locals[n]={position:p.toArray(),quaternion:q.toArray(),scale:s.toArray()};}
 return {world,locals};
}
export function freeSpaceReference(data,inspection,frame){
 const matrix=rows=>new THREE.Matrix4().set(...rows),sourceRest=Object.fromEntries(Object.entries(inspection.boneRest).map(([name,rows])=>[name,matrix(rows)])),sourcePose=Object.fromEntries(Object.entries(frame.boneWorld).map(([name,rows])=>[name,matrix(rows)]));
 const rest={},world={},locals={},ratio=1.7/inspection.sourceNeutralHeightMetres;
 const length=bone=>new THREE.Vector3().fromArray(bone.tailPos).distanceTo(new THREE.Vector3().fromArray(bone.headPos));
 const legNames=['thigh_l','calf_l','thigh_r','calf_r'],legRatio=legNames.reduce((sum,name)=>sum+length(data.bones.find(bone=>bone.name===name)),0)/legNames.reduce((sum,name)=>sum+inspection.boneLengths[name],0);
 for(const bone of data.bones){
  const name=bone.name,parent=bone.parent,local=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(bone.position),new THREE.Quaternion().fromArray(bone.quaternion),new THREE.Vector3().fromArray(bone.scale));rest[name]=parent?rest[parent].clone().multiply(local):local;
  const srcLocal=parent?sourcePose[parent].clone().invert().multiply(sourcePose[name]):sourcePose[name],restLocal=parent?sourceRest[parent].clone().invert().multiply(sourceRest[name]):sourceRest[name];
  const shift=new THREE.Vector3().setFromMatrixPosition(srcLocal).sub(new THREE.Vector3().setFromMatrixPosition(restLocal));let position;
  if(parent){shift.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(sourceRest[parent])).multiplyScalar(name==='pelvis'?legRatio:length(bone)/inspection.boneLengths[name]);shift.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(rest[parent]).invert());position=new THREE.Vector3().fromArray(bone.position).add(shift).applyMatrix4(world[parent]);}
  else position=new THREE.Vector3().setFromMatrixPosition(rest[name]).addScaledVector(shift,ratio);
  const q=new THREE.Quaternion(),scale=new THREE.Vector3();sourcePose[name].decompose(new THREE.Vector3(),q,scale);world[name]=new THREE.Matrix4().compose(position,q,scale);
  const result=parent?world[parent].clone().invert().multiply(world[name]):world[name],p=new THREE.Vector3(),r=new THREE.Quaternion(),s=new THREE.Vector3();result.decompose(p,r,s);locals[name]={position:p.toArray(),quaternion:r.toArray(),scale:s.toArray()};
 }
 return {world,locals};
}
