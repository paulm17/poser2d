/** Share measured shoulder corrections with the original mannequin renderer.
 * Source bone samples stay untouched; the retargeter applies this metadata.
 */
import {readFileSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
import path from 'node:path';
const base=path.resolve(process.argv[2]);
const report=JSON.parse(readFileSync(path.join(base,'limb-clearance.json')));
const entry=JSON.parse(readFileSync(path.join(base,'manifest.json')))[0];
const root=new URL('../../scene-builder/public/poses2/',import.meta.url);
const file=new URL(entry.id+'-frames.json',root);
if(process.env.UAL_SYNC_WOODEN==='1'&&existsSync(file)){
 const clip=JSON.parse(readFileSync(file));
 if(clip.frames.length!==report.frames.length)throw Error('Legacy frame count mismatch');
 for(let i=0;i<clip.frames.length;i++){
  if(clip.frames[i].frame!==report.frames[i].frame)throw Error('Legacy frame number mismatch');
  if(clip.legacyClearanceBaseSHA256!==report.clipSHA256)delete clip.frames[i].legacyArmClearance;
  clip.frames[i].limbClearance=report.frames[i].worldShoulderCorrections;
  clip.frames[i].limbBoneCorrections=report.frames[i].worldBoneCorrections;
 }
 writeFileSync(file,JSON.stringify(clip));
 const selectedFile=new URL(entry.id+'.json',root),selected=JSON.parse(readFileSync(selectedFile));
 selected.legacyArmClearance=clip.frames[selected.frame-clip.start].legacyArmClearance;
 selected.limbClearance=clip.frames[selected.frame-clip.start].limbClearance;
 selected.limbBoneCorrections=clip.frames[selected.frame-clip.start].limbBoneCorrections;
 writeFileSync(selectedFile,JSON.stringify(selected));
 console.log('Updated legacy shoulder metadata: '+entry.id);
}

// These milestone routes intentionally retain their original asset URLs.
const aliases={'ual1-Crouch_Fwd_Loop':'ual-fit','ual1-Crawl_Bwd_Loop':'ual-crawl-bwd'};
if(aliases[entry.id]){const target=new URL('../assets/'+aliases[entry.id]+'/',import.meta.url);for(const file of [entry.id+'-frames.json',entry.id+'.json','makehuman-ual.glb','comparison.blend','fit-report.json','limb-clearance.json','blender-vertices.f32','blender-world.f64'])if(existsSync(path.join(base,file)))copyFileSync(path.join(base,file),new URL(file,target));}
