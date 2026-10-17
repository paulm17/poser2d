#!/usr/bin/env python3
"""Run the same PoseStudio V2 pose transfer through sd.cpp then vpipe, sequentially."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HUB = Path.home() / '.cache/huggingface/hub'

def cached(repo, filename):
    paths = sorted((HUB / ('models--' + repo.replace('/', '--')) / 'snapshots').glob('*/' + filename))
    paths = [path for path in paths if path.is_file()]
    if not paths:
        raise FileNotFoundError(f'{repo}: {filename}')
    return paths[-1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['sd', 'vpipe', 'both'], default='both')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--pose', type=Path, default=ROOT / 'reclining-pose.png')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/posestudio-v2-reclining-256')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    pose = args.pose.resolve()
    avatar = Path('/Volumes/Data/Users/paul/scratch/awakenJesus/books/manga/source images/thepleroma/jesus/1_tunic.png')
    adapter = cached('MIUProject/VNCCS_PoseStudio_QI2.1', 'VNCCS_QI2_PoseStudioV2.safetensors')
    for path in [pose, avatar, adapter]:
        if not path.is_file():
            raise FileNotFoundError(path)
    sd = [str(ROOT / 'stable-diffusion.cpp/build/bin/sd-cli'),
          '--diffusion-model', str(cached('unsloth/Qwen-Image-2.1-Turbo-GGUF', 'qwen-image-2.1-turbo-Q4_K_M.gguf')),
          '--vae', str(cached('Comfy-Org/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors')),
          '--llm', str(cached('unsloth/Qwen3-VL-8B-Instruct-GGUF', 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf')),
          '--llm_vision', str(cached('unsloth/Qwen3-VL-8B-Instruct-GGUF', 'mmproj-F16.gguf')),
          '-r', str(pose), '-r', str(avatar), '--lora-model-dir', str(adapter.parent),
          '--lora-apply-mode', 'at_runtime', '--width', '256', '--height', '256',
          '--steps', '8', '--sigmas', 'qwen-image-2.1-turbo', '--cfg-scale', '1',
          '--sampling-method', 'euler', '--rng', 'cpu', '--params-backend', 'disk',
          '-v', '-p', 'Draw character from image2 <lora:VNCCS_QI2_PoseStudioV2:1>',
          '--seed', '42', '-o', str(out / 'sd-output.png')]
    pipeline = json.loads((ROOT / 'artifacts/vpipe-256-diagnosis/tunic-pose-first-07/pipeline.json').read_text())
    pipeline['id'] = 'posestudio-v2-reclining-turbo-256'
    for stage in pipeline['stages']:
        name, cfg = stage['id'], stage['config']
        if name == 'model-select':
            cfg['hf_dir'] = str(HUB / 'vpipe-prepared/Qwen-Image-2.1-Turbo-8bit')
        elif name == 'text-prompt':
            cfg['text'] = 'Draw character from image2'
        elif name == 'model-config':
            cfg['lora2'] = str(adapter)
            cfg['lora2_scale'] = 1.0
        elif name in ['load-ref-0', 'load-ref-1']:
            cfg['url'] = str(pose if name.endswith('0') else avatar)
        elif name.startswith('ref-resample-'):
            cfg.update(width=256, height=256, fit='stretch')
        elif name == 'save-image':
            cfg['path'] = str(out / 'vpipe-output.png')
    (out / 'pipeline.json').write_text(json.dumps(pipeline, indent=2))
    (out / 'config.json').write_text(json.dumps({'log': {'level': 'normal', 'delegate': 'stdout'}, 'db': {'path': str(out)}}))
    (out / 'sd-command.sh').write_text('#!/bin/sh\nexec ' + shlex.join(sd) + '\n')
    (out / 'settings.json').write_text(json.dumps({'adapter': str(adapter), 'pose': str(pose), 'avatar': str(avatar), 'prompt': 'Draw character from image2', 'size': [256,256], 'steps': 8, 'cfg': 1, 'seed': 42, 'lora_strength': 1, 'sd_quantization': 'Q4_K_M', 'vpipe_quantization': '8bit', 'execution': 'sequential'}, indent=2))
    if args.prepare_only:
        print(out, flush=True)
        return
    commands = {'sd': sd, 'vpipe': [str(ROOT / 'vpipe/build/apps/vpipe/vpipe'), '--config', str(out / 'config.json'), '--launch', str(out / 'pipeline.json')]}
    for engine in (['sd', 'vpipe'] if args.engine == 'both' else [args.engine]):
        print(f'Starting {engine}; log: {out / (engine + "-render.log")}', flush=True)
        with (out / (engine + '-render.log')).open('w') as log:
            result = subprocess.run(commands[engine], stdout=log, stderr=subprocess.STDOUT, cwd=ROOT)
        print(f'{engine} exited {result.returncode}', flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
        output = out / (engine + '-output.png')
        if not output.is_file():
            raise FileNotFoundError(output)
        print(f'Output: {output}', flush=True)

if __name__ == '__main__':
    main()
