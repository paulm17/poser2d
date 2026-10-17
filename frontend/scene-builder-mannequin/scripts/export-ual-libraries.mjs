/** Discover, export and independently verify every UAL action. Resumable. */
import {spawn} from 'node:child_process';
import {supportFor,auditSupport} from './audit-ual-support.mjs';
import {mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync,renameSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){const key=args[i];if(!['--ual1','--ual2','--output','--blender','--action','--inventory-only','--render','--workers'].includes(key))throw Error('Unknown option: '+key);options[key]=['--inventory-only','--render'].includes(key)?true:args[++i];if(options[key]===undefined)throw Error('Missing value: '+key);}
if(!options['--ual1']||!options['--ual2'])throw Error('Usage: node scripts/export-ual-libraries.mjs --ual1 UAL1.blend --ual2 UAL2.blend [--output directory] [--blender executable] [--inventory-only] [--action exact-name]');
const scripts=path.dirname(fileURLToPath(import.meta.url)),output=path.resolve(options['--output']||path.join(scripts,'../assets/ual-library')),blender=options['--blender']||'/Applications/Blender.app/Contents/MacOS/Blender';
mkdirSync(output,{recursive:true});mkdirSync(path.join(output,'logs'),{recursive:true});
function atomic(file,data){const dest=path.join(output,file);writeFileSync(dest+'.pending',JSON.stringify(data,null,2)+'\n');renameSync(dest+'.pending',dest);}
function run(executable,argv,log){return new Promise((resolve,reject)=>{
 const child=spawn(executable,argv,{stdio:['ignore','pipe','pipe']});let outputText='';
 const collect=data=>{outputText+=data;if(outputText.length>64*1024*1024)child.kill('SIGTERM');};child.stdout.on('data',collect);child.stderr.on('data',collect);
 child.on('error',error=>{writeFileSync(path.join(output,'logs',log),outputText+error.stack);reject(error);});
 child.on('close',(code,signal)=>{writeFileSync(path.join(output,'logs',log),outputText);if(code!==0)reject(Error(`${log}: ${signal||'exit '+code}`));else resolve();});
});}
const workers=Number(options['--workers']||1);if(!Number.isInteger(workers)||workers<1||workers>4)throw Error('--workers must be 1–4');

const inventory=[];
for(const library of [1,2]){
 const source=path.resolve(options['--ual'+library]),sourceSHA256=createHash('sha256').update(readFileSync(source)).digest('hex'),file=path.join(output,`ual${library}-actions.json`);
 await run(blender,['--background','--disable-autoexec',source,'--python-exit-code','1','--python',path.join(scripts,'list-ual-actions.py'),'--',file],`ual${library}-discovery.log`);
 for(const action of JSON.parse(readFileSync(file)))inventory.push({library,source,sourceSHA256,...action});
}
atomic('inventory.json',inventory);
console.log(`Discovered ${inventory.length} actions, ${inventory.reduce((n,a)=>n+a.frames,0)} frames across UAL1 and UAL2.`);
if(options['--inventory-only'])process.exit(0);
// A changed pipeline or source invalidates resume entries, rather than silently
// accepting older exports which predate a correction to the fitting process.
const pipeline=createHash('sha256');for(const file of readdirSync(scripts).filter(n=>/\.(py|mjs)$/.test(n)).sort()){pipeline.update(file);pipeline.update(readFileSync(path.join(scripts,file)));}
function hashTree(directory){for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,entry.name);if(entry.isDirectory())hashTree(file);else{pipeline.update(path.relative(scripts,file));pipeline.update(readFileSync(file));}}}
hashTree(path.join(scripts,'../src'));pipeline.update(String(Boolean(options['--render'])));
const pipelineSHA256=pipeline.digest('hex'),report={pipelineSHA256,started:new Date().toISOString(),actions:[]};
const previous=existsSync(path.join(output,'batch-report.json'))?JSON.parse(readFileSync(path.join(output,'batch-report.json'))):null;
atomic('catalog.json',[]);
const requested=inventory.filter(a=>!options['--action']||a.name===options['--action']);if(!requested.length)throw Error('No matching action');
async function processAction(action){
 const id=`ual${action.library}-${encodeURIComponent(action.name)}`,directory=path.join(output,id),log=id+'.log';
 const old=previous?.pipelineSHA256===pipelineSHA256?previous.actions.find(a=>a.id===id&&a.sourceSHA256===action.sourceSHA256&&a.status==='verified'):null;
 if(old?.artifactSHA256&&Object.entries(old.artifactSHA256).every(([f,hash])=>existsSync(path.join(directory,f))&&createHash('sha256').update(readFileSync(path.join(directory,f))).digest('hex')===hash)){old.floorSupport=supportFor(directory);old.floorReady=old.floorSupport.floorReady;report.actions.push(old);console.log('Reused verified '+id);return;}
 const row={...action,id,directory,status:'running'};report.actions.push(row);atomic('batch-report.json',report);
 try{
  mkdirSync(directory,{recursive:true});
  // Fit once per source skeleton, then reuse its exact binding for every action.
  const binding=path.join(output,`ual${action.library}-binding.json`);
  if(existsSync(binding))copyFileSync(binding,path.join(directory,'binding.json'));
  await run(process.execPath,[path.join(scripts,'export-ual-fit.mjs'),action.source,action.name,directory,blender],log);
  copyFileSync(path.join(directory,'binding.json'),binding);
  if(options['--render'])await run(blender,['--background','--disable-autoexec',path.join(directory,'comparison.blend'),'--python-exit-code','1','--python',path.join(scripts,'render-ual-comparison.py'),'--',path.join(directory,'review')],id+'-renders.log');
  const {records,...comparison}=JSON.parse(readFileSync(path.join(directory,'numerical-comparison.json')));row.comparison=comparison;row.floorSupport=supportFor(directory);row.floorReady=row.floorSupport.floorReady;
  row.artifactSHA256=Object.fromEntries(readdirSync(directory,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>[e.name,createHash('sha256').update(readFileSync(path.join(directory,e.name))).digest('hex')]));
  row.status='verified';console.log(`Verified ${id}: ${row.frames} frames, both feet, all bones and vertices.`);
 }catch(error){row.status='failed';row.error=error.message;console.error(`FAILED ${id}; see logs/${log}`);}
 atomic('batch-report.json',report);
 // The catalog contains only verified results from this run. Failed or stale
 // clips stay out even when an older directory happens to exist on disk.
 atomic('catalog.json',report.actions.filter(a=>a.status==='verified'&&a.floorReady).map(a=>({id:a.id,library:a.library,name:a.name,range:[a.start,a.end],directory:path.relative(output,a.directory),rig:'makehuman-ual65-v2'})));
}
let next=0;await Promise.all(Array.from({length:workers},async()=>{while(next<requested.length){const action=requested[next++];await processAction(action);}}));
report.finished=new Date().toISOString();report.verified=report.actions.filter(a=>a.status==='verified').length;report.failed=report.actions.filter(a=>a.status==='failed').length;atomic('batch-report.json',report);
const support=auditSupport(output);console.log(`${report.verified} reproduced; ${support.floorReadyActions} floor-ready; ${support.requiresSceneContextActions} require scene context; ${report.failed} failed. Report: ${path.join(output,'batch-report.json')}`);
if(report.failed)process.exitCode=1;
