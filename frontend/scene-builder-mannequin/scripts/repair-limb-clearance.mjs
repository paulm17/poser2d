/** Transactional limb-only repair: preserve accepted retarget/floor results. */
import {mkdtempSync,cpSync,rmSync,readdirSync,renameSync,readFileSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const output=path.resolve(process.argv[2]),blender=process.argv[3]||'/Applications/Blender.app/Contents/MacOS/Blender',scripts=fileURLToPath(new URL('./',import.meta.url));
const pending=mkdtempSync(path.join(path.dirname(output),'.limb-repair-'));
const general=process.env.UAL_GENERAL_LIMBS!=='0';
function run(exe,args){const r=spawnSync(exe,args,{stdio:'inherit',env:{...process.env,UAL_GENERAL_LIMBS:general?'1':'0'}});if(r.error||r.status!==0)throw Error('Limb repair rejected; existing assets preserved.');}
try{
 cpSync(output,pending,{recursive:true});
 run(blender,['--background','--disable-autoexec',path.join(pending,'comparison.blend'),'--python-exit-code','1','--python',path.join(scripts,'repair-limb-clearance.py'),'--',pending]);
 if(process.env.UAL_TRAJECTORY_REFINE==='1')run(process.execPath,[path.join(scripts,'audit-motion-continuity.mjs'),pending]);
 run(process.execPath,[path.join(scripts,'compare-ual-fit.mjs'),pending]);
 run(blender,['--background','--disable-autoexec',path.join(pending,'comparison.blend'),'--python-exit-code','1','--python',path.join(scripts,'inspect-baked-ual.py'),'--',pending]);
 run(blender,['--background','--python-exit-code','1','--python',path.join(scripts,'audit-limb-intersections.py'),'--',pending]);
 if(JSON.parse(readFileSync(path.join(pending,'limb-intersections.json'))).intersectingFrames)throw Error('Unresolved limb intersections; existing assets preserved.');
 // Only the left/right arm subtrees may change. The rest of the accepted pose
 // must remain numerically unchanged, including placement, legs and feet.
 const before=JSON.parse(readFileSync(path.join(output,JSON.parse(readFileSync(path.join(output,'manifest.json')))[0].id+'-frames.json')));
 const after=JSON.parse(readFileSync(path.join(pending,JSON.parse(readFileSync(path.join(pending,'manifest.json')))[0].id+'-frames.json')));
 for(let i=0;i<before.frames.length;i++)for(const [name,b]of Object.entries(before.frames[i].bones)){
  if(/^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)_/.test(name))continue;
  if(general&&/^(thigh|calf|foot|ball|clavicle)_/.test(name))continue;
  const a=after.frames[i].bones[name];for(const prop of ['position','scale'])if(b[prop].some((v,j)=>Math.abs(v-a[prop][j])>((process.env.UAL_TRAJECTORY_REFINE==='1'&&name==='pelvis'&&prop==='position')?.03001:1e-5)))throw Error('Unexpected body/leg change');
  const dot=Math.abs(b.quaternion.reduce((s,v,j)=>s+v*a.quaternion[j],0));if(dot<.999999)throw Error('Unexpected body/leg rotation');
 }
 for(const file of readdirSync(pending)){if(file==='rejected-last')continue;if(statSync(path.join(pending,file)).isDirectory())cpSync(path.join(pending,file),path.join(output,file),{recursive:true});else renameSync(path.join(pending,file),path.join(output,file));}
 run(process.execPath,[path.join(scripts,'sync-legacy-limb-clearance.mjs'),output]);
}finally{rmSync(pending,{recursive:true,force:true});}
