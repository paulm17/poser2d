/** Distinguish exact motion reproduction from safe placement on a flat floor. */
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function supportFor(directory){
 const report=JSON.parse(readFileSync(path.join(directory,'numerical-comparison.json')));
 if(!report.pass||report.records.length!==report.frames)throw Error('Incomplete comparison: '+directory);
 const below=report.records.filter(frame=>frame.bodyMinimumMetres<-.0001);
 return {floorReady:below.length===0,minimumVisibleSkinYMetres:Math.min(...report.records.map(frame=>frame.bodyMinimumMetres)),belowFloorFrames:below.map(frame=>frame.frame),planeFrames:report.records.filter(frame=>frame.groundPolicy==='plane').length,rootClearanceFrames:report.records.filter(frame=>frame.groundPolicy==='root-clearance').length,sourceContextFrames:report.records.filter(frame=>frame.groundPolicy==='source-context').length,reason:below.length?'Visible skin crosses the default floor and requires correction.':null};
}
export function auditSupport(output){
 const read=file=>JSON.parse(readFileSync(path.join(output,file))),write=(file,data)=>writeFileSync(path.join(output,file),JSON.stringify(data,null,2)+'\n');
 const batch=read('batch-report.json'),all=[],contexts=[];let frames=0;
 for(const action of batch.actions){
  if(action.status!=='verified')continue;
  action.floorSupport=supportFor(path.join(output,action.id));action.floorReady=action.floorSupport.floorReady;frames+=action.frames;
  const entry={id:action.id,library:action.library,name:action.name,range:[action.start,action.end],directory:action.id,rig:'makehuman-ual65-v2',floorReady:action.floorReady};all.push(entry);
  if(!action.floorReady)contexts.push({...entry,...action.floorSupport});
 }
 const summary={version:1,positionToleranceMetres:.0001,numericallyReproducedActions:all.length,numericallyReproducedFrames:frames,floorReadyActions:all.length-contexts.length,requiresSceneContextActions:contexts.length,conversionFailures:batch.actions.filter(action=>action.status==='failed').map(action=>({id:action.id,error:action.error})),contexts};
 batch.floorSupportSummary=summary;write('batch-report.json',batch);write('all-reproduced-catalog.json',all);write('context-catalog.json',contexts);write('catalog.json',all.filter(action=>action.floorReady));write('floor-support-report.json',summary);return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(auditSupport(path.resolve(process.argv[2])),null,2));
