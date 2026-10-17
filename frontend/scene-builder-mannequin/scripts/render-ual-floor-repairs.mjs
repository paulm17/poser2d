import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const scripts=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(scripts),assets=path.join(root,'assets/ual-library'),out=path.join(root,'docs/ual-fit/floor-repair');
const actions=JSON.parse(readFileSync(path.join(assets,'floor-repair-report.json'))).actions.filter(action=>action.status==='verified');let next=0;
await Promise.all(Array.from({length:3},async()=>{while(next<actions.length){const {id}=actions[next++],destination=path.join(out,id);mkdirSync(destination,{recursive:true});await new Promise((resolve,reject)=>{const child=spawn('/Applications/Blender.app/Contents/MacOS/Blender',['--background','--disable-autoexec',path.join(assets,id,'comparison.blend'),'--python-exit-code','1','--python',path.join(scripts,'render-ual-comparison.py'),'--',destination,'--auto-frame','--animation-only']);let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);child.on('error',reject);child.on('close',code=>{writeFileSync(path.join(destination,'render.log'),log);code===0?resolve():reject(Error('Render failed: '+id));});});console.log('Rendered every frame: '+id);}}));
