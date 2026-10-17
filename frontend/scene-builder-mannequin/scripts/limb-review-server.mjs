import http from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../docs/ual-fit/limb-clearance/',import.meta.url);
http.createServer(async(req,res)=>{res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:5173');res.setHeader('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS'){res.end();return;}try{
 const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>50000000)throw Error('payload');chunks.push(c);}const d=JSON.parse(Buffer.concat(chunks));
 if(!['makehuman','legacy','legacy2'].includes(d.editor)||!Number.isInteger(d.frame)||d.frame<0||d.frame>60)throw Error('invalid capture');
 const dir=new URL(d.editor+'/',root);await mkdir(dir,{recursive:true});
 if(d.geometry)await writeFile(new URL(d.frame+'.json',dir),JSON.stringify(d.geometry));
 if(d.png)await writeFile(new URL(String(d.frame).padStart(3,'0')+'.png',dir),Buffer.from(d.png.split(',')[1],'base64'));
 if(d.metrics)await writeFile(new URL('comparison.json',dir),JSON.stringify(d.metrics,null,2));res.end('ok');
 }catch(e){res.writeHead(400);res.end(e.message);}}).listen(3006,'127.0.0.1',()=>console.log('Limb review sink on 3006'));
