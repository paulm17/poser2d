import { attachHoverPreview } from './hover-preview.js';
import manifest from './manifest2.json';
import { convertBlenderPose } from './blender-retarget.js';
import { captureExactPose, applyExactPose } from './exact-state.js';
export function initBlenderGallery({getSelected,createScratch,onApplied,preparePose=()=>Promise.resolve()}){
 const dialog=document.createElement('dialog');dialog.className='pose-modal pose2-modal glass-panel';dialog.setAttribute('aria-labelledby','pose2-title');
 dialog.innerHTML='<div class="pose-modal-heading"><h2 id="pose2-title">Select Pose</h2><button class="btn" data-close aria-label="Close Select Pose">×</button></div><div class="pose2-controls"><input class="pose-search" placeholder="Search animation name…" aria-label="Search Blender poses"><select aria-label="Animation library"><option value="all">All</option><option value="1">UAL1</option><option value="2">UAL2</option></select></div><p class="pose-status" role="status"></p><div class="pose-grid"></div>';
 document.body.append(dialog);const grid=dialog.querySelector('.pose-grid'),status=dialog.querySelector('.pose-status'),search=dialog.querySelector('input'),filter=dialog.querySelector('select');
 const references=new Map(),records=new Map();let generation=0;
 let previewCleanups=[];
 const stopPreviews=()=>{previewCleanups.forEach(cleanup=>cleanup());previewCleanups=[];};
 const previewFormat=document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')?'mp4':'webm';
 const url=path=>new URL('../'+path, document.baseURI).href;
 async function load(path){const response=await fetch(url(path));if(!response.ok)throw Error('Pose data could not be loaded.');return response.json();}
 const noSelection='Select a mannequin to apply a pose. Imported GLB models are not supported.';
 function render(){
  stopPreviews();
  const normalize=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
  const query=normalize(search.value.trim());
  const entries=manifest.filter(e=>(filter.value==='all'||String(e.library)===filter.value)&&normalize(e.name).includes(query));
  status.textContent=getSelected()?`${entries.length} poses`:noSelection;
  grid.replaceChildren(...entries.map(entry=>{
   const button=document.createElement('button');button.className='pose-thumbnail';button.title=`UAL${entry.library}: ${entry.name}`;button.setAttribute('aria-label',button.title);
   const image=document.createElement('img');image.src=url(entry.thumbnail);image.alt='';image.loading='lazy';
   const label=document.createElement('span');label.textContent=entry.name.replaceAll('_',' ');
   const library=document.createElement('small');library.textContent=`UAL${entry.library}`;button.append(image,label,library);
   previewCleanups.push(attachHoverPreview(button,image,url(`poses2/${entry.id}.${previewFormat}`))); 
   button.onclick=async()=>{
    const selected=getSelected();if(!selected){status.textContent=noSelection;return;}
    const token=++generation;status.textContent=`Applying ${label.textContent}…`;grid.setAttribute('aria-busy','true');let scratch;
    try{
     if(!references.has(entry.library))references.set(entry.library,await load(`poses2/ual${entry.library}-reference.json`));
     if(!records.has(entry.id))records.set(entry.id,await load(entry.data));
     if(token!==generation||!dialog.open||getSelected()!==selected)return;
     await preparePose(entry);
     if(token!==generation||!dialog.open||getSelected()!==selected)return;
     scratch=createScratch(selected);const result=convertBlenderPose(records.get(entry.id),references.get(entry.library),scratch);
     // Keep scene placement and the body's existing pelvis anchor.
     result.joints.body.position=selected.body.position.toArray();
     const before=captureExactPose(selected);
     try{applyExactPose(selected,result);onApplied(entry);}catch(error){applyExactPose(selected,before);throw error;}
     dialog.close();
    }catch(error){if(token===generation)status.textContent=error.message;}
    finally{if(scratch)scratch.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();});if(token===generation)grid.removeAttribute('aria-busy');}
   };return button;
  }));grid.scrollTop=0;
 }
 search.oninput=render;filter.onchange=render;
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
 dialog.addEventListener('close',()=>{stopPreviews();generation++;grid.removeAttribute('aria-busy');});
 document.getElementById('btn-pose2').onclick=()=>{render();dialog.showModal();};
}
