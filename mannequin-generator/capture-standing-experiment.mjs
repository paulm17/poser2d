import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Volumes/Data/Users/paul/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1100,height:1100},deviceScaleFactor:1});
 page.on('pageerror',e=>console.error(e.message));
 await page.goto(process.env.EXPERIMENT_URL || 'http://127.0.0.1:8771/standing-experiment.html');
 await page.waitForFunction(()=>window.standingExperiment||window.standingExperimentError,{},{timeout:120000});
 const result=await page.evaluate(()=>({result:window.standingExperiment,error:window.standingExperimentError}));
 if(result.error)throw Error(result.error);
 const out=path.join(path.dirname(fileURLToPath(import.meta.url)),'standing-experiment-output');await fs.mkdir(out,{recursive:true});
 for(const key of ['control','experimental'])await fs.writeFile(path.join(out,`standing-${key}.png`),Buffer.from(result.result[key].split(',')[1],'base64'));
 await fs.writeFile(path.join(out,'verification.json'),JSON.stringify(result.result.report,null,2)+'\n');
 console.log(JSON.stringify(result.result.report,null,2));
} finally {await browser.close();}
