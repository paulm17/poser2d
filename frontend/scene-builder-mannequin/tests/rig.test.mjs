import { ControlCompatibility, SOURCE_JOINTS } from '../src/rig/control-compatibility.js';
import controlReference from '../src/rig/control-reference.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { parseMorphPack, solveMorph, buildStaticModelData } from '../src/rig/vendor/morph_runtime.mjs';
import { adapter } from '../src/rig/model-adapter.js';
import { createRigFromData, BONE_NAMES, poseConfiguration, importGeneratorPose, RIG } from '../src/rig/model.js';
import { captureExactPose, applyExactPose } from '../src/poses/exact-state.js';
import { convertBlenderPose } from '../src/poses/blender-retarget.js';
import { isProject, isSnapshot } from '../protocol.js';
import { CCDIKSolver } from '../src/rig/ik-solvers.js';
const bytes=gunzipSync(readFileSync(new URL('../src/rig/vendor/assets/pose_studio_makehuman.v2.bin.gz',import.meta.url)));
const morph=parseMorphPack(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const solved=solveMorph(morph,{}),staticData=buildStaticModelData(morph,solved.includeGenitals);
const data=adapter.modelDataFromMorphMessage({...solved,staticData});
const make=()=>createRigFromData(data);
const assets=new URL('../../scene-builder/public/poses2/',import.meta.url);
const json=name=>JSON.parse(readFileSync(new URL(name,assets)));

test('uses exact generator topology, vertices, UVs, skin weights and hierarchy',()=>{
 const m=make(),g=m.mesh.geometry;
 assert.equal(Object.keys(m.bones).length,53);assert.equal(g.attributes.position.count,19158);
 for(const [attribute,expected]of [['position',data.vertices],['uv',data.uvs],['skinIndex',data.skinIndices],['skinWeight',data.skinWeights]])assert.deepEqual(Array.from(g.attributes[attribute].array),Array.from(expected));
 assert.deepEqual(Array.from(g.index.array),Array.from(data.indices));
 for(const b of data.bones)assert.equal(m.bones[b.name].parent.name,b.parent||'');
 assert.ok(Math.abs(new THREE.Box3().setFromObject(m,true).getSize(new THREE.Vector3()).y-1.7)<1e-6);
});
test('every bone deforms the actual surface on each local rotation axis (159 tests)',()=>{
 const m=make(),mesh=m.mesh,p=new THREE.Vector3(),count=mesh.geometry.attributes.position.count;
 const positions=()=>{m.updateWorldMatrix(true,true);mesh.skeleton.update();return Array.from({length:count},(_,i)=>mesh.getVertexPosition(i,new THREE.Vector3()));};
 const baseline=positions();let tests=0;
 for(const name of BONE_NAMES)for(const axis of ['x','y','z']){
  const b=m.bones[name];b.rotation[axis]=Math.PI/12;m.updateWorldMatrix(true,true);mesh.skeleton.update();
  let moved=0;for(let i=0;i<count;i++)if(mesh.getVertexPosition(i,p).distanceTo(baseline[i])>1e-5)moved++;
  assert.ok(moved>0,`${name}/${axis} must deform the surface`);if(name.startsWith('ball_'))assert.equal(moved,1057);
  b.rotation[axis]=0;tests++;
 }assert.equal(tests,159);
});
test('all 54 selector entries expose controls that rotate their actual rendered bones',()=>{
 const config=poseConfiguration(),references={1:json('ual1-reference.json'),2:json('ual2-reference.json')};assert.equal(Object.keys(config).length,54);
 for(const cfg of Object.values(config))for(const prop of Object.keys(cfg.props)){
  const m=make(),bone=cfg.target==='self'?'pelvis':cfg.target,adapter=new ControlCompatibility(m,references);
  const target=SOURCE_JOINTS[bone]?adapter.target(bone,cfg.props,cfg.target==='self'):m.bones[bone];
  const before=m.bones[bone].getWorldQuaternion(new THREE.Quaternion());target[prop]+=15;m.updateMatrixWorld(true);
  assert.ok(before.angleTo(m.bones[bone].getWorldQuaternion(new THREE.Quaternion()))>1e-4,`${cfg.label}: ${prop}`);
 }
 assert.equal(Object.values(config).filter(c=>/hand$/.test(c.group)).length,30);
});
test('exact pose round trip and generator import validate atomically',()=>{
 const m=make();m.bones.neck_01.rotationX=31;m.bones.index_02_l.rotationZ=62;
 const state=captureExactPose(m);applyExactPose(make(),state);assert.deepEqual(captureExactPose(m),state);
 const other=make();applyExactPose(other,state);assert.deepEqual(captureExactPose(other),state);
 const invalid=structuredClone(state);invalid.joints.head.quaternion=[0,0,0,0];assert.throws(()=>applyExactPose(m,invalid));assert.deepEqual(captureExactPose(m),state);
 assert.throws(()=>importGeneratorPose(m,{bones:{head:[0,10,0],bad:[0,0,0]}}));assert.deepEqual(captureExactPose(m),state);
 importGeneratorPose(m,{bones:{thumb_02_l:[25,0,0],ball_r:[30,0,0]}});assert.equal(m.bones.thumb_02_l.rotationX,25);assert.ok(Math.abs(m.bones.ball_r.rotationX-30)<1e-10);
});
test('new project rejects legacy and malformed poses before restoration',()=>{
 const m=make(),project={format:'scene-builder-mannequin',version:1,rig:RIG,mannequins:[{rig:RIG,position:[0,0,0],rotation:[0,0,0,'XYZ'],scale:[1,1,1],exactPose:captureExactPose(m)}],importedModels:[]};
 assert.ok(isProject(project));assert.ok(isSnapshot({project,history:[JSON.stringify(project)],historyIndex:0}));
 assert.equal(isProject({...project,format:undefined}),false);
 assert.equal(isProject({...project,mannequins:[{...project.mannequins[0],exactPose:{version:1,joints:{}}}]}),false);
 assert.equal(isSnapshot({project,history:['{}'],historyIndex:0}),false);
});
test('analytic arm and leg IK reaches reachable targets with explicit pole direction',()=>{
 const solver=new CCDIKSolver(THREE);
 for(const side of ['l','r'])for(const type of ['arm','leg']){
  const m=make();m.position.set(1,0.2,-0.3);m.rotation.y=0.3;m.updateWorldMatrix(true,true);
  const names=(type==='arm'?['upperarm_','lowerarm_','hand_']:['thigh_','calf_','foot_']).map(n=>n+side);
  const start=m.bones[names[0]].getWorldPosition(new THREE.Vector3()),end=m.bones[names[2]].getWorldPosition(new THREE.Vector3());
  const target=end.clone().lerp(start,0.2).add(new THREE.Vector3(0,0,0.02)),pole=start.clone().add(new THREE.Vector3(0,0,0.4));
  solver.solve({bones:names.slice(0,2),effector:names[2]},m.bones,target,pole);m.updateWorldMatrix(true,true);
  assert.ok(m.bones[names[2]].getWorldPosition(new THREE.Vector3()).distanceTo(target)<0.005,`${side} ${type}`);
 }
});
test('basic validity only: all gallery records and frames have finite transforms',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../src/poses/manifest2.json',import.meta.url))),references={1:json('ual1-reference.json'),2:json('ual2-reference.json')};
 assert.equal(manifest.length,254);let frameCount=0;const scratch=createRigFromData(data,{mesh:false});
 const before=scratch.position.toArray();
 const validate=record=>{const pose=convertBlenderPose(record,references[record.library],scratch);for(const j of Object.values(pose.joints)){assert.ok(j.quaternion.every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...j.quaternion)-1)<1e-6);}assert.deepEqual(scratch.position.toArray(),before);};
 for(const entry of manifest){validate(json(entry.data.replace('poses2/','')));const animation=json(`${entry.id}-frames.json`);assert.equal(animation.start,entry.range[0]);assert.equal(animation.end,entry.range[1]);assert.equal(animation.frames.length,animation.end-animation.start+1);for(const f of animation.frames){validate({version:1,library:entry.library,bones:f.bones});frameCount++;}}
 console.log(`Validated ${manifest.length} static poses and ${frameCount} animation frames.`);
});

test('library posing preserves the current pelvis anchor, including ground-sitting clips',()=>{
 const m=createRigFromData(data,{mesh:false}),reference=json('ual1-reference.json');
 m.bones.pelvis.position.y-=.3;
 const anchor=m.bones.pelvis.position.clone();
 convertBlenderPose(json('ual1-GroundSit_Enter.json'),reference,m);
 assert.deepEqual(m.bones.pelvis.position.toArray(),anchor.toArray());
});

test('capture omits all editor helpers even when Include Gizmo is checked, and restores visibility',async()=>{
 const { renderSceneCapture }=await import('../src/exportSystem.js');
 const scene=new THREE.Scene(),helper=new THREE.Mesh(),ik=new THREE.Mesh();helper.userData.exportAlwaysHide=true;ik.userData.exportAlwaysHide=true;ik.userData.ikLimbKey='Left_Arm';scene.add(helper,ik);
 const ground=new THREE.Mesh();scene.add(ground);let renders=0;
 const stage={scene,ground,camera:new THREE.PerspectiveCamera(),renderer:{getClearAlpha:()=>1,setClearAlpha(){},render(){renders++;}}};
 renderSceneCapture(stage,THREE,{includeGizmo:true,includeCoords:false,includeBg:false,background:'#ffffff'},()=>{assert.equal(helper.visible,false);assert.equal(ik.visible,false);assert.equal(ground.visible,false);});
 assert.ok(helper.visible&&ik.visible&&ground.visible);assert.equal(renders,2);
});


test('BackFlip 29 exposes the same elbow values and edit axes as the original editor',()=>{
 const model=make(),references={1:json('ual1-reference.json'),2:json('ual2-reference.json')};
 const animation=json('ual1-BackFlip-frames.json'),frame=animation.frames.find(f=>f.frame===29);
 applyExactPose(model,convertBlenderPose({version:1,bones:frame.bones},references[1],createRigFromData(data,{mesh:false})));
 model.userData.poseFrame={id:'ual1-BackFlip',frame:29};
 const adapter=new ControlCompatibility(model,references);
 assert.ok(Math.abs(adapter.getAngle('lowerarm_l','bend')-controlReference.backflip.elbowBend)<1e-8);
 assert.ok(adapter.position('lowerarm_l').distanceTo(new THREE.Vector3(0,11,0))<1e-10);
 const beforeParent=model.bones.upperarm_l.getWorldQuaternion(new THREE.Quaternion());
 adapter.setAngle('lowerarm_l','bend',33.56);
 assert.ok(Math.abs(adapter.getAngle('lowerarm_l','bend')-33.56)<1e-8);
 assert.ok(model.bones.upperarm_l.getWorldQuaternion(new THREE.Quaternion()).angleTo(beforeParent)<1e-7);
 // Independent oracle: apply the original Joint.z Euler rule in the original
 // captured frame, then compare the resulting physical rotation after mapping.
 const originalLocal=new THREE.Quaternion().fromArray(controlReference.backflip.exactPose.joints.l_elbow.quaternion);
 const originalWorld=new THREE.Quaternion().fromArray(controlReference.backflip.jointWorld.lowerarm_l);
 const parent=originalWorld.clone().multiply(originalLocal.clone().invert());
 const edit=new THREE.Euler().setFromQuaternion(originalLocal,'YXZ');edit.z=THREE.MathUtils.degToRad(33.56);
 const expected=parent.multiply(new THREE.Quaternion().setFromEuler(edit)).multiply(new THREE.Quaternion().fromArray(controlReference.baselines[1].lowerarm_l).invert()).multiply(adapter.alignment().newFrames.lowerarm_l);
 assert.ok(expected.angleTo(model.bones.lowerarm_l.getWorldQuaternion(new THREE.Quaternion()))<1e-7);
 const oldPosition=model.bones.lowerarm_l.getWorldPosition(new THREE.Vector3());
 for(const [axis,value]of Object.entries({x:-0.15,y:11.15,z:-0.20}))adapter.setPosition('lowerarm_l',axis,value);
 const position=adapter.position('lowerarm_l');assert.ok(position.distanceTo(new THREE.Vector3(-.15,11.15,-.2))<1e-8);
 const distance=model.bones.lowerarm_l.getWorldPosition(new THREE.Vector3()).distanceTo(oldPosition);
 assert.ok(distance>0&&distance<0.02,'original local units must not become metres');
 assert.deepEqual(model.position.toArray(),[0,0,0]);
});

test('Root reset restores the upright rendered body, not just zero control readouts',()=>{
 const references={1:json('ual1-reference.json'),2:json('ual2-reference.json')};
 for(const library of [1,2]){
  const m=make();m.userData.poseFrame={id:`ual${library}-test`};
  const adapter=new ControlCompatibility(m,references),target=adapter.target('pelvis',{bend:[],tilt:[],turn:[]},true);
  const upright=m.bones.pelvis.quaternion.clone();
  assert.ok(Math.abs(target.bend)<1e-8);assert.ok(Math.abs(target.tilt)<1e-8);assert.ok(Math.abs(target.turn+90)<1e-8);
  target.bend=40.5;target.tilt=-35;target.turn=66.5;
  m.position.set(.3,.2,-.1);
  const edited=captureExactPose(m),children=Object.fromEntries(Object.entries(m.bones).filter(([n])=>n!=='pelvis').map(([n,b])=>[n,b.quaternion.toArray()]));
  assert.ok(m.bones.pelvis.quaternion.angleTo(upright)>.1);
  target.resetPart();
  assert.ok(m.bones.pelvis.quaternion.angleTo(upright)<1e-7,'rendered body must be upright');
  assert.deepEqual(m.position.toArray(),[0,0,0]);
  for(const [name,rotation]of Object.entries(children))assert.deepEqual(m.bones[name].quaternion.toArray(),rotation);
  const reset=captureExactPose(m);target.resetPart();assert.ok(m.bones.pelvis.quaternion.angleTo(upright)<1e-7);
  applyExactPose(m,edited);assert.ok(m.bones.pelvis.quaternion.angleTo(upright)>.1);
  applyExactPose(m,reset);assert.ok(m.bones.pelvis.quaternion.angleTo(upright)<1e-7);
 }
});

test('selection tint uses only the selected bone skin weights and never changes pose',async()=>{
 const {setSkinHighlight}=await import('../src/rig/selection-highlight.js');
 const m=make(),before=captureExactPose(m),attributes=m.mesh.geometry.attributes;
 for(const name of ['spine_03','lowerarm_r','thigh_r','index_02_l','ball_r']){
  setSkinHighlight(m,m.bones[name]);
  const index=m.mesh.skeleton.bones.indexOf(m.bones[name]);let count=0;
  for(let i=0;i<attributes.position.count;i++){
   let expected=0;for(let k=0;k<4;k++)if(attributes.skinIndex.array[4*i+k]===index)expected+=attributes.skinWeight.array[4*i+k];
   assert.ok(Math.abs(attributes.selectionWeight.array[i]-expected)<1e-7);if(expected>0)count++;
  }
  assert.ok(count>0);assert.equal(m.mesh.selectionHighlight.enabled.value,1);
 }
 setSkinHighlight(m,null);assert.equal(m.mesh.selectionHighlight.enabled.value,0);assert.deepEqual(captureExactPose(m),before);
 const shader={uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <emissivemap_fragment>\n#include <dithering_fragment>'};
 m.mesh.material.onBeforeCompile(shader);
 assert.ok(shader.fragmentShader.includes('float rim'));assert.ok(shader.fragmentShader.includes('totalEmissiveRadiance += selectionColour'));
 assert.equal(shader.uniforms.selectionEnabled,m.mesh.selectionHighlight.enabled);
});

test('captures hide selection tint and restore it even on capture failure',async()=>{
 const {setSkinHighlight}=await import('../src/rig/selection-highlight.js');
 const {renderSceneCapture}=await import('../src/exportSystem.js');
 const m=make();setSkinHighlight(m,m.bones.thigh_r);const scene=new THREE.Scene();scene.add(m);
 const stage={scene,camera:new THREE.PerspectiveCamera(),renderer:{getClearAlpha:()=>1,setClearAlpha(){},render(){}}};
 for(const fail of [false,true]){
  const capture=()=>renderSceneCapture(stage,THREE,{includeGizmo:true,includeCoords:true,includeBg:true,background:'#ffffff'},()=>{
   assert.equal(m.mesh.selectionHighlight.enabled.value,0);if(fail)throw Error('capture failed');
  });
  if(fail)assert.throws(capture,/capture failed/);else capture();
  assert.equal(m.mesh.selectionHighlight.enabled.value,1);
 }
});

test('BackFlip frame 17 framing keeps the visible floor in view without changing the pose',async()=>{
 const {fitLockedCamera}=await import('../src/camera.js');
 const model=make(),animation=json('ual1-BackFlip-frames.json'),reference=json('ual1-reference.json');
 const record={version:1,bones:animation.frames.find(f=>f.frame===17).bones};
 applyExactPose(model,convertBlenderPose(record,reference,createRigFromData(data,{mesh:false})));
 const before=captureExactPose(model),bounds=new THREE.Box3().setFromObject(model,true);
 assert.ok(bounds.min.y<.2,'the erroneous one-metre pelvis translation must be absent');
 for(const aspect of [16/9,9/16,1])for(const angle of [0,Math.PI/2,Math.PI]){
  const camera=new THREE.PerspectiveCamera(35,aspect,.01,2000),controls={target:new THREE.Vector3(),getAzimuthalAngle:()=>angle};
  const frame={x:.02,y:.18,width:.65,height:.82};
  fitLockedCamera(camera,controls,model,frame,0);
  const floor=bounds.getCenter(new THREE.Vector3());floor.y=0;floor.project(camera);
  const x=(floor.x+1)/2,y=(1-floor.y)/2;
  assert.ok(x>=frame.x&&x<=frame.x+frame.width);
  assert.ok(y>=frame.y&&y<frame.y+frame.height,'floor below the airborne figure remains visible');
  assert.equal(camera.position.y,.7);
 }
 assert.deepEqual(captureExactPose(model),before);
});

test('gallery and frame transfer share exact placement rules; history and projects restore evaluated data',async()=>{
 const {libraryPoseFor}=await import('../src/poses/library-pose.js');
 const reference=json('ual1-reference.json'),asset=json('ual1-BackFlip-frames.json');
 const model=make();model.position.set(2,.4,-3);model.rotation.y=.6;model.scale.setScalar(.8);model.bones.pelvis.position.y-=.15;
 const placement={position:model.position.toArray(),rotation:model.quaternion.toArray(),scale:model.scale.toArray()},anchor=model.bones.pelvis.position.toArray(),history=[];
 for(const f of asset.frames){
  const record={version:1,bones:f.bones};
  const gallery=libraryPoseFor(model,record,reference,createRigFromData(data,{mesh:false}));
  const scrub=libraryPoseFor(model,record,reference,createRigFromData(data,{mesh:false}));
  assert.deepEqual(gallery,scrub);applyExactPose(model,scrub);history.push(JSON.stringify(captureExactPose(model)));
  assert.deepEqual(model.bones.pelvis.position.toArray(),anchor);
  assert.deepEqual({position:model.position.toArray(),rotation:model.quaternion.toArray(),scale:model.scale.toArray()},placement);
 }
 for(const text of [...history].reverse()){
  const state=JSON.parse(text);applyExactPose(model,state);assert.deepEqual(captureExactPose(model),state);
 }
 for(const text of history){applyExactPose(model,JSON.parse(text));assert.equal(JSON.stringify(captureExactPose(model)),text);}
 const project={format:'scene-builder-mannequin',version:1,rig:RIG,mannequins:[{rig:RIG,position:placement.position,rotation:[0,.6,0,'XYZ'],scale:placement.scale,exactPose:captureExactPose(model)}],importedModels:[]};
 const saved=JSON.parse(JSON.stringify(project));assert.ok(isProject(saved));const loaded=make();applyExactPose(loaded,saved.mannequins[0].exactPose);assert.deepEqual(captureExactPose(loaded),project.mannequins[0].exactPose);
 const compatibility=new ControlCompatibility(model,{1:reference,2:json('ual2-reference.json')});
 const initial=compatibility.getAngle('lowerarm_l','bend');compatibility.setAngle('lowerarm_l','bend',initial+5);
 compatibility.resetPart('lowerarm_l');assert.ok(Math.abs(compatibility.getAngle('lowerarm_l','bend')-compatibility.defaultAngles.lowerarm_l.bend)<1e-7);
});

test('Celebration 18 soles match original shoe orientation, not the downward ankle-to-ball bone',async()=>{
 const {createOriginalOracle}=await import('../scripts/original-oracle.mjs');
 const oracle=await createOriginalOracle(),reference=json('ual1-reference.json'),animation=json('ual1-Celebration-frames.json');
 const record={version:1,bones:animation.frames.find(f=>f.frame===18).bones};
 oracle.evaluate(record,reference);const m=make();convertBlenderPose(record,reference,m);
 for(const side of ['l','r']){
  const original=oracle.model[`${side}_ankle`];
  const sourceUp=new THREE.Vector3(0,1,0).applyQuaternion(original.imageWrapper.getWorldQuaternion(new THREE.Quaternion()));
  const targetUp=new THREE.Vector3(0,1,0).applyQuaternion(m.bones[`foot_${side}`].getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(sourceUp.distanceTo(targetUp)<1e-8,'actual sole normal must match the original shoe normal');
  const a=new THREE.Vector3().fromArray(m.userData.restWorld[`foot_${side}`].position),b=new THREE.Vector3().fromArray(m.userData.restWorld[`ball_${side}`].position);
  assert.ok(Math.abs(THREE.MathUtils.radToDeg(Math.atan2(a.y-b.y,Math.hypot(b.x-a.x,b.z-a.z))))>28,'the bone itself is not a horizontal sole direction');
 }
});
