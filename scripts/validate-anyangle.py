#!/usr/bin/env python3
import copy, hashlib, json, os, pathlib, re, struct, subprocess, time
ROOT=pathlib.Path(__file__).resolve().parents[1]
import argparse
parser=argparse.ArgumentParser(description="Compare AnyAngle with the vpipe Qwen 2.1 CLI at true CFG 3.")
parser.add_argument("pose", type=pathlib.Path)
parser.add_argument("avatar", type=pathlib.Path)
parser.add_argument("--cache", type=pathlib.Path, default=pathlib.Path.home()/".cache/huggingface/hub")
parser.add_argument("--output", type=pathlib.Path, default=ROOT/"artifacts/anyangle-cli-tests")
parser.add_argument("--cli", type=pathlib.Path, default=ROOT/"vpipe/build/apps/vpipe/vpipe")
parser.add_argument("--filter", help="Comma-separated job names")
parser.add_argument("--prepare-only", action="store_true")
parser.add_argument("--resume", action="store_true", help="Skip previously successful jobs with identical pipelines")
args=parser.parse_args()
OUT=args.output.resolve();OUT.mkdir(parents=True,exist_ok=True)
HUB=args.cache.resolve();POSE=args.pose.resolve(strict=True);AVATAR=args.avatar.resolve(strict=True)
repo=HUB/"models--lilylilith--QI_2.1_AnyAngle"
revision=(repo/"refs/main").read_text().strip()
ADAPTER=repo/"snapshots"/revision/"QI2.1_AnyAngle.safetensors"
pose_repo=HUB/"models--MIUProject--VNCCS_PoseStudio_QI2.1"
pose_candidates=sorted((pose_repo/"snapshots").glob("*/VNCCS_QI2_PoseStudioV1.1.safetensors"))
if len(pose_candidates)!=1:
 raise SystemExit("Expected one cached PoseStudio V1.1 adapter for the stacking test")
POSE_ADAPTER=pose_candidates[0]
def port(src, output=0):return {"src":src,"oport":output}
def stage(name, kind, inputs, config):return {"id":name,"type":kind,"iports":inputs,"config":config}
TEMPLATE={"id":"anyangle","subpipelines":[],"stages":[
 stage("model-select","model-select",[],{}),
 stage("text-prompt","text-prompt",[],{}),
 stage("model-config","qwen-image-21-model-config",[],{}),
]}
for i in range(2):
 TEMPLATE["stages"] += [
  stage(f"load-ref-{i}","load-image",[],{}),
  stage(f"ref-resample-{i}","image-resample",[port(f"load-ref-{i}")],{"width":1024,"height":1024,"fit":"pad","algorithm":"lanczos"})]
TEMPLATE["stages"] += [
 stage("ref-list","tensor-list",[port("ref-resample-0"),port("ref-resample-1")],{}),
 stage("vae-encode","vae-encode",[port(""),port("model-select"),port("ref-list")],{"unload_when_idle":"always"}),
 stage("diffusion-conditioner","diffusion-conditioner",[port("text-prompt"),port(""),port("model-select"),port(""),port(""),port("model-config"),port("ref-list")],{"unload_when_idle":"always"}),
 stage("generate-image","generate-image",[port("diffusion-conditioner"),port(""),port("model-select"),port(""),port(""),port(""),port(""),port("model-config"),port("vae-encode",1)],{"unload_when_idle":"always"}),
 stage("save-latent","save-tensor",[port("generate-image")],{}),
 stage("vae-decode","vae-decode",[port("generate-image"),port("model-select")],{"unload_when_idle":"always"}),
 stage("save-image","save-image",[port("vae-decode")],{"format":"png","compression":6}),
]
def dims(p):
 with open(p,'rb') as f: header=f.read(24)
 if len(header)!=24 or header[:8]!=b'\x89PNG\r\n\x1a\n':
  raise ValueError(f'Expected a PNG image: {p}')
 return struct.unpack('>II',header[16:24])
w,h=dims(POSE); height=736; width=round(height*w/h/32)*32
jobs=[(f'turbo-s{seed}-{tag}',True,seed,strength,False) for seed in (42,43) for tag,strength in [('none',None),('angle1',1.0),('angle07',0.7)]]
jobs += [('base-s42-none',False,42,None,False),('base-s42-angle1',False,42,1.0,False),('turbo-s42-angle1-pose07',True,42,1.0,True)]
manifest={'adapter':str(ADAPTER),'revision':ADAPTER.parent.name,'adapter_sha256':hashlib.file_digest(ADAPTER.open('rb'), 'sha256').hexdigest(),'pose':str(POSE),'avatar':str(AVATAR),'pose_dimensions':dims(POSE),'output_dimensions':[width,height],'prompt':'Change the camera angle from <image2> to <image1>.','cfg':3,'negative':'empty image-grounded conditioning','vae_tile':32,'jobs':[j[0] for j in jobs]}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
results=json.loads((OUT/'results.json').read_text()) if (OUT/'results.json').exists() else []
for name,turbo,seed,strength,stack in jobs:
 d=OUT/name; d.mkdir(exist_ok=True)
 p=copy.deepcopy(TEMPLATE);p['id']=name
 stages={s['id']:s for s in p['stages']}
 stages['model-select']['config']['hf_dir']=str(HUB/'vpipe-prepared'/('Qwen-Image-2.1-Turbo-8bit' if turbo else 'Qwen-Image-2.1-8bit'))
 stages['text-prompt']['config']['text']=manifest['prompt']
 cfg={'use_kv_cache':True}
 if strength is not None:cfg.update(lora=str(ADAPTER),lora_scale=strength)
 if stack:cfg.update(lora2=str(POSE_ADAPTER),lora2_scale=0.7)
 stages['model-config']['config']=cfg
 for i,path in enumerate([POSE,AVATAR]):stages[f'load-ref-{i}']['config']['url']=str(path)
 stages['diffusion-conditioner']['config']['grounded_negative']=True
 stages['generate-image']['iports'][1]={'src':'diffusion-conditioner','oport':1}
 stages['generate-image']['config'].update(width=width,height=height,seed=seed,steps=8 if turbo else 20,guidance_scale=3.0)
 stages['save-image']['config']['path']=str(d/'output.png')
 stages['save-latent']['config']['path']=str(d/'latent.vpt')
 pipeline_text=json.dumps(p,indent=2)
 identical=(d/'pipeline.json').exists() and json.loads((d/'pipeline.json').read_text())==p
 (d/'pipeline.json').write_text(pipeline_text)
 (d/'config.json').write_text(json.dumps({'log':{'level':'normal','delegate':'stdout'},'db':{'path':str(d)}}))
 if args.prepare_only:continue
 if args.filter and name not in args.filter.split(','):continue
 if args.resume and identical and (d/'result.json').exists() and (d/'output.png').exists() and json.loads((d/'result.json').read_text()).get('passed'):
  print('Already passed',name,flush=True);continue
 if (d/'output.png').exists(): (d/'output.png').unlink()
 print('Running',name,flush=True);start=time.monotonic()
 with (d/'render.log').open('w') as log:
  proc=subprocess.run(['/usr/bin/time','-l',str(args.cli.resolve()),'--launch',str(d/'pipeline.json'),'--config',str(d/'config.json')],stdout=log,stderr=subprocess.STDOUT,env={**os.environ,"VPIPE_VAE_TILE":"32"})
 log=(d/'render.log').read_text();img=d/'output.png'
 binds=re.findall(r"runtime LoRA '([^']+)' -- (\d+) modules at scale ([\d.]+)",log)
 expected=1 if strength is not None else 0
 if stack:expected+=1
 valid=proc.returncode==0 and img.exists() and dims(img)==(width,height) and len(binds)==expected and all(int(b[1])==192 for b in binds)
 # CFG invokes both 32-block branches on each denoising step.
 cfg_verified='true CFG 3' in log and f'/{(8 if turbo else 20)*32*2})' in log
 result={'name':name,'exit_code':proc.returncode,'elapsed_seconds':time.monotonic()-start,'bindings':binds,'cfg_verified':cfg_verified,'dimensions':dims(img) if img.exists() else None,'passed':valid and cfg_verified,'peak_rss_bytes':re.findall(r'(\d+)\s+maximum resident set size',log)}
 (d/'result.json').write_text(json.dumps(result,indent=2));results=[r for r in results if r['name']!=name];results.append(result)
 (OUT/'results.json').write_text(json.dumps(results,indent=2)); print(json.dumps(result),flush=True)
 if not result['passed']:raise SystemExit('Validation failed: '+name)
