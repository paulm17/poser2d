import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { alignSegment } from '../src/poses/blender-retarget.js';

test('segment alignment accounts for rotated parents, scale and inverted limb wrappers',()=>{
 const root=new THREE.Group();root.rotation.set(.2,.8,-.3);root.scale.setScalar(2);
 const parent=new THREE.Group();parent.rotation.set(.5,-.2,.4);root.add(parent);
 const joint=new THREE.Group(),wrapper=new THREE.Group(),end=new THREE.Group();parent.add(joint);joint.add(wrapper);wrapper.rotation.x=Math.PI;end.position.y=3;wrapper.add(end);root.updateMatrixWorld(true);
 const target=new THREE.Vector3(.3,.7,-.4).normalize();alignSegment(joint,end,target);
 const actual=end.getWorldPosition(new THREE.Vector3()).sub(joint.getWorldPosition(new THREE.Vector3())).normalize();assert(actual.distanceTo(target)<1e-6);
 assert(Math.abs(end.getWorldPosition(new THREE.Vector3()).distanceTo(joint.getWorldPosition(new THREE.Vector3()))-6)<1e-9);
});
