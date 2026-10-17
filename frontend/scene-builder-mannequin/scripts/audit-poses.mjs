import {readFileSync,writeFileSync,createWriteStream,mkdirSync} from 'node:fs';
import {once} from 'node:events';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {createOriginalOracle} from './original-oracle.mjs';
import {modelData} from './model-data.mjs';
import {createRigFromData} from '../src/rig/model.js';
import {libraryPoseFor} from '../src/poses/library-pose.js';
import {applyExactPose,captureExactPose} from '../src/poses/exact-state.js';
import {createOriginalRig,evaluateOriginal,jointNodes as mirrorJoints} from '../src/poses/original/rig.js';
import mapping from '../src/poses/rig-mapping.json' with {type:'json'};
const json=p=>JSON.parse(readFileSync(p)),assets=new URL('../../scene-builder/public/poses2/',import.meta.url);
const manifest=json(new URL('../src/poses/manifest2.json',import.meta.url));
const oracle=await createOriginalOracle();
// Strip rendering meshes after the actual constructor and ground normalization.
// Keep the original Joint instances and all hierarchy/wrapper transforms.
for(const m of [oracle.model,oracle.scratch]){const meshes=[];m.traverse(n=>{if(n.isMesh)meshes.push(n);});for(const n of meshes)n.removeFromParent();}
const target=createRigFromData(modelData(),{mesh:false}),mirror=createOriginalRig(),tj=target.bones,source=oracle.jointNodes(oracle.model);
const names=Object.keys(tj).sort((a,b)=>depth(tj[a])-depth(tj[b]));
const rest=Object.fromEntries(names.map(name=>[name,{position:tj[name].position.clone(),scale:tj[name].scale.clone(),quaternion:tj[name].quaternion.clone()}]));
const rootMatrix=tj.Root.parent.matrixWorld.clone();
const thresholds={rotationDegrees:.001,directionDegrees:.001,positionMetres:.00001,sourcePositionUnits:.00001};
const summary={records:0,gallery:0,frames:0,jointsPerRecord:names.length,sourceJointsPerRecord:Object.keys(source).length,thresholds,failures:0,discontinuityFailures:0,missing:[],libraries:{},maximum:{},provenance:{}};
for(const file of ['../../scene-builder/src/poses/blender-retarget.js','../../scene-builder/src/poses/exact-state.js','../src/poses/rig-mapping.json','../src/poses/original/rig.json','../src/poses/blender-retarget.js','../src/poses/library-pose.js','../src/poses/original/rig.js'])summary.provenance[file]=createHash('sha256').update(readFileSync(new URL(file,import.meta.url))).digest('hex');
for(const file of ['blender-retarget.js','exact-state.js']){
 const original=readFileSync(new URL('../../scene-builder/src/poses/'+file,import.meta.url)),copy=readFileSync(new URL('../src/poses/original/'+file,import.meta.url));
 if(!original.equals(copy))throw Error(`Original source copy differs: ${file}`);
}
if(names.length!==53||Object.keys(mapping.mapped).length!==46||names.some(n=>!mapping.mapped[n]&&!mapping.extras[n]))throw Error('Incomplete or ambiguous bone mapping');
for(const [name,spec]of Object.entries(mapping.mapped)){
 if(!source[spec.source])throw Error(`Missing original joint ${spec.source}`);
 if(/_[lr]$/.test(name)&&spec.source[0]!==name.at(-1))throw Error(`Incorrect side mapping ${name}`);
}
const out=new URL('../docs/pose-audit/',import.meta.url);mkdirSync(out,{recursive:true});
const destination=createWriteStream(new URL('records.ndjson.gz',out)),records=createGzip();records.pipe(destination);
const q=a=>new T.Quaternion().fromArray(a),v=a=>new T.Vector3().fromArray(a),pos=n=>n.getWorldPosition(new T.Vector3());
function depth(n){return n.parent?1+depth(n.parent):0;}
function angle(a,b){const r=a.clone().normalize().invert().multiply(b.clone().normalize());return T.MathUtils.radToDeg(2*Math.atan2(Math.hypot(r.x,r.y,r.z),Math.abs(r.w)));}
function directionAngle(a,b){a=a.clone().normalize();b=b.clone().normalize();return T.MathUtils.radToDeg(Math.atan2(new T.Vector3().crossVectors(a,b).length(),a.dot(b)));}
function max(key,value,id,joint){if(!Number.isFinite(value))throw Error(`${id}/${joint}: non-finite ${key}`);if(!summary.maximum[key]||value>summary.maximum[key].value)summary.maximum[key]={value,record:id,joint};}
let previous=null;
for(const entry of manifest){
 const reference=json(new URL(`ual${entry.library}-reference.json`,assets));
 const animation=json(new URL(`${entry.id}-frames.json`,assets));
 if(animation.frames.length!==animation.end-animation.start+1||animation.frames.some((f,i)=>f.frame!==animation.start+i))throw Error('Incomplete frame coverage: '+entry.id);
 const inputs=[{kind:'gallery',record:json(new URL(entry.data.replace('poses2/',''),assets)),frame:entry.frame},...animation.frames.map(f=>({kind:'frame',frame:f.frame,record:{version:1,bones:f.bones}}))];
 for(const input of inputs){
  const id=`${entry.id}/${input.kind}/${input.frame}`;
  oracle.evaluate(input.record,reference);evaluateOriginal(input.record,reference,mirror);
  // Production output is evaluated separately from the oracle.
  const actual=libraryPoseFor(target,input.record,reference,target);
  const serialized=JSON.parse(JSON.stringify(actual));applyExactPose(target,serialized);
  if(JSON.stringify(captureExactPose(target))!==JSON.stringify(actual))throw Error(`${id}: exact state round trip failed`);
  const mirrorNodes=mirrorJoints(mirror),sourceInverse=oracle.model.matrixWorld.clone().invert();
  let sourceRotation=0,sourcePosition=0;
  const evaluatedSource={};
  for(const [name,n]of Object.entries(source)){
   const expectedWorld=n.getWorldQuaternion(new T.Quaternion()),expectedPosition=pos(n),mirrorPosition=pos(mirrorNodes[name]);
   const r=angle(expectedWorld,mirrorNodes[name].getWorldQuaternion(new T.Quaternion()));
   const p=expectedPosition.clone().applyMatrix4(sourceInverse).distanceTo(mirrorPosition);
   sourceRotation=Math.max(sourceRotation,r);sourcePosition=Math.max(sourcePosition,p);
   max('sourceRotationDegrees',r,id,name);max('sourcePositionUnits',p,id,name);
   evaluatedSource[name]={worldPosition:expectedPosition.toArray(),worldQuaternion:expectedWorld.toArray()};
  }
  // Independent oracle: multiply 3x3 rotation matrices from the actual original
  // Joint instances, then reconstruct target positions using target bone lengths.
  // This does not call the runtime converter or its local/world rotation logic.
  const expected={},metrics={},nextPrevious={id,entry:entry.id,kind:input.kind,frame:input.frame,joints:{}};
  let failed=sourceRotation>thresholds.rotationDegrees||sourcePosition>thresholds.sourcePositionUnits;
  for(const name of names){
   const b=tj[name],spec=mapping.mapped[name],parent=b.parent.isBone?expected[b.parent.name].matrix:rootMatrix;
   let world;
   if(spec){
    const originalMatrix=new T.Matrix4().makeRotationFromQuaternion(source[spec.source].getWorldQuaternion(new T.Quaternion()));
    world=originalMatrix.multiply(new T.Matrix4().makeRotationFromQuaternion(q(spec.correction)));
    const p=rest[name].position.clone().applyMatrix4(parent);world.setPosition(p);
    // World scale is inherited from the target normalization and skeleton.
    const ps=new T.Vector3().setFromMatrixScale(parent);world.scale(ps.multiply(rest[name].scale));
   }else world=parent.clone().multiply(new T.Matrix4().compose(rest[name].position,rest[name].quaternion,rest[name].scale));
   const ep=new T.Vector3(),eq=new T.Quaternion(),es=new T.Vector3();world.decompose(ep,eq,es);expected[name]={matrix:world,position:ep,quaternion:eq};
   const ap=pos(b),aq=b.getWorldQuaternion(new T.Quaternion());
   const r=angle(eq,aq),p=ep.distanceTo(ap),localPosition=v(actual.joints[name].position).sub(rest[name].position).applyMatrix3(new T.Matrix3().setFromMatrix4(b.parent.matrixWorld)).length();
   metrics[name]={rotationDegrees:r,positionMetres:p,localPositionMetres:localPosition};
   max('rotationDegrees',r,id,name);max('positionMetres',p,id,name);max('localPositionMetres',localPosition,id,name);
   if(r>thresholds.rotationDegrees||p>thresholds.positionMetres||localPosition>thresholds.positionMetres)failed=true;
   if(spec?.endpoint){
    const e=spec.endpoint,n=source[spec.source];
    const sd=e.sourceJoint?pos(source[e.sourceJoint]).sub(pos(n)):n.imageWrapper.localToWorld(v(e.sourceWrapperPoint)).sub(pos(n));
    const td=e.targetJoint?pos(tj[e.targetJoint]).sub(ap):v(e.targetRestDirection||b.userData.tailPos).sub(e.targetRestDirection?new T.Vector3():v(b.userData.headPos)).applyQuaternion(aq);
    if(e.sourceWrapperUp){
     const su=n.imageWrapper.localToWorld(v(e.sourceWrapperUp)).sub(pos(n)),tu=v(e.targetRestUp).applyQuaternion(aq);
     const error=directionAngle(su,tu);metrics[name].soleUpDirectionDegrees=error;max('soleUpDirectionDegrees',error,id,name);if(error>thresholds.directionDegrees)failed=true;
    }
    const d=directionAngle(sd,td);metrics[name].segmentDirectionDegrees=d;max('segmentDirectionDegrees',d,id,name);if(d>thresholds.directionDegrees)failed=true;
    metrics[name].sourceDirection=sd.normalize().toArray();
    if(name.startsWith('hand_')){
     const side=name.at(-1),sf=sd.clone().normalize(),tf=td.clone().normalize();
     const sa=pos(source[`${side}_finger_1`]).sub(pos(source[`${side}_finger_4`]));
     const ta=pos(tj[`index_01_${side}`]).sub(pos(tj[`pinky_01_${side}`]));
     sa.addScaledVector(sf,-sa.dot(sf));ta.addScaledVector(tf,-ta.dot(tf));
     const error=directionAngle(sa,ta);metrics[name].palmAcrossDirectionDegrees=error;
     max('palmAcrossDirectionDegrees',error,id,name);if(error>thresholds.directionDegrees)failed=true;
    }
   }
   if(previous?.entry===entry.id&&previous.kind==='frame'&&input.kind==='frame'&&input.frame===previous.frame+1){
    const old=previous.joints[name],error=Math.abs(angle(old.expected,eq)-angle(old.actual,aq));metrics[name].stepRotationErrorDegrees=error;
    max('stepRotationErrorDegrees',error,id,name);if(error>thresholds.rotationDegrees){failed=true;summary.discontinuityFailures++;}
   }
   nextPrevious.joints[name]={expected:eq,actual:aq};
  }
  previous=nextPrevious;
  const pelvisError=tj.pelvis.position.distanceTo(rest.pelvis.position);max('pelvisAnchorMetres',pelvisError,id,'pelvis');
  const row={id,library:entry.library,kind:input.kind,frame:input.frame,pass:!failed,sourceRotationDegrees:sourceRotation,sourcePositionUnits:sourcePosition,pelvisAnchorMetres:pelvisError,roundTripPass:true,source:evaluatedSource,joints:metrics};
  if(!records.write(JSON.stringify(row)+'\n'))await once(records,'drain');
  summary.records++;summary[input.kind==='gallery'?'gallery':'frames']++;if(failed)summary.failures++;
  const lib=summary.libraries[entry.library]??={gallery:0,frames:0};lib[input.kind==='gallery'?'gallery':'frames']++;
 }
 if(summary.gallery%25===0)console.log(`${summary.gallery} gallery entries / ${summary.frames} frames checked; failures ${summary.failures}`);
}
records.end();await once(destination,'finish');
summary.pass=summary.records===12106&&summary.gallery===254&&summary.frames===11852&&summary.failures===0;
writeFileSync(new URL('summary.json',out),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));if(!summary.pass)process.exitCode=1;
