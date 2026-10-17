import * as THREE from './upstream/web/vendor/three/three.module.js';
import {Male,getStage} from './source-node-modules/mannequin-js/src/mannequin.js';
import {applyExactPose} from './source-exact-state.js';
const stage=getStage();stage.renderer.setAnimationLoop(null);stage.renderer.domElement.remove();
while(!window.mannequinReady) await new Promise(requestAnimationFrame);
const viewer=window.viewer, project=await(await fetch('./source-pose-project.json')).json();
const index=Number(new URLSearchParams(location.search).get('pose')||0), saved=project.mannequins[index];
const m=new Male();m.position.fromArray(saved.position);m.rotation.fromArray(saved.rotation);m.scale.fromArray(saved.scale);m.posture=saved.posture;
for(const [name,state] of Object.entries(saved.joints||{})){if(m[name]){m[name].position.fromArray(state.position);m[name].rotation.fromArray(state.rotation);m[name].scale.fromArray(state.scale);}}
applyExactPose(m,saved.exactPose);
const sourceCamera=new THREE.PerspectiveCamera(30,1,.01,1000);sourceCamera.position.fromArray(project.camera.position);sourceCamera.lookAt(new THREE.Vector3(...project.camera.target));sourceCamera.updateMatrixWorld(true);
const inverseCamera=sourceCamera.quaternion.clone().invert();
const point=node=>node.getWorldPosition(new THREE.Vector3()).applyQuaternion(inverseCamera);
const basis=(direction,forward)=>{const y=direction.clone().normalize(),z=forward.clone().addScaledVector(y,-forward.dot(y)).normalize(),x=new THREE.Vector3().crossVectors(y,z).normalize();z.crossVectors(x,y);return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));};
const pairs={pelvis:['pelvis','torso'],spine_01:['pelvis','torso'],spine_02:['pelvis','torso'],spine_03:['torso','neck'],neck_01:['neck','head'],head:['head',null],upperarm_l:['l_arm','l_elbow'],upperarm_r:['r_arm','r_elbow'],lowerarm_l:['l_elbow','l_wrist'],lowerarm_r:['r_elbow','r_wrist'],hand_l:['l_wrist','l_finger_2'],hand_r:['r_wrist','r_finger_2'],thigh_l:['l_leg','l_knee'],thigh_r:['r_leg','r_knee'],calf_l:['l_knee','l_ankle'],calf_r:['r_knee','r_ankle'],foot_l:['l_ankle',null],foot_r:['r_ankle',null]};
for(const side of ['l','r'])for(const [finger,index] of [['thumb',0],['index',1],['middle',2],['ring',3],['pinky',4]]){const base=`${side}_finger_${index}`;pairs[`${finger}_01_${side}`]=[base,base+'.mid'];pairs[`${finger}_02_${side}`]=[base+'.mid',base+'.tip'];pairs[`${finger}_03_${side}`]=[base+'.tip',null];}
const sourceNode=name=>name.includes('.')?m[name.split('.')[0]][name.split('.')[1]]:m[name];
const torsoUp=point(m.neck).sub(point(m.pelvis)).normalize();
const shoulderSide=point(m.l_arm).sub(point(m.r_arm)).normalize();
const torsoForward=new THREE.Vector3().crossVectors(shoulderSide,torsoUp).normalize();
viewer.resetPose();viewer.skinnedMesh.updateMatrixWorld(true);
for(const bone of viewer.boneList){
 const pair=pairs[bone.name];if(!pair)continue;
 const source=sourceNode(pair[0]),end=pair[1]?sourceNode(pair[1]):null;
 const q=source.imageWrapper.getWorldQuaternion(new THREE.Quaternion()).premultiply(inverseCamera);
 let direction=end?point(end).sub(point(source)):new THREE.Vector3(0,1,0).applyQuaternion(q);
 if(bone.name.startsWith('foot')){source.image.geometry.computeBoundingBox();direction=source.image.localToWorld(source.image.geometry.boundingBox.getCenter(new THREE.Vector3())).applyQuaternion(inverseCamera).sub(point(source));}
 const forward=new THREE.Vector3(1,0,0).applyQuaternion(q);
 if(bone.name==='pelvis'||bone.name.startsWith('spine')){direction.copy(torsoUp);forward.copy(torsoForward);}
 if(bone.name.startsWith('foot'))forward.set(0,0,1);
 const rest=new THREE.Vector3(...bone.userData.tailPos).sub(new THREE.Vector3(...bone.userData.headPos));
 const world=basis(direction,forward).multiply(basis(rest,new THREE.Vector3(0,0,1)).invert());
 const parent=bone.parent.getWorldQuaternion(new THREE.Quaternion());bone.quaternion.copy(parent.invert().multiply(world));viewer.skinnedMesh.updateMatrixWorld(true);
}
viewer.skeleton.update();viewer.updateIKEffectorPositions();
const bounds=new THREE.Box3().setFromObject(viewer.skinnedMesh),center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
// Fit the deformed mesh using actual skinned vertex positions, not rest geometry bounds.
const posed=new THREE.Box3();const v=new THREE.Vector3();for(let i=0;i<viewer.skinnedMesh.geometry.attributes.position.count;i++){viewer.skinnedMesh.getVertexPosition(i,v);v.applyMatrix4(viewer.skinnedMesh.matrixWorld);posed.expandByPoint(v);}
posed.getCenter(center);posed.getSize(size);const distance=Math.max(size.x/(viewer.canvas.clientWidth/viewer.canvas.clientHeight),size.y)/(2*Math.tan(viewer.camera.fov*Math.PI/360)) * 1.22;
viewer.camera.position.copy(center).add(new THREE.Vector3(0,0,distance));viewer.orbit.target.copy(center);viewer.camera.aspect=1;viewer.camera.updateProjectionMatrix();viewer.orbit.update();viewer.requestRender();
const result=viewer.getPose();window.projectTransferResult=result;
const poseLink=document.createElement('a');poseLink.id='pose-data';poseLink.hidden=true;poseLink.href='data:application/json,'+encodeURIComponent(JSON.stringify(result,null,2));document.body.append(poseLink);
const button=document.createElement('button');button.textContent='Export transferred pose JSON';button.onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));a.download=index?'lying-vnccs-pose.json':'standing-vnccs-pose.json';a.click();};document.querySelector('header').append(button);
document.querySelector('#status').textContent=`Transferred ${saved.poseFrame.id}, frame ${saved.poseFrame.frame}`;

// Also render the original source mannequin unchanged, to distinguish exact restoration from retargeting.
const sourceBounds=new THREE.Box3().setFromObject(m),sourceCenter=sourceBounds.getCenter(new THREE.Vector3());
const localBounds=new THREE.Box3();m.traverse(node=>{if(node.isMesh&&node.geometry?.attributes.position){const a=node.geometry.attributes.position;for(let i=0;i<a.count;i++){const v=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(node.matrixWorld).sub(sourceCenter).applyQuaternion(inverseCamera);localBounds.expandByPoint(v);}}});
const sourceSize=localBounds.getSize(new THREE.Vector3());const sourceDistance=Math.max(sourceSize.x,sourceSize.y)/(2*Math.tan(Math.PI/12))*1.2;
stage.camera.position.copy(sourceCenter).add(new THREE.Vector3(0,0,sourceDistance).applyQuaternion(sourceCamera.quaternion));stage.camera.up.copy(new THREE.Vector3(0,1,0).applyQuaternion(sourceCamera.quaternion));stage.camera.lookAt(sourceCenter);stage.camera.aspect=1;stage.camera.updateProjectionMatrix();stage.scene.background=new THREE.Color(0);stage.renderer.setSize(768,768,false);stage.renderer.render(stage.scene,stage.camera);
const sourcePreview=document.createElement('img');sourcePreview.id='source-preview';sourcePreview.src=stage.renderer.domElement.toDataURL('image/png');sourcePreview.hidden=true;document.body.append(sourcePreview);
