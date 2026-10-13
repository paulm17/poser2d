#!/usr/bin/env python3
"""Prepare base Qwen 2.1 packs, sharing only verified identical Turbo weights."""
import argparse, json, pathlib, subprocess, urllib.request
parser = argparse.ArgumentParser()
parser.add_argument('--cache', type=pathlib.Path, default=pathlib.Path('/Volumes/Data/Users/paul/.cache/huggingface/hub'))
parser.add_argument('--skip-download', action='store_true')
args = parser.parse_args()
cache = args.cache.resolve()
prepared = cache / 'vpipe-prepared'
prepared.mkdir(parents=True, exist_ok=True)
cli = pathlib.Path(__file__).resolve().parents[1] / 'vpipe/build/apps/vpipe/vpipe'
def manifest(repo):
    with urllib.request.urlopen('https://huggingface.co/api/models/' + repo + '?blobs=true') as r:
        return json.load(r)
base = manifest('Qwen/Qwen-Image-2.1')
turbo = manifest('Qwen/Qwen-Image-2.1-Turbo')
turbo_files = {f['rfilename']: f for f in turbo['siblings']}
turbo_root = cache / 'models--Qwen--Qwen-Image-2.1-Turbo'
turbo_snapshot = turbo_root / 'snapshots' / (turbo_root / 'refs/main').read_text().strip()
shared = []
needed = []
for f in base['siblings']:
    name = f['rfilename']
    if not (name.startswith(('transformer/', 'text_encoder/', 'vae/', 'processor/', 'scheduler/')) or name == 'model_index.json'): continue
    other = turbo_files.get(name, {})
    identity = f.get('lfs', {}).get('sha256', f.get('blobId'))
    same = identity == other.get('lfs', {}).get('sha256', other.get('blobId'))
    if not name.startswith(('transformer/', 'scheduler/')) and same and (turbo_snapshot / name).is_file(): shared.append(name)
    else: needed.append(name)
if not args.skip_download:
    subprocess.run(['hf', 'download', 'Qwen/Qwen-Image-2.1', '--revision', base['sha'], '--cache-dir', str(cache), *needed], check=True)
base_root = cache / 'models--Qwen--Qwen-Image-2.1'
snapshot = base_root / 'snapshots' / base['sha']
for name in shared:
    dst = snapshot / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists(): dst.symlink_to(turbo_snapshot / name)
(base_root / 'refs').mkdir(exist_ok=True)
(base_root / 'refs/main').write_text(base['sha'])
if not args.skip_download:
    subprocess.run(['hf', 'download', 'lightx2v/Qwen-Image-2.1-Lightning', 'pytorch_lora_weights.safetensors', '--cache-dir', str(cache)], check=True)
def quant(src, out, bits, target):
    recipe = prepared / (out.name + '.vpipeline')
    recipe.write_text(json.dumps({'id':'prepare', 'subpipelines':[], 'stages':[{'id':'quant', 'type':'model-quantize', 'config':{'src_model':str(src), 'output_name':str(out), 'bits':bits, 'group_size':64, 'target':target, 'skip_existing':True}}]}))
    with (prepared / (out.name + '.log')).open('w') as log:
        subprocess.run([str(cli), '--config', json.dumps({'log':{'level':'normal','delegate':'stdout'},'db':{'path':str(prepared)}}), '--launch', str(recipe)], cwd=prepared, stdout=log, stderr=subprocess.STDOUT, check=True)
    cfg = out / ('text_encoder/config.json' if target == 'text_encoder' else 'transformer/config.json')
    quantization = json.loads(cfg.read_text())['quantization']
    if quantization.get('bits') != bits or quantization.get('group_size') != 64:
        raise RuntimeError(f'{out}: quantization is incomplete')
    component = cfg.parent
    index = component / 'model.safetensors.index.json'
    if not index.exists(): index = component / 'diffusion_pytorch_model.safetensors.index.json'
    for shard in set(json.loads(index.read_text())['weight_map'].values()):
        if not (component / shard).is_file(): raise RuntimeError(f'{out}: missing {shard}')
enc = prepared / 'Qwen-Image-2.1-encoder-4bit'
quant(snapshot, enc, 4, 'text_encoder')
for bits in (8,4):
    out = prepared / f'Qwen-Image-2.1-{bits}bit'
    quant(enc, out, bits, 'dit')
    print('Prepared', out, flush=True)
print('Verified shared files:', shared, flush=True)

subprocess.run(['python3', str(pathlib.Path(__file__).with_name('normalize-lightning-lora.py')), '--cache', str(cache)], check=True)

(prepared / 'base-sources.json').write_text(json.dumps({'base_revision':base['sha'], 'base_snapshot':str(snapshot), 'shared_files':shared, 'downloaded_files':needed, 'group_size':64}, indent=2))
