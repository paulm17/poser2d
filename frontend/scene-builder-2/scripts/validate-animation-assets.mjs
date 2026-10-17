import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {BONE_MAP} from '../src/poses/blender-retarget.js';
const manifest=JSON.parse(await readFile('src/poses/manifest2.json','utf8'));
let total=0;
for(const entry of manifest){
 const clip=JSON.parse(await readFile(`public/poses2/${entry.id}-frames.json`,'utf8'));
 const count=entry.range[1]-entry.range[0]+1;
 if(clip.start!==entry.range[0]||clip.end!==entry.range[1]||clip.frames.length!==count)throw Error(`Frame range mismatch: ${entry.id}`);
 for(const [index,frame] of clip.frames.entries()){
  if(frame.frame!==clip.start+index)throw Error(`Missing frame: ${entry.id}`);
  for(const bone of Object.values(BONE_MAP)){
   const data=frame.bones[bone];if(!data)throw Error(`Missing bone ${bone}: ${entry.id}`);
   for(const key of ['position','tail','quaternion'])if(!data[key].every(Number.isFinite))throw Error(`Invalid bone data: ${entry.id}`);
  }
 }
 const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type,nb_frames,r_frame_rate,width,height','-of','json',`public/poses2/${entry.id}.mp4`],{encoding:'utf8'});
 if(probe.status!==0)throw Error(`Invalid preview: ${entry.id}`);
 const streams=JSON.parse(probe.stdout).streams;
 if(streams.length!==1||streams[0].codec_type!=='video'||Number(streams[0].nb_frames)!==count||streams[0].width!==256||streams[0].height!==256)throw Error(`Preview mismatch: ${entry.id}`);
 const [n,d]=streams[0].r_frame_rate.split('/').map(Number);if(Math.abs(n/d-clip.fps)>.001)throw Error(`Preview FPS mismatch: ${entry.id}`);
 total+=count;
}
console.log(`Validated ${manifest.length} silent previews and ${total} consecutive animation frames.`);
