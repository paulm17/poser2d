/** Publish previews only from verified actual-editor frame captures. */
import {readFileSync,copyFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import path from 'node:path';
const id=process.argv[2]||'ual1-Crouch_Fwd_L_Loop',docs=fileURLToPath(new URL('../docs/ual-fit/limb-clearance/',import.meta.url));
const audit=JSON.parse(readFileSync(path.join(docs,'app-limb-summary.json')));for(const name of ['makehuman','legacy','legacy2'])if(audit[name]?.frames!==61||audit[name].intersectingFrames)throw Error('All-editor limb audit must pass first');
const asset=new URL('../assets/ual-library/'+id+'/',import.meta.url),source=new URL('../../scene-builder/public/poses2/',import.meta.url);
copyFileSync(path.join(docs,'makehuman/030.png'),new URL(id+'.png',asset));copyFileSync(path.join(docs,'legacy/030.png'),new URL(id+'.png',source));
for(const [format,codec]of [['mp4','libx264'],['webm','libvpx-vp9']]){
 const target=fileURLToPath(new URL(id+'.'+format,source));const args=['-y','-loglevel','error','-framerate','30','-i',path.join(docs,'legacy/%03d.png'),'-an','-c:v',codec,'-pix_fmt','yuv420p',target];const r=spawnSync('ffmpeg',args,{stdio:'inherit'});if(r.status!==0)throw Error('Preview encoding failed');
}
console.log('Published actual-editor corrected thumbnails and hover previews');
