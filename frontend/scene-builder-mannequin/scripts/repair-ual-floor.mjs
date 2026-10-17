/** Re-export only floor-rejected clips; preserve the other verified exports. */
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {supportFor,auditSupport} from './audit-ual-support.mjs';
const scripts=path.dirname(fileURLToPath(import.meta.url)),output=path.resolve(process.argv[2]||path.join(scripts,'../assets/ual-library'));
const read=file=>JSON.parse(readFileSync(path.join(output,file))),write=(file,data)=>writeFileSync(path.join(output,file),JSON.stringify(data,null,2)+'\n');
const batch=read('batch-report.json'),rejected=read('floor-support-report.json').contexts,targets=rejected.length?rejected.map(context=>context.id):read('floor-repair-report.json').actions.map(action=>action.id);
const hash=createHash('sha256');for(const file of readdirSync(scripts).filter(name=>/\.(py|mjs)$/.test(name)).sort()){hash.update(file);hash.update(readFileSync(path.join(scripts,file)));}
const pipelineSHA256=hash.digest('hex'),repair={version:1,pipelineSHA256,started:new Date().toISOString(),actions:targets.map(id=>({id,status:'pending'}))};write('floor-repair-report.json',repair);
mkdirSync(path.join(output,'logs'),{recursive:true});
function run(args,log){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',data=>text+=data);child.stderr.on('data',data=>text+=data);child.on('error',reject);child.on('close',(code,signal)=>{writeFileSync(path.join(output,'logs',log),text);code===0?resolve():reject(Error(log+': '+(signal||code)));});});}
let next=0;await Promise.all(Array.from({length:3},async()=>{while(next<repair.actions.length){
 const row=repair.actions[next++],action=batch.actions.find(action=>action.id===row.id);row.status='running';write('floor-repair-report.json',repair);
 try{
  await run([path.join(scripts,'export-ual-fit.mjs'),action.source,action.name,path.join(output,action.id)],action.id+'-floor-repair.log');
  const directory=path.join(output,action.id),comparison=JSON.parse(readFileSync(path.join(directory,'numerical-comparison.json')));const {records,...metrics}=comparison;
  action.comparison=metrics;action.floorSupport=supportFor(directory);action.floorReady=action.floorSupport.floorReady;
  if(!action.floorReady)throw Error('Visible skin still crosses the floor');
  action.repairPipelineSHA256=pipelineSHA256;action.status='verified';action.artifactSHA256=Object.fromEntries(readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>[entry.name,createHash('sha256').update(readFileSync(path.join(directory,entry.name))).digest('hex')]));
  row.status='verified';row.frames=comparison.frames;console.log('Floor corrected '+row.id+': '+row.frames+' frames');
 }catch(error){row.status='failed';row.error=error.message;action.status='failed';action.error=error.message;console.error('FAILED '+row.id+': '+error.message);}
 write('batch-report.json',batch);write('floor-repair-report.json',repair);
}}));
repair.finished=new Date().toISOString();repair.verified=repair.actions.filter(action=>action.status==='verified').length;repair.failed=repair.actions.length-repair.verified;write('floor-repair-report.json',repair);batch.failed=batch.actions.filter(action=>action.status==='failed').length;batch.verified=batch.actions.filter(action=>action.status==='verified').length;write('batch-report.json',batch);
const summary=auditSupport(output);console.log(JSON.stringify({repaired:repair.verified,failed:repair.failed,floorReady:summary.floorReadyActions,remaining:summary.requiresSceneContextActions}));if(repair.failed)process.exitCode=1;
