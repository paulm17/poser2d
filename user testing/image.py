#!/usr/bin/env python3
"""Run local vpipe Qwen 2.1 image editing with optional AnyAngle."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from run import HERE, ROOT, HUB, cached, png_size, write_json, build_vpipe_pipeline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, action='append', required=True, help='Ordered image reference; repeat for image2, image3, etc.')
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--anyangle', action='store_true')
    parser.add_argument('--anyangle-strength', type=float, default=1.0)
    parser.add_argument('--anyangle-lora', type=Path)
    parser.add_argument('--width', type=int, default=704)
    parser.add_argument('--height', type=int, default=512)
    parser.add_argument('--vae-tile', type=int, help='Optional VAE tile size in latent cells; default uses the engine automatic policy')
    parser.add_argument('--fit', choices=['stretch','contain'], default='stretch')
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--cfg', type=float, default=1.0)
    parser.add_argument('--model', type=Path, default=HUB / 'vpipe-prepared/Qwen-Image-2.1-Turbo-8bit')
    parser.add_argument('--output-dir', type=Path, default=HERE / 'outputs/scene-anyangle')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if any(n < 256 or n > 4096 or n % 32 for n in (args.width,args.height)):
        parser.error('Dimensions must be multiples of 32 between 256 and 4096')
    if not 2 <= len(args.reference) <= 10:
        parser.error('Provide 2–10 ordered references')
    if not 1 <= args.steps <= 200 or not 0 <= args.seed <= 2147483647:
        parser.error('Invalid steps or seed')
    if not math.isfinite(args.cfg) or not 1 <= args.cfg <= 10:
        parser.error('CFG must be finite and between 1 and 10')
    if not math.isfinite(args.anyangle_strength) or not 0 <= args.anyangle_strength <= 2:
        parser.error('AnyAngle strength must be finite and between 0 and 2')
    refs = [p.expanduser().resolve(strict=True) for p in args.reference]
    model = args.model.expanduser().resolve(strict=True)
    for name in ['model_index.json','transformer/config.json','text_encoder/config.json','vae/config.json']:
        if not (model/name).is_file(): raise ValueError(f'Missing model component: {model/name}')
    cli = ROOT/'vpipe/build/apps/vpipe/vpipe'
    if not os.access(cli,os.X_OK):raise ValueError(f'Missing executable: {cli}')
    adapter = (args.anyangle_lora.expanduser().resolve(strict=True) if args.anyangle_lora else cached('lilylilith/QI_2.1_AnyAngle','QI2.1_AnyAngle.safetensors')) if args.anyangle else None
    cfg = 3.0 if args.anyangle else args.cfg
    out = args.output_dir.expanduser().absolute();out.mkdir(parents=True,exist_ok=True)
    prepared_refs=[]
    for i,ref in enumerate(refs):
        prepared=out/f'reference-{i+1}.png'
        if args.fit=='contain':
            sw,sh=png_size(ref);ratio=min(args.width/sw,args.height/sh)
            rw,rh=max(1,round(sw*ratio)),max(1,round(sh*ratio))
            subprocess.run(['/usr/bin/sips','-s','format','png','-z',str(rh),str(rw),str(ref),'--out',str(prepared)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            subprocess.run(['/usr/bin/sips','-p',str(args.height),str(args.width),'--padColor','1a1a1a',str(prepared),'--out',str(prepared)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        else:
            subprocess.run(['/usr/bin/sips','-s','format','png','-z',str(args.height),str(args.width),str(ref),'--out',str(prepared)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if png_size(prepared)!=(args.width,args.height):raise ValueError('Input resize failed')
        prepared_refs.append(prepared)
    template=build_vpipe_pipeline(
        model, args.prompt, prepared_refs, args.width, args.height, out/'output.png',
        adapters={'lora3':str(adapter),'lora3_scale':args.anyangle_strength} if adapter else {},
        cfg=cfg, steps=args.steps, seed=args.seed, pipeline_id='scene-edit')
    write_json(out/'pipeline.json',template);write_json(out/'config.json',{'log':{'level':'normal','delegate':'stdout'},'db':{'path':str(out)}})
    command=[str(cli),'--launch',str(out/'pipeline.json'),'--config',str(out/'config.json')]
    write_json(out/'manifest.json',{'references':list(map(str,refs)),'fit':args.fit,'model':str(model),'anyangle':str(adapter) if adapter else None,'strength':args.anyangle_strength if adapter else None,'cfg':cfg,'width':args.width,'height':args.height,'steps':args.steps,'seed':args.seed,'prompt':args.prompt,'command':command})
    if args.prepare_only:print(f'Prepared {out}; CFG {cfg}; no inference');return 0
    (out/'output.png').unlink(missing_ok=True)
    env=dict(os.environ)
    if args.vae_tile is not None:
        if args.vae_tile<=0:raise ValueError('vae-tile must be positive')
        env['VPIPE_VAE_TILE']=str(args.vae_tile)
    print(f'Rendering {args.width}x{args.height}, AnyAngle={bool(adapter)}, CFG={cfg}',flush=True)
    with (out/'render.log').open('w') as log:r=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,env=env,cwd=ROOT)
    log=(out/'render.log').read_text(errors='replace')
    if r.returncode or not (out/'output.png').is_file():raise ValueError(f'Generation failed; see {out / "render.log"}\n{log[-4000:]}')
    if '[WARN] LoadImageStage' in log or 'dropping the partial list' in log:raise ValueError('Reference loading failed; output is invalid')
    if adapter and ('192 modules at scale' not in log or 'true CFG 3' not in log):raise ValueError('Could not verify AnyAngle binding and CFG 3; inspect render.log')
    if png_size(out/'output.png')!=(args.width,args.height):raise ValueError('Unexpected output size')
    print(f'Saved: {out / "output.png"}')
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,subprocess.CalledProcessError) as e:sys.exit(f'Error: {e}')
