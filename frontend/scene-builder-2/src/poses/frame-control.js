import {convertBlenderPose} from './blender-retarget.js';
import {applyExactPose} from './exact-state.js';
import {AnimationFrameCache} from './animation-cache.js';
import manifest from './manifest2.json';

export function initFrameControl({getSelected,createScratch,onPreview,onCommit}){
 const entries=new Map(manifest.map(entry=>[entry.id,entry]));
 const panel=document.getElementById('animation-frame-panel'),slider=panel.querySelector('input[type=range]'),number=panel.querySelector('input[type=number]'),label=panel.querySelector('output'),status=panel.querySelector('[role=status]');
 const cache=new AnimationFrameCache(8),references=new Map();let dirtyTarget=null,dirtyId=null;
 async function fetchData(file){const r=await fetch(new URL('../poses2/'+file, document.baseURI).href);if(!r.ok)throw Error('Frame data could not be loaded.');return r.json();}
 async function load(entry){
  return cache.get(entry.id,async()=>{
   if(!references.has(entry.library))references.set(entry.library,fetchData(`ual${entry.library}-reference.json`).catch(error=>{references.delete(entry.library);throw error;}));
   const [asset,reference]=await Promise.all([fetchData(`${entry.id}-frames.json`),references.get(entry.library)]);
   if(asset.start!==entry.range[0]||asset.end!==entry.range[1]||asset.frames.length!==asset.end-asset.start+1||asset.frames.some((f,i)=>f.frame!==asset.start+i))throw Error('Animation frame data is incomplete.');
   return {asset,reference};
  });
 }
 function update(){
  const selected=getSelected(),selection=selected?.userData.poseFrame,entry=entries.get(selection?.id);
  panel.hidden=!entry;if(!entry)return;
  panel.querySelector('h3').textContent=entry.name.replaceAll('_',' ');
  const loaded=cache.peek(entry.id),start=loaded?.asset.start??entry.range[0],end=loaded?.asset.end??entry.range[1];
  slider.min=number.min=start;slider.max=number.max=end;slider.value=number.value=selection.frame;
  label.textContent=`Frame ${selection.frame} · ${start}–${end}`;
  panel.querySelector('.frame-notches').style.setProperty('--frame-count',end-start+1);
  slider.disabled=number.disabled=!loaded;
  if(loaded){status.textContent=`${loaded.asset.frames.length} frames · manual placement`;return;}
  status.textContent='Loading frames…';
  load(entry).then(()=>{if(getSelected()===selected&&selected.userData.poseFrame?.id===entry.id)update();}).catch(error=>{if(getSelected()===selected&&selected.userData.poseFrame?.id===entry.id)status.textContent=error.message;});
 }
 function commit(){if(dirtyTarget){dirtyTarget=null;dirtyId=null;onCommit();}}
 function apply(value,finish){
  const selected=getSelected(),selection=selected?.userData.poseFrame,loaded=cache.peek(selection?.id);if(!loaded)return;
  const {asset,reference}=loaded;const frame=Math.max(asset.start,Math.min(asset.end,Math.round(Number(value))));if(!Number.isFinite(frame))return;
  if(frame!==selection.frame){
   let scratch;
   try{
    if(dirtyTarget&&(dirtyTarget!==selected||dirtyId!==selection.id))commit();
    scratch=createScratch(selected);const sample=asset.frames[frame-asset.start];const record={version:1,bones:sample.bones,limbClearance:sample.limbClearance,limbBoneCorrections:sample.limbBoneCorrections,legacyArmClearance:sample.legacyArmClearance};
    const pose=convertBlenderPose(record,reference,scratch);pose.joints.body.position=selected.body.position.toArray();applyExactPose(selected,pose);
    selected.userData.poseFrame={id:selection.id,frame};dirtyTarget=selected;dirtyId=selection.id;onPreview();
   }catch(error){status.textContent=error.message;return;}
   finally{scratch?.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();});}
  }
  update();if(finish)commit();
 }
 slider.oninput=()=>apply(slider.value,false);slider.onchange=()=>apply(slider.value,true);
 number.oninput=()=>{if(number.value!=='')apply(number.value,false);};
 number.onblur=()=>apply(number.value,true);number.onkeydown=event=>{if(event.key==='Enter')number.blur();};
 return {update,commit,prepare:entry=>load(entry)};
}
