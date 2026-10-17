import * as THREE from 'three';
export async function initializeControlCompatibility() {}
const cache=new WeakMap();
export function controlTarget(model,cfg){
 if(!model.bones||cfg.target==='self')return model;
 if(!cache.has(model))cache.set(model,new Map());const entries=cache.get(model);
 if(entries.has(cfg.target))return entries.get(cfg.target);
 const node=model.bones[cfg.target],rest=new THREE.Quaternion().fromArray(node.userData.restQuaternion);
 const target={position:node.position,scale:node.scale,userData:{anatomicPos:new THREE.Vector3().fromArray(node.userData.restPosition),anatomicRot:Object.fromEntries(Object.keys(cfg.props).map(p=>[p,0]))}};
 const axisFor=p=>p==='turn'?'y':(p==='tilt'||p==='straddle')?'z':'x';
 for(const prop of Object.keys(cfg.props))Object.defineProperty(target,prop,{
  get(){return THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(rest.clone().invert().multiply(node.quaternion),'XYZ')[axisFor(prop)]);},
  set(value){const e=new THREE.Euler().setFromQuaternion(rest.clone().invert().multiply(node.quaternion),'XYZ');e[axisFor(prop)]=THREE.MathUtils.degToRad(value);node.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromEuler(e));model.updateMatrixWorld(true);}
 });
 target.resetPart=()=>{node.position.fromArray(node.userData.restPosition);node.quaternion.copy(rest);node.scale.fromArray(node.userData.restScale);model.updateMatrixWorld(true);};
 entries.set(cfg.target,target);return target;
}
