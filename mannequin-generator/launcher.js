import { PoseViewerCore } from './upstream/web/pose_studio/core.js';
import { adapter } from './model-adapter.js';
const canvas=document.querySelector('canvas'), status=document.querySelector('#status');
const viewer=new PoseViewerCore(canvas, {skinMode:'dummy_white',onError:error=>status.textContent=String(error)});
window.viewer=viewer;
function download(url,name){const a=document.createElement('a');a.href=url;a.download=name;a.click();}
function saveJSON(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));download(url,name);setTimeout(()=>URL.revokeObjectURL(url),1000);}
try {
 await viewer.init();
 if(!viewer.initialized) throw new Error('Original viewer failed to initialize');
 const worker=new Worker('./upstream/web/pose_studio/morph_worker.js',{type:'module'});
 const message=await new Promise((resolve,reject)=>{worker.onmessage=({data})=>data.type==='error'?reject(new Error(data.message)):data.type==='result'&&resolve(data);worker.onerror=reject;worker.postMessage({type:'solve',seq:1,clientId:'standalone',params:{},includeStatic:true});});
 viewer.loadData(adapter.modelDataFromMorphMessage(message));
 viewer.setSkinMode('dummy_white');
 viewer.setDirectionalSkydomeVisible(false);
 worker.terminate();
 const resize=()=>viewer.resize(canvas.clientWidth,canvas.clientHeight);
 new ResizeObserver(resize).observe(canvas);resize();
 document.querySelector('#capture').onclick=()=>{const image=viewer.capture(1024,1024,1,[0,0,0],0,0,0,0,{viewport:true});if(!image)throw new Error('PNG capture failed');const preview=document.createElement('img');preview.src=image;preview.alt='Exported mannequin PNG';preview.style.cssText='position:fixed;bottom:12px;right:12px;width:180px;border:1px solid #777';document.querySelector('#export-preview')?.remove();preview.id='export-preview';document.body.append(preview);download(image,'mannequin.png');status.textContent='Exported 1024 × 1024 PNG';};
 document.querySelector('#save').onclick=()=>saveJSON(viewer.getPose(),'pose.json');
 document.querySelector('#load').onchange=async event=>{const file=event.target.files[0];if(file)viewer.setPose(JSON.parse(await file.text()));};
 document.querySelector('#reset').onclick=()=>viewer.resetPose();
 for(const id of ['capture','save','reset'])document.getElementById(id).disabled=false;
 status.textContent='Ready — drag joints to pose; orbit to choose view';
 window.mannequinReady=true;
 if(new URLSearchParams(location.search).has('reference')) { const pose=await (await fetch('./reclining-pose.json')).json();viewer.setPose(pose); }
} catch(error){status.textContent=error.stack||String(error);console.error(error);}
