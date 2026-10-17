#!/usr/bin/env python3
"""Generate Gaussian splats from one or more images using the app's TripoSplat bridge."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images', type=Path, nargs='+')
    parser.add_argument('--output-dir', type=Path, default=HERE / 'outputs/splats')
    parser.add_argument('--source', type=Path, default=Path(os.environ.get('TRIPOSPLAT_SOURCE', ROOT.parent / 'TripoSplat')))
    parser.add_argument('--python', type=Path, default=None)
    parser.add_argument('--model-dir', type=Path, default=os.environ.get('TRIPOSPLAT_MODEL_DIR'))
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--steps', type=int, default=20)
    parser.add_argument('--guidance', type=float, default=3.0)
    parser.add_argument('--num-gaussians', type=int, default=32768)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if args.steps < 1 or not math.isfinite(args.guidance) or args.guidance < 0:
        parser.error('steps must be positive and guidance finite and nonnegative')
    if not 32768 <= args.num_gaussians <= 262144 or args.num_gaussians % 32:
        parser.error('num-gaussians must be a multiple of 32 from 32768 to 262144')
    images = [p.expanduser().resolve(strict=True) for p in args.images]
    if len({p.stem for p in images}) != len(images):
        parser.error('Input image stems must be unique')
    source = args.source.expanduser().resolve(strict=True)
    bridge = ROOT / 'vpipe/examples/triposplat'
    python = args.python or os.environ.get('TRIPOSPLAT_PYTHON')
    python = Path(python) if python else (bridge / '.venv/bin/python' if (bridge / '.venv/bin/python').is_file() else source / '.venv/bin/python')
    python = python.expanduser().absolute()
    models = args.model_dir
    if models is None:
        cache = Path.home() / '.cache/huggingface/hub/models--VAST-AI--TripoSplat'
        models = cache / 'snapshots' / (cache / 'refs/main').read_text().strip()
    models = Path(models).expanduser().resolve(strict=True)
    required = [python, bridge / 'run.py', source / 'model.py', source / 'triposplat.py']
    required += [models / p for p in ['clip_vision/dino_v3_vit_h.safetensors', 'vae/flux2-vae.safetensors', 'diffusion_models/triposplat_fp16.safetensors', 'vae/triposplat_vae_decoder_fp16.safetensors']]
    for p in required:
        if not p.is_file():
            raise ValueError(f'Missing dependency: {p}')
    env = dict(os.environ)
    env.pop('PYTORCH_ENABLE_MPS_FALLBACK', None)
    # Validate every input before starting the sequential jobs.
    subprocess.run([str(python), '-c', "from PIL import Image; import sys; [Image.open(p).verify() for p in sys.argv[1:]]", *map(str, images)], check=True, env=env)
    # Generated Qwen RGBA images can have alpha 239..255 without an actual
    # transparent background. The bridge otherwise mistakes that for a cutout.
    inspection = subprocess.run([str(python), '-c',
        "from PIL import Image; import sys,json; out=[]\nfor p in sys.argv[1:]:\n im=Image.open(p); a=im.getchannel('A') if im.mode=='RGBA' else None; out.append({'path':p,'normalize_opaque': a is not None and a.getextrema()[0]>=230})\nprint(json.dumps(out))",
        *map(str, images)], check=True, env=env, capture_output=True, text=True)
    inspections = json.loads(inspection.stdout)
    if any(item['normalize_opaque'] for item in inspections) and not (models/'background_removal/birefnet.safetensors').is_file():
        raise ValueError('Opaque inputs need background_removal/birefnet.safetensors')
    for image, inspected in zip(images, inspections):
        output = args.output_dir.expanduser().absolute() / image.stem
        bridge_input = image
        if inspected['normalize_opaque'] and not args.prepare_only:
            prepared = output/'input'/image.name
            prepared.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([str(python), '-c', "from PIL import Image; import sys; Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2])", str(image), str(prepared)], check=True, env=env)
            bridge_input = prepared
        command = [str(python), str(bridge / 'run.py'), str(bridge_input), '--triposplat-source', str(source), '--model-dir', str(models), '--output-dir', str(output), '--seed', str(args.seed), '--steps', str(args.steps), '--guidance', str(args.guidance), '--num-gaussians', str(args.num_gaussians)]
        print(json.dumps(command), flush=True)
        if args.prepare_only:
            continue
        output.mkdir(parents=True, exist_ok=True)
        (output / 'input.json').write_text(json.dumps({'source':str(image),'bridge_input':str(bridge_input),'opaque_alpha_normalized':inspected['normalize_opaque']},indent=2)+'\n')
        (output / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
        with (output / 'render.log').open('w') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=ROOT)
        report = output / (image.stem + '.streaming.json')
        status = json.loads(report.read_text()) if report.is_file() else {}
        if result.returncode or status.get('status') != 'complete':
            print((output / 'render.log').read_text(errors='replace')[-6000:], file=sys.stderr)
            raise ValueError(f'TripoSplat failed for {image}; see {output / "render.log"}')
        for suffix in ['.ply', '.splat']:
            if not (output / (image.stem + suffix)).is_file():
                raise ValueError(f'Missing export: {suffix}')
        print(f'Completed: {output}', flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'Error: {error}')
