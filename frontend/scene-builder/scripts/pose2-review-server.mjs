import { createServer } from 'vite';
import { mkdir,writeFile } from 'node:fs/promises';
await mkdir('/tmp/pose2-review',{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:3002,strictPort:true},plugins:[{name:'pose2-review-output',configureServer(server){server.middlewares.use('/__pose2-review',async(req,res)=>{
 if(req.method!=='POST'){res.statusCode=405;res.end();return;}
 try{let body='';for await(const chunk of req){body+=chunk;if(body.length>20e6)throw Error('Too large');}const {name,data}=JSON.parse(body);if(!/^(comparison-\d+\.png|report\.json)$/.test(name))throw Error('Invalid output name');await writeFile('/tmp/pose2-review/'+name,name.endsWith('.png')?Buffer.from(data.split(',')[1],'base64'):JSON.stringify(data,null,2));res.end('ok');}catch(e){res.statusCode=400;res.end(e.message);}
 });}}]});await server.listen();console.log('Select Pose review: http://127.0.0.1:3002/scripts/pose2-review.html');
