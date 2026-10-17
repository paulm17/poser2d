import * as THREE from './upstream/web/vendor/three/three.module.js';
import {Male,getStage} from './source-node-modules/mannequin-js/src/mannequin.js';
import {applyExactPose,captureExactPose} from './source-exact-state.js';
try {
 const sourceStage=getStage();sourceStage.renderer.setAnimationLoop(null);sourceStage.renderer.domElement.remove();
 while(!window.mannequinReady) await new Promise(requestAnimationFrame);
 const viewer=window.viewer;
 await viewer._skinTexturePromise;
 if(!viewer.cachedSkinTexture?.image) throw Error('VNCCS dummy texture did not load');
 const project=await(await fetch('./standing-experiment-project.json')).json(), saved=project.mannequins[0];
 if(Object.keys(saved.exactPose?.joints||{}).length!==47) throw Error('Expected 47 exact joints');
 const m=new Male();m.position.fromArray(saved.position);m.rotation.fromArray(saved.rotation);m.scale.fromArray(saved.scale);
 m.posture=saved.posture;
 for(const [name,state] of Object.entries(saved.joints||{})) if(m[name]){m[name].position.fromArray(state.position);m[name].rotation.fromArray(state.rotation);m[name].scale.fromArray(state.scale);}
 applyExactPose(m,saved.exactPose);
 const tex=viewer.cachedSkinTexture, textureCanvas=document.createElement('canvas');
 textureCanvas.width=tex.image.width;textureCanvas.height=tex.image.height;
 const tctx=textureCanvas.getContext('2d',{willReadFrequently:true});tctx.drawImage(tex.image,0,0);
 const pixels=tctx.getImageData(0,0,textureCanvas.width,textureCanvas.height).data, rgba=Array.from(pixels.slice(0,4));
 for(let i=0;i<pixels.length;i++)if(pixels[i]!==rgba[i%4])throw Error('Dummy texture is not uniform');
 const material=viewer.skinnedMesh.material.clone();material.onBeforeCompile=viewer.skinnedMesh.material.onBeforeCompile;
 if(material.map!==tex)throw Error('Reference material is not using the loaded dummy texture');
 // The same constant texture is valid for any source UV layout; do not edit UVs or vertices.
 viewer.scene.remove(viewer.skinnedMesh);viewer.scene.add(m);viewer.setDirectionalSkydomeVisible(false);
 const meshes=[];m.traverse(o=>{if(o.isMesh)meshes.push(o);});
 const originalMaterials=meshes.map(o=>o.material);
 const vertices=()=>{m.updateWorldMatrix(true,true);const out=[];for(const o of meshes){const a=o.geometry.attributes.position;for(let i=0;i<a.count;i++){const p=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld);out.push(p.x,p.y,p.z);}}return out;};
 const topology=()=>JSON.stringify(meshes.map(o=>({positions:Array.from(o.geometry.attributes.position.array),index:o.geometry.index?Array.from(o.geometry.index.array):null,groups:o.geometry.groups})));
 const before=vertices(), joints=JSON.stringify(captureExactPose(m)), topologyBefore=topology();
 // Fit every vertex along the saved viewing direction, without changing model transforms.
 const bounds=new THREE.Box3().setFromObject(m),center=bounds.getCenter(new THREE.Vector3());
 const q=new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(project.camera.rotation));
 const inv=q.clone().invert(), fov=30, tan=Math.tan(THREE.MathUtils.degToRad(fov/2));let distance=0;
 for(let i=0;i<before.length;i+=3){const p=new THREE.Vector3(before[i],before[i+1],before[i+2]).sub(center).applyQuaternion(inv);distance=Math.max(distance,p.z+1.1*Math.max(Math.abs(p.x),Math.abs(p.y))/tan);}
 viewer.camera.fov=fov;viewer.camera.aspect=1;viewer.camera.zoom=1;viewer.camera.quaternion.copy(q);viewer.camera.position.copy(center).add(new THREE.Vector3(0,0,distance).applyQuaternion(q));viewer.camera.near=.001;viewer.camera.far=Math.max(1000,distance*10);viewer.camera.updateProjectionMatrix();viewer.camera.updateMatrixWorld(true);
 const capture=()=>viewer.capture(1024,1024,1,[0,0,0],0,0,0,0,{viewport:true});
 const control=capture();meshes.forEach(o=>o.material=material);const experimental=capture();
 const after=vertices();let maxDisplacement=0;for(let i=0;i<before.length;i++)maxDisplacement=Math.max(maxDisplacement,Math.abs(before[i]-after[i]));
 const unchangedJoints=joints===JSON.stringify(captureExactPose(m)), unchangedTopology=topologyBefore===topology();
 if(maxDisplacement!==0||!unchangedJoints||!unchangedTopology)throw Error('Geometry preservation failed');
 // Compare rasterized coverage using a common opaque mask material, independent of shading.
 const maskMaterial=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide});
 function mask(){const old=meshes.map(o=>o.material);meshes.forEach(o=>o.material=maskMaterial);const png=capture();meshes.forEach((o,i)=>o.material=old[i]);return png;}
 const experimentalMask=mask();meshes.forEach((o,i)=>o.material=originalMaterials[i]);const controlMask=mask();meshes.forEach(o=>o.material=material);
 const stats=async url=>{const im=new Image();im.src=url;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;let n=0;const sum=[0,0,0],min=[255,255,255],max=[0,0,0];for(let i=0;i<p.length;i+=4)if(p[i]||p[i+1]||p[i+2]){n++;for(let j=0;j<3;j++){sum[j]+=p[i+j];min[j]=Math.min(min[j],p[i+j]);max[j]=Math.max(max[j],p[i+j]);}}return {width:im.width,height:im.height,nonblackPixels:n,meanNonblackRGB:sum.map(v=>v/n),minNonblackRGB:min,maxNonblackRGB:max};};
 const report={source:'standing-experiment-project.json',mannequinIndex:0,geometry:'Original mannequin-js Male; no VNCCS retargeting',jointCount:47,meshCount:meshes.length,vertexCount:before.length/3,verification:{maxWorldCoordinateDisplacement:maxDisplacement,unchangedJoints,unchangedTopology,identicalSilhouette:controlMask===experimentalMask},texture:{file:'upstream/web/pose_studio/textures/skin_dummy.png',width:tex.image.width,height:tex.image.height,uniqueColors:1,rgba,colorSpace:tex.colorSpace},render:{threeRevision:THREE.REVISION,outputColorSpace:viewer.renderer.outputColorSpace,toneMapping:viewer.renderer.toneMapping,exposure:viewer.renderer.toneMappingExposure,pixelRatio:viewer.renderer.getPixelRatio(),background:'#000000',lights:viewer.lights.map(l=>({type:l.type,intensity:l.intensity,color:l.color.getHexString()})),material:{type:material.type,color:material.color.getHexString(),specular:material.specular.getHexString(),shininess:material.shininess,side:material.side,rimShader:material.onBeforeCompile.toString()},camera:{position:viewer.camera.position.toArray(),quaternion:q.toArray(),fov,fitMargin:1.1}},control:await stats(control),experimental:await stats(experimental),limitations:['Original material control uses the same VNCCS ambient lighting as the experimental export.','Exact saved viewing direction; framing fitted mathematically rather than reproducing editor crop.','No LoRA inference performed.']};
 if(!report.verification.identicalSilhouette)throw Error('Silhouette mismatch');
 window.standingExperiment={control,experimental,report};document.querySelector('#status').textContent='Complete: exact geometry verified';
} catch(e){window.standingExperimentError=e.stack;document.querySelector('#status').textContent=e.stack;console.error(e);}
