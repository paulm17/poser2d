/** Compare the actual editor rig implementation with Blender's evaluated mesh. */
import * as THREE from 'three';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createRigFromData} from '../src/rig/model.js';
import {freeSpaceReference,applyHipTracks} from './source-retarget-reference.mjs';
import {applyExactPose} from '../src/poses/exact-state.js';
const base=process.argv[2]?pathToFileURL(path.resolve(process.argv[2])+path.sep):new URL('../assets/ual-fit/',import.meta.url),json=f=>JSON.parse(readFileSync(new URL(f,base)));
const entry=json('manifest.json')[0],data=json('model.json'),clip=json(entry.id+'-frames.json');
const sourceFeet=JSON.parse(readFileSync(process.argv[2]?new URL('all-frame-foot-inspection.json',base):new URL('../docs/ual-fit/all-frame-foot-inspection.json',import.meta.url)));
if(sourceFeet.frames.length!==clip.frames.length||sourceFeet.frames.some((f,i)=>f.frame!==clip.frames[i].frame))throw Error('Source inspection must cover every exported frame');
const fit=json('fit-report.json'),heightRatio=fit.heightRatio,groundSupported=fit.floorPolicy==='ground-support';
let maxRootProjectionError=0,minimumIndependentReference=Infinity;const rootLifts=[];
if(fit.floorSafetyVersion){
 const fps=clip.fps,lower=Math.min(...sourceFeet.frames.map(frame=>frame.pelvisHeight))<sourceFeet.sourceNeutralHeightMetres*.2?-.10:-.03,runs=['l','r'].map(side=>{let run=0,best=0;for(let i=0;i<sourceFeet.frames.length;i++){const lo=Math.max(0,i-1),hi=Math.min(sourceFeet.frames.length-1,i+1),height=sourceFeet.frames[i].feet[side].soleMin,speed=Math.abs(sourceFeet.frames[hi].feet[side].soleMin-sourceFeet.frames[lo].feet[side].soleMin)*fps/Math.max(1,hi-lo);run=height>=lower&&height<=.002&&speed<=.1?run+1:0;best=Math.max(best,run);}return best;});
 const inferred=sourceFeet.frames.every(frame=>frame.pelvisHeight>=-.00001)&&Math.max(...runs)>=Math.max(3,Math.ceil(.08*fps));
 if(inferred!==groundSupported)throw Error('Independent source support classification disagrees with export');
}

const contactMasks={};let sourceCycle=false,period=clip.frames.length;
if(fit.floorSafetyVersion>=4){
 const minimumFrames=Math.max(3,Math.ceil(.08*clip.fps)),lower=Math.min(...sourceFeet.frames.map(f=>f.pelvisHeight))<sourceFeet.sourceNeutralHeightMetres*.2?-.10:-.03;
 if(fit.floorSafetyVersion>=5){
  const rotation=rows=>{const q=new THREE.Quaternion();new THREE.Matrix4().set(...rows).decompose(new THREE.Vector3(),q,new THREE.Vector3());return q.normalize();};
  sourceCycle=clip.frames.length>2&&Object.keys(sourceFeet.frames[0].boneWorld).every(n=>THREE.MathUtils.radToDeg(rotation(sourceFeet.frames[0].boneWorld[n]).angleTo(rotation(sourceFeet.frames.at(-1).boneWorld[n])))<1)&&Math.abs(sourceFeet.frames[0].pelvisHeight-sourceFeet.frames.at(-1).pelvisHeight)<.002;
  if(sourceCycle!==fit.cyclicContacts)throw Error('Independent cycle classification disagrees');period=sourceCycle?clip.frames.length-1:clip.frames.length;
 }
 for(const side of ['l','r']){const values=sourceFeet.frames.map(f=>f.feet[side].soleMin);let mask;
  if(fit.floorSafetyVersion>=5){
   const speeds=values.slice(0,period).map((v,i)=>{const js=sourceCycle?[(i-1+period)%period,(i+1)%period]:[i-1,i+1].filter(j=>j>=0&&j<period);return Math.min(...js.map(j=>Math.abs(values[j]-v)*clip.fps));}),stable=values.slice(0,period).filter((v,i)=>v>=lower&&v<=.02&&speeds[i]<=.1),ceiling=fit.floorSafetyVersion>=9?Math.max(.002,(stable.length?Math.min(...stable):0)+.002):.002;
   const raw=values.slice(0,period).map((v,i)=>{const neighbours=sourceCycle?[(i-1+period)%period,(i+1)%period]:[i-1,i+1].filter(j=>j>=0&&j<period),speed=Math.min(...neighbours.map(j=>Math.abs(values[j]-v)*clip.fps));return groundSupported&&v>=lower&&v<=ceiling&&speed<=.1;});
   for(let i=0;i<period;i++)if(!raw[i]){let left=i-1,right=i+1;if(sourceCycle){left=(left+period)%period;right%=period;}for(let k=0;k<2;k++)if(right>=0&&right<period&&!raw[right])right=sourceCycle?(right+1)%period:right+1;const gap=sourceCycle?(right-left-1+period)%period:right-left-1;if(left>=0&&left<period&&right>=0&&right<period&&raw[left]&&raw[right]&&gap<=2){const indices=Array.from({length:gap},(_,k)=>sourceCycle?(left+k+1)%period:left+k+1);if(indices.every(j=>values[j]>=lower&&values[j]<=.01))indices.forEach(j=>raw[j]=true);}}
   mask=raw.map((v,i)=>{if(!v)return false;let count=1;for(const direction of [-1,1])for(let offset=1;offset<period;offset++){const j=sourceCycle?(i+direction*offset+period)%period:i+direction*offset;if(j<0||j>=period||!raw[j])break;count++;}return Math.min(period,count)>=minimumFrames;});if(sourceCycle)mask.push(mask[0]);
  }else{
   mask=values.map((v,i)=>groundSupported&&v>=lower&&v<=.002&&Math.abs(values[Math.min(values.length-1,i+1)]-values[Math.max(0,i-1)])*clip.fps/Math.max(1,Math.min(values.length-1,i+1)-Math.max(0,i-1))<=.1);const raw=[...mask];for(let i=0;i<mask.length;i++)if(raw[i]){let lo=i,hi=i;while(lo>0&&raw[lo-1])lo--;while(hi+1<raw.length&&raw[hi+1])hi++;if(hi-lo+1<minimumFrames)mask[i]=false;}
  }
  contactMasks[side]=mask;
  for(let i=0;i<mask.length;i++){const recorded=fit.contacts[side].some(r=>r.start<=clip.frames[i].frame&&r.end>=clip.frames[i].frame);if(recorded!==mask[i])throw Error('Independent planted-foot interval disagrees with exporter');}
 }
}
const visibleVertices=new Set(data.indices);let maxBodyPenetration=0;
const footSets=Object.fromEntries(['l','r'].map(side=>{const bones=namesForFoot(side);return [side,new Set(Array.from({length:data.vertices.length/3},(_,i)=>i).filter(i=>visibleVertices.has(i)&&[0,1,2,3].reduce((sum,j)=>sum+(bones.includes(data.skinIndices[i*4+j])?data.skinWeights[i*4+j]:0),0)>.5))]}));
function namesForFoot(side){return data.bones.flatMap((b,i)=>['foot_'+side,'ball_'+side,'ball_leaf_'+side].includes(b.name)?[i]:[])}
const toeSets=Object.fromEntries(['l','r'].map(side=>[side,new Set([...visibleVertices].filter(i=>[0,1,2,3].reduce((sum,j)=>sum+(['ball_'+side,'ball_leaf_'+side].includes(data.bones[data.skinIndices[i*4+j]].name)?data.skinWeights[i*4+j]:0),0)>.5))]));
let maxToeContactError=0;let maxFootClearanceError=0,maxPlantedFootError=0,maxAirborneFootError=0,footWhere;
const vb=readFileSync(new URL('blender-vertices.f32',base)),wb=readFileSync(new URL('blender-world.f64',base));
const model=createRigFromData(data),names=data.bones.map(b=>b.name),vertex=new THREE.Vector3(),pos=new THREE.Vector3(),expectedQ=new THREE.Quaternion(),actualQ=new THREE.Quaternion();
let maxVertex=0,maxBone=0,maxRotation=0,vertexWhere,boneWhere,maxReferenceBone=0,maxReferenceRotation=0;const records=[];
const referenceModel=fit.floorSafetyVersion>=4||fit.floorSafetyVersion>=2&&!groundSupported?createRigFromData(data):null;
for(let f=0;f<clip.frames.length;f++){
 const frame=clip.frames[f];applyExactPose(model,{version:1,rig:data.rig,joints:frame.bones});model.mesh.skeleton.update();let frameMax=0;const soles={l:Infinity,r:Infinity},toes={l:Infinity,r:Infinity};let bodyMinimum=Infinity;
 for(let i=0;i<data.vertices.length/3;i++){
  vertex.fromBufferAttribute(model.mesh.geometry.attributes.position,i);model.mesh.applyBoneTransform(i,vertex);
  if(visibleVertices.has(i))bodyMinimum=Math.min(bodyMinimum,vertex.y);
  for(const side of ['l','r']){if(footSets[side].has(i))soles[side]=Math.min(soles[side],vertex.y);if(toeSets[side].has(i))toes[side]=Math.min(toes[side],vertex.y);}
  const offset=(f*data.vertices.length+i*3)*4;pos.set(vb.readFloatLE(offset),vb.readFloatLE(offset+4),vb.readFloatLE(offset+8));
  if(![vertex.x,vertex.y,vertex.z,pos.x,pos.y,pos.z].every(Number.isFinite))throw Error('Non-finite skin coordinates at frame '+frame.frame);
  const error=vertex.distanceTo(pos);frameMax=Math.max(frameMax,error);if(error>maxVertex){maxVertex=error;vertexWhere={frame:frame.frame,vertex:i};}
 }
 for(let j=0;j<names.length;j++){
  const rows=[];for(let k=0;k<16;k++)rows.push(wb.readDoubleLE((f*names.length*16+j*16+k)*8));
  const expected=new THREE.Matrix4().set(...rows),bone=model.bones[names[j]];
  const error=bone.getWorldPosition(pos).distanceTo(new THREE.Vector3().setFromMatrixPosition(expected));
  if(error>maxBone){maxBone=error;boneWhere={frame:frame.frame,bone:names[j]};}
  expected.decompose(new THREE.Vector3(),expectedQ,new THREE.Vector3());expectedQ.normalize();bone.getWorldQuaternion(actualQ).normalize();maxRotation=Math.max(maxRotation,THREE.MathUtils.radToDeg(expectedQ.angleTo(actualQ)));
 }
 const lift=fit.corrections[f].rootFloorLiftMetres||0;let unprojectedMinimum=bodyMinimum-lift,referenceSoles=null;
 if(referenceModel){
  const reference=freeSpaceReference(data,sourceFeet,sourceFeet.frames[f]),anatomical=fit.anatomicalHipCorrections?.axis?applyHipTracks(data,reference,fit.anatomicalHipCorrections):reference;applyExactPose(referenceModel,{version:1,rig:data.rig,joints:anatomical.locals});referenceModel.mesh.skeleton.update();referenceSoles={l:Infinity,r:Infinity};unprojectedMinimum=Infinity;
  for(const v of visibleVertices){vertex.fromBufferAttribute(referenceModel.mesh.geometry.attributes.position,v);referenceModel.mesh.applyBoneTransform(v,vertex);unprojectedMinimum=Math.min(unprojectedMinimum,vertex.y);for(const side of ['l','r'])if(footSets[side].has(v))referenceSoles[side]=Math.min(referenceSoles[side],vertex.y);}
  if(fit.floorSafetyVersion>=4){
   if(groundSupported)for(const side of ['l','r']){
    const indices=contactMasks[side].flatMap((v,i)=>v?[i]:[]),distance=Math.min(10,...indices.filter(i=>fit.floorSafetyVersion<10||sourceCycle||i>=f).map(i=>fit.floorSafetyVersion>=10?(sourceCycle?(i-f+period)%period:i-f):sourceCycle?Math.min(Math.abs(i-f),period-Math.abs(i-f)):Math.abs(i-f))),t=Math.max(0,1-distance/5),weight=fit.floorSafetyVersion>=11?(contactMasks[side][f]?1:0):t*t*(3-2*t),natural=referenceSoles[side]+fit.corrections[f].pelvisCorrection[1]-(fit.floorSafetyVersion>=7&&weight>0?(fit.corrections[f].preferredPelvisCorrection?.[1]??0):0),authored=contactMasks[side][f]?0:Math.max(0,sourceFeet.frames[f].feet[side].soleMin*(fit.floorSafetyVersion>=6?['thigh_l','calf_l','thigh_r','calf_r'].reduce((sum,n)=>{const b=data.bones.find(b=>b.name===n);return sum+new THREE.Vector3().fromArray(b.headPos).distanceTo(new THREE.Vector3().fromArray(b.tailPos));},0)/['thigh_l','calf_l','thigh_r','calf_r'].reduce((sum,n)=>sum+sourceFeet.boneLengths[n],0):heightRatio));
    referenceSoles[side]=(1-weight)*natural+weight*authored;
    if(fit.floorSafetyVersion>=8)referenceSoles[side]=Math.max(0,referenceSoles[side]);
    if(Math.abs(weight-fit.corrections[f].feet[side].contactInfluence)>1e-7)throw Error('Independent contact influence disagrees');
   }
   const floor=fit.floorTransforms[f];
   for(const name of names){const matrix=reference.world[name],position=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3();matrix.decompose(position,rotation,scale);position.add(new THREE.Vector3().fromArray(floor.worldPositionOffsets[name]));rotation.premultiply(new THREE.Quaternion().fromArray(floor.worldBoneCorrections[name]).normalize());matrix.compose(position,rotation,scale);}
  }
  // Independently compose the recorded shoulder correction on the reference
  // skeleton. Original source evaluation and floor placement remain separate.
  const sample=fit.limbClearance?.frames?.[f];
  if(sample?.worldBoneCorrections){
   for(const name of names){const matrix=reference.world[name],position=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3();matrix.decompose(position,rotation,scale);position.add(new THREE.Vector3().fromArray(sample.worldPositionOffsets?.[name]||[0,0,0]));rotation.premultiply(new THREE.Quaternion().fromArray(sample.worldBoneCorrections[name]).normalize());matrix.compose(position,rotation,scale);}
  }else{
  const correction=fit.limbClearance?.frames?.[f]?.worldShoulderCorrections;
  if(correction)for(const side of ['l','r']){
   const shoulder='upperarm_'+side,q=new THREE.Quaternion().fromArray(correction[side]).normalize();
   if(THREE.MathUtils.radToDeg(q.angleTo(new THREE.Quaternion()))>20.01)throw Error('Shoulder correction exceeds small-correction limit');
   const pivot=new THREE.Vector3().setFromMatrixPosition(reference.world[shoulder]);
   const transform=new THREE.Matrix4().makeTranslation(...pivot.toArray()).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(...pivot.clone().negate().toArray()));
   for(const bone of data.bones){let ancestor=bone.name;while(ancestor&&ancestor!==shoulder)ancestor=data.bones.find(b=>b.name===ancestor).parent;if(ancestor===shoulder)reference.world[bone.name].premultiply(transform);}
  }
  }
  for(const name of names){model.bones[name].getWorldPosition(pos);pos.y-=lift;maxReferenceBone=Math.max(maxReferenceBone,pos.distanceTo(new THREE.Vector3().setFromMatrixPosition(reference.world[name])));model.bones[name].getWorldQuaternion(actualQ).normalize();reference.world[name].decompose(new THREE.Vector3(),expectedQ,new THREE.Vector3());expectedQ.normalize();maxReferenceRotation=Math.max(maxReferenceRotation,THREE.MathUtils.radToDeg(actualQ.angleTo(expectedQ)));}
 }
 const requiredLift=unprojectedMinimum<-.00001?-unprojectedMinimum+.000002:0;minimumIndependentReference=Math.min(minimumIndependentReference,unprojectedMinimum);rootLifts.push(lift);if(fit.floorSafetyVersion<3||!fit.floorSafetyVersion)maxRootProjectionError=Math.max(maxRootProjectionError,Math.abs(lift-requiredLift));
 const feet={};for(const side of ['l','r']){const source=sourceFeet.frames[f].feet[side].soleMin,expected=(referenceSoles?referenceSoles[side]:(groundSupported||!fit.floorSafetyVersion&&source>=-.10)&&source<=.002?0:source*heightRatio)+lift,error=Math.abs(soles[side]-expected);if(error>maxFootClearanceError){maxFootClearanceError=error;footWhere={frame:frame.frame,side};}const planted=fit.floorSafetyVersion>=9?contactMasks[side][f]:Math.abs(expected)<.002;const allowance=(fit.limbClearance?.version>=3&&!planted) ? .02 : .0001;if(planted)maxPlantedFootError=Math.max(maxPlantedFootError,error);else maxAirborneFootError=Math.max(maxAirborneFootError,error);feet[side]={sourceMetres:source,expectedMetres:expected,actualMetres:soles[side],errorMetres:error,planted,allowedSkinEnvelopeErrorMetres:allowance};}
 const src=sourceFeet.frames[f],grounded=fit.floorSafetyVersion>=3?groundSupported:(groundSupported||!fit.floorSafetyVersion&&src.bodyMinimum>=-.10)&&src.bodyMinimum<=.03&&src.pelvisHeight>=0;maxBodyPenetration=Math.max(maxBodyPenetration,-bodyMinimum);for(const side of ['l','r']){const ref=src.feet[side].toeMinimum,contact=fit.floorSafetyVersion>=4?contactMasks[side][f]&&(fit.floorSafetyVersion>=9?ref-src.feet[side].soleMin<=.002:ref<=.002):grounded&&(groundSupported||ref>=-.10)&&ref<=.002;feet[side].toeMinimumMetres=toes[side];feet[side].sourceToeMinimumMetres=ref;feet[side].toeContact=contact;if(contact)maxToeContactError=Math.max(maxToeContactError,Math.abs(toes[side]));}
 records.push({frame:frame.frame,maxVertexMetres:frameMax,bodyMinimumMetres:bodyMinimum,groundPolicy:grounded?'plane':'root-clearance',rootFloorLiftMetres:lift,unprojectedMinimumMetres:unprojectedMinimum,feet});
}
if(fit.floorSafetyVersion>=3){const required=groundSupported?0:minimumIndependentReference<-.00001?-minimumIndependentReference+.000002:0;maxRootProjectionError=Math.max(...rootLifts.map(lift=>Math.abs(lift-required)));}
const report={floorSafetyVersion:fit.floorSafetyVersion||0,maxIndependentSourceBoneErrorMetres:maxReferenceBone,maxIndependentSourceRotationErrorDegrees:maxReferenceRotation,maxRootProjectionErrorMetres:maxRootProjectionError,maxToeContactErrorMetres:maxToeContactError,maxBodyPenetrationMetres:maxBodyPenetration,renderedVertices:visibleVertices.size,footWhere,maxFootClearanceErrorMetres:maxFootClearanceError,maxPlantedFootClearanceErrorMetres:maxPlantedFootError,maxAirborneSkinEnvelopeChangeMetres:maxAirborneFootError,frames:clip.frames.length,bones:names.length,vertices:data.vertices.length/3,maxVertexMetres:maxVertex,maxBoneMetres:maxBone,maxRotationDegrees:maxRotation,vertexWhere,boneWhere,thresholds:{metres:.0001,degrees:.01,footClearanceMetres:.0001,sourceContactToleranceMetres:.002},pass:maxReferenceBone<.0001&&maxReferenceRotation<.01&&maxRootProjectionError<.00001&&maxToeContactError<.0001&&maxBodyPenetration<.0001&&records.every(r=>Object.values(r.feet).every(foot=>foot.errorMetres<foot.allowedSkinEnvelopeErrorMetres))&&maxVertex<.0001&&maxBone<.0001&&maxRotation<.01,records};
writeFileSync(process.argv[2]?new URL('numerical-comparison.json',base):new URL('../docs/ual-fit/numerical-comparison.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,records:undefined}));if(!report.pass)process.exitCode=1;
