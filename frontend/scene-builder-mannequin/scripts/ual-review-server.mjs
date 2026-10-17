/** Local-only image/report sink for ual-review.html. No arbitrary file paths. */
import http from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../docs/ual-fit/',import.meta.url);
http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:5173');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 try{
  if(req.method!=='POST')throw Error('POST required');
  const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4_000_000)throw Error('Payload too large');chunks.push(chunk);}
  const data=JSON.parse(Buffer.concat(chunks));const crawl=data.id==='ual1-Crawl_Bwd_Loop';if(data.id&&!['ual1-Crouch_Fwd_Loop','ual1-Crawl_Bwd_Loop'].includes(data.id))throw Error('Unknown review clip');const destination=crawl?new URL('crawl-audit/',root):root;
  if(req.url==='/frame'){
   if(!['front','side'].includes(data.view)||!Number.isInteger(data.frame)||data.frame<0||data.frame>(crawl?75:60)||!/^data:image\/png;base64,/.test(data.png))throw Error('Invalid comparison frame');
   const dir=new URL(`app/${data.view}/`,destination);await mkdir(dir,{recursive:true});await writeFile(new URL(`${String(data.frame).padStart(3,'0')}.png`,dir),Buffer.from(data.png.split(',')[1],'base64'));
  }else if(req.url==='/report'){
   await writeFile(new URL('browser-comparison.json',destination),JSON.stringify(data,null,2)+'\n');
  }else throw Error('Unknown endpoint');
  res.end('ok');
 }catch(error){res.writeHead(400);res.end(error.message);}
}).listen(3004,'127.0.0.1',()=>console.log('UAL comparison sink: http://127.0.0.1:3004'));
