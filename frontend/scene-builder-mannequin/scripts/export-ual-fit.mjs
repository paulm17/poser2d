/** Repeatable MakeHuman binding + one UAL action export. No source files are saved. */
import {modelData} from './model-data.mjs';
import {writeFileSync,mkdirSync,mkdtempSync,existsSync,copyFileSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const [blend,action='Crouch_Fwd_Loop',output=fileURLToPath(new URL('../assets/ual-fit/',import.meta.url)),blender='/Applications/Blender.app/Contents/MacOS/Blender']=process.argv.slice(2);
if(!blend)throw Error('Usage: node scripts/export-ual-fit.mjs source.blend [action] [output-directory] [blender]');
mkdirSync(output,{recursive:true});
const pending=mkdtempSync(path.join(output,'.export-'));
try{
 const d=modelData();for(const [k,v]of Object.entries(d))if(ArrayBuffer.isView(v))d[k]=Array.from(v);
 const input=path.join(pending,'makehuman-input.json');writeFileSync(input,JSON.stringify(d));
 const seed=path.join(output,'limb-clearance.json');if(existsSync(seed))copyFileSync(seed,path.join(pending,'limb-seed.json'));
 const binding=path.join(output,'binding.json');if(existsSync(binding))copyFileSync(binding,path.join(pending,'binding.json'));
 let run,trackEnvironment={},trackAttempts=[];
 for(let attempt=0;attempt<16;attempt++){
  const retryFile=path.join(pending,'support-track-retry.json');rmSync(retryFile,{force:true});
  run=spawnSync(blender,['--background','--disable-autoexec',path.resolve(blend),'--python-exit-code','1','--python',fileURLToPath(new URL('./fit-ual.py',import.meta.url)),'--',path.resolve(input),action,path.resolve(pending)],{stdio:'inherit',env:{...process.env,...trackEnvironment}});
  if(!existsSync(retryFile))break;
  const retry=JSON.parse((await import('node:fs')).readFileSync(retryFile));trackAttempts.push(retry);trackEnvironment={UAL_FORCE_HIP_TRACK:'1',UAL_MIN_HIP_ANGLE:String(retry.minimumHipDegrees)};
  console.log('Refit anatomical stance after support solve',JSON.stringify(retry));
 }
 rmSync(path.join(pending,'support-track-retry.json'),{force:true});
 writeFileSync(path.join(pending,'anatomical-track-search.json'),JSON.stringify({attempts:trackAttempts},null,2));
 if(run.error)throw run.error;
 if(run.status!==0)throw Error(`Blender export failed (${run.status}); existing assets were preserved.`);
 // Acceptance is independent of the exporter's own contact detection.
 const inspect=spawnSync(blender,['--background','--disable-autoexec',path.resolve(blend),'--python-exit-code','1','--python',fileURLToPath(new URL('./inspect-all-ual-feet.py',import.meta.url)),'--',path.resolve(pending)],{stdio:'inherit'});
 if(inspect.error)throw inspect.error;
 if(inspect.status!==0)throw Error('Independent source foot inspection failed; existing assets were preserved.');
 const motionArgs=[fileURLToPath(new URL('./audit-motion-continuity.mjs',import.meta.url)),path.resolve(pending)];
 let motion=spawnSync(process.execPath,motionArgs,{stdio:'inherit'});
 if(motion.status!==0){
  const refine=spawnSync(blender,['--background','--disable-autoexec',path.join(path.resolve(pending),'comparison.blend'),'--python-exit-code','1','--python',fileURLToPath(new URL('./repair-limb-clearance.py',import.meta.url)),'--',path.resolve(pending)],{stdio:'inherit',env:{...process.env,UAL_TRAJECTORY_REFINE:'1'}});
  if(refine.status!==0)throw Error('No continuous collision-free trajectory; existing assets were preserved.');
  motion=spawnSync(process.execPath,motionArgs,{stdio:'inherit'});
 }
 if(motion.status!==0)throw Error('Motion continuity acceptance failed; existing assets were preserved.');
 const compare=spawnSync(process.execPath,[fileURLToPath(new URL('./compare-ual-fit.mjs',import.meta.url)),path.resolve(pending)],{stdio:'inherit'});
 if(compare.error)throw compare.error;
 if(compare.status!==0)throw Error('All-frame runtime/Blender or source-foot comparison failed; existing assets were preserved.');
 const baked=spawnSync(blender,['--background','--disable-autoexec',path.join(path.resolve(pending),'comparison.blend'),'--python-exit-code','1','--python',fileURLToPath(new URL('./inspect-baked-ual.py',import.meta.url)),'--',path.resolve(pending)],{stdio:'inherit'});
 if(baked.error)throw baked.error;
 if(baked.status!==0)throw Error('Saved Blender action comparison failed; existing assets were preserved.');
 const limbs=spawnSync(blender,['--background','--python-exit-code','1','--python',fileURLToPath(new URL('./audit-limb-intersections.py',import.meta.url)),'--',path.resolve(pending)],{stdio:'inherit'});
 if(limbs.error||limbs.status!==0)throw Error('Independent limb intersection audit failed; existing assets were preserved.');
 const limbAudit=JSON.parse((await import('node:fs')).readFileSync(path.join(pending,'limb-intersections.json')));
 if(limbAudit.intersectingFrames)throw Error('Unresolved limb intersections; existing assets were preserved.');
 if(existsSync(path.join(output,'model.json'))){
  const {createHash}=await import('node:crypto'),{readFileSync}=await import('node:fs');const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  if(digest(path.join(output,'model.json'))!==digest(path.join(pending,'model.json')))throw Error('Shared MakeHuman model changed; existing assets were preserved.');
 }
 // Publish only after Blender completes successfully; never replace good assets
 // with the partial output of a failed fitting/export operation.
 for(const file of readdirSync(pending))renameSync(path.join(pending,file),path.join(output,file));
 const legacy=spawnSync(process.execPath,[fileURLToPath(new URL('./sync-legacy-limb-clearance.mjs',import.meta.url)),path.resolve(output)],{stdio:'inherit'});
 if(legacy.status!==0)throw Error('Legacy shoulder metadata sync failed');
}catch(error){
 const rejected=path.join(output,'rejected-last');mkdirSync(rejected,{recursive:true});
 for(const file of ['fit-report.json','all-frame-foot-inspection.json','numerical-comparison.json','baked-action-comparison.json','support-solve.json','motion-continuity.json'])if(existsSync(path.join(pending,file)))copyFileSync(path.join(pending,file),path.join(rejected,file));
 writeFileSync(path.join(rejected,'failure.json'),JSON.stringify({action,source:path.resolve(blend),error:error.message},null,2));
 throw error;
}finally{rmSync(pending,{recursive:true,force:true});}
