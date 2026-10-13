#!/usr/bin/env python3
"""Download official Safetensors and prepare vpipe models in HF_HUB_CACHE."""
import argparse, json, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--cache', type=pathlib.Path, default=pathlib.Path('/Volumes/Data/Users/paul/.cache/huggingface/hub'))
p.add_argument('--skip-download', action='store_true')
a = p.parse_args()
cache = a.cache.resolve()
prepared = cache / 'vpipe-prepared'
prepared.mkdir(parents=True, exist_ok=True)
cli = ROOT / 'vpipe/build/apps/vpipe/vpipe'
def source(repo):
    if not a.skip_download:
        cmd=['hf','download',repo,'--cache-dir',str(cache)]
        if repo.endswith('Turbo'): cmd += ['--exclude','assets/*']
        subprocess.run(cmd,check=True)
    base=cache/('models--'+repo.replace('/','--'))
    revision=(base/'refs/main').read_text().strip()
    return base/'snapshots'/revision

def quant(src,out,bits,target):
    skip = True
    if target == 'all':
        try:
            names = json.loads((out/'model.safetensors.index.json').read_text())['weight_map']
            skip = 'lm_head.scales' in names
        except (OSError, KeyError, ValueError):
            skip = False
    config={'src_model':str(src),'output_name':str(out),'bits':bits,'group_size':64,'target':target,'skip_existing':skip}
    spec={'id':'prepare','subpipelines':[],'stages':[{'id':'quant','type':'model-quantize','config':config}]}
    recipe=prepared/(out.name+'.vpipeline')
    recipe.write_text(json.dumps(spec,indent=2))
    log=prepared/(out.name+'.log')
    with log.open('w') as f:
        subprocess.run([str(cli),'--config',json.dumps({'log':{'level':'normal','delegate':'stdout'},'db':{'path':str(prepared)}}),'--launch',str(recipe)],cwd=prepared,stdout=f,stderr=subprocess.STDOUT,check=True)
    cfg=out/('transformer/config.json' if target=='dit' else 'text_encoder/config.json' if target=='text_encoder' else 'config.json')
    data=json.loads(cfg.read_text())
    q=data.get('quantization',data.get('quantization_config',{}))
    if q.get('bits') != bits or q.get('group_size') != 64: raise RuntimeError(f'{out}: quantization did not complete, inspect {log}')
    component=cfg.parent
    index_file = component/'model.safetensors.index.json'
    if not index_file.exists(): index_file=component/'diffusion_pytorch_model.safetensors.index.json'
    index=json.loads(index_file.read_text())
    for shard in set(index['weight_map'].values()):
        if not (component/shard).is_file(): raise RuntimeError(f'{out}: missing shard {shard}')
    print(f'Prepared {out}',flush=True)

turbo=source('Qwen/Qwen-Image-2.1-Turbo')
pe=source('Qwen/Qwen-Image-2.1-PE-T2I')
enc=prepared/'Qwen-Image-2.1-Turbo-encoder-4bit'
quant(turbo,enc,4,'text_encoder')
for bits in (4,8):
    out=prepared/f'Qwen-Image-2.1-Turbo-{bits}bit'
    quant(enc,out,bits,'dit')
    # Share the prepared encoder physically and by path across both packs.
    # vpipe's component copier hard-links files, so no second tensor copy is needed.
quant(pe,prepared/'Qwen-Image-2.1-PE-T2I-4bit',4,'all')
(prepared/'sources.json').write_text(json.dumps({'turbo':str(turbo),'enhancer':str(pe),'group_size':64},indent=2))
