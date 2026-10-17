/** Local-only, fixed clip whitelist for repaired-frame evidence. */
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../docs/ual-fit/floor-repair/',import.meta.url),assets=new URL('../assets/ual-library/',import.meta.url);
const repair=JSON.parse(readFileSync(new URL('floor-repair-report.json',assets))),batch=JSON.parse(readFileSync(new URL('batch-report.json',assets)));
const catalog=new Set(JSON.parse(readFileSync(new URL('catalog.json',assets))).map(entry=>entry.id));
const ranges=new Map(repair.actions.map(action=>[action.id,batch.actions.find(row=>row.id===action.id)]));
http.createServer(async(req,res)=>{res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:5173');res.setHeader('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
try{if(req.method!=='POST')throw Error('POST required');const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4000000)throw Error('Payload too large');chunks.push(chunk);}const data=JSON.parse(Buffer.concat(chunks));await mkdir(root,{recursive:true});
if(req.url==='/thumbnail'){if(!catalog.has(data.id)||!/^data:image\/png;base64,/.test(data.png))throw Error('Invalid thumbnail');await writeFile(new URL(data.id+'/'+data.id+'.png',assets),Buffer.from(data.png.split(',')[1],'base64'));}
else if(req.url==='/summary'){if(!data.clips?.every(row=>ranges.has(row.id)))throw Error('Unknown clip');await writeFile(new URL('browser-comparison.json',root),JSON.stringify(data,null,2)+'\n');}
else{const range=ranges.get(data.id);if(!range)throw Error('Unknown clip');const directory=new URL(data.id+'/',root);await mkdir(directory,{recursive:true});
if(req.url==='/frame'){if(!['front','side'].includes(data.view)||!Number.isInteger(data.frame)||data.frame<range.start||data.frame>range.end||!/^data:image\/png;base64,/.test(data.png))throw Error('Invalid frame');const dir=new URL('app/'+data.view+'/',directory);await mkdir(dir,{recursive:true});await writeFile(new URL(String(data.frame).padStart(3,'0')+'.png',dir),Buffer.from(data.png.split(',')[1],'base64'));}
else if(req.url==='/report')await writeFile(new URL('browser-comparison.json',directory),JSON.stringify(data,null,2)+'\n');else throw Error('Unknown route');}res.end('ok');
}catch(error){res.writeHead(400);res.end(error.message);}}).listen(3005,'127.0.0.1',()=>console.log('Floor repair evidence sink: http://127.0.0.1:3005'));
