import {spawnSync} from 'node:child_process';
import {readFile,writeFile,readdir,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
const sourceRoot=process.argv[2];
if(!sourceRoot)throw Error('Usage: node scripts/build-pose2-library.mjs <animations/source directory> [Blender executable]');
const blender=process.argv[3]||'/Applications/Blender.app/Contents/MacOS/Blender';
const destination=path.resolve('public/poses2');await mkdir(destination,{recursive:true});
let entries=[];
for(const library of [1,2]){
 const blend=path.join(sourceRoot,`universal_animation_library_${library}`,`UAL${library}.blend`);
 const result=spawnSync(blender,['--background','--disable-autoexec',blend,'--python',path.resolve('scripts/extract-blender-poses.py'),'--',String(library),destination],{stdio:'inherit'});
 if(result.status!==0)throw Error(`UAL${library} extraction failed`);
 entries.push(...JSON.parse(await readFile(path.join(destination,`ual${library}-manifest.json`),'utf8')));
}
if(entries.length!==254)throw Error(`Expected 254 entries; got ${entries.length}`);
await writeFile('src/poses/manifest2.json',JSON.stringify(entries,null,2)+'\n');
// Candidate images are review artifacts, not runtime assets.
const reviewDirectory=path.resolve('/tmp/pose2-review/candidates');await mkdir(reviewDirectory,{recursive:true});
for(const file of await readdir(destination))if(/^ual[12]-.+-candidate-\d+\.png$/.test(file))await rename(path.join(destination,file),path.join(reviewDirectory,file));
console.log('Built 254 static poses. Review candidates in '+reviewDirectory);
