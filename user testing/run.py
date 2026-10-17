#!/usr/bin/env python3
"""Run Qwen Image 2.1 Turbo + VNCCS PoseStudio on vpipe and/or stable-diffusion.cpp."""
import argparse
import json
import math
import os
import re
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
HUB = Path(os.environ.get('HF_HUB_CACHE', Path.home() / '.cache/huggingface/hub'))


def cached(repo, name):
    base = HUB / ('models--' + repo.replace('/', '--'))
    revision = base / 'refs/main'
    candidates = ([base / 'snapshots' / revision.read_text().strip() / name]
                  if revision.is_file() else [])
    candidates += sorted((base / 'snapshots').glob('*/' + name), reverse=True)
    for path in candidates:
        if path.is_file():
            return path.absolute()  # Keep the filename: sd.cpp resolves LoRAs by stem.
    raise ValueError(f'Missing cached model: {repo}/{name} (cache: {HUB})')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def png_size(path):
    with path.open('rb') as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Invalid PNG: {path}')
    return struct.unpack('>II', header[16:24])


def prepare_image(source, target, size):
    # macOS ships sips; no Python packages or model downloads are required.
    subprocess.run(['/usr/bin/sips', '-s', 'format', 'png', '-z', str(size),
                    str(size), str(source), '--out', str(target)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if png_size(target) != (size, size):
        raise ValueError(f'Input resize failed: {target}')


def build_vpipe_pipeline(model, prompt, references, width, height, output,
                         adapters=None, cfg=1.0, steps=8, seed=42, pipeline_id='user-testing'):
    """Shared pose and scene graph; references are already prepared to the canvas."""
    pipeline = json.loads((HERE / 'pipeline-template.json').read_text())
    pipeline['id'] = pipeline_id
    stages = {stage['id']: stage for stage in pipeline['stages']}
    stages['model-select']['config']['hf_dir'] = str(model)
    stages['text-prompt']['config']['text'] = prompt
    config = stages['model-config']['config']
    for key in list(config):
        if key.startswith('lora'):
            del config[key]
    config.update(vl_long_edge=0, vl_min_pixels=1024,
                  vl_pixel_budget=width * height, vl_max_pixels=width * height)
    config.update(adapters or {})
    inputs = []
    for index, reference in enumerate(references):
        load = json.loads(json.dumps(stages['load-ref-0']))
        load['id'] = f'load-ref-{index}'
        load['config']['url'] = str(reference)
        resize = json.loads(json.dumps(stages['ref-resample-0']))
        resize['id'] = f'ref-resample-{index}'
        resize['iports'] = [{'src': load['id'], 'oport': 0}]
        resize['config'].update(width=width, height=height)
        inputs.extend([load, resize])
    remaining = [stage for stage in pipeline['stages']
                 if not stage['id'].startswith(('load-ref-', 'ref-resample-'))]
    insertion = next(index for index, stage in enumerate(remaining) if stage['id'] == 'ref-list')
    pipeline['stages'] = remaining[:insertion] + inputs + remaining[insertion:]
    stages['ref-list']['iports'] = [{'src': f'ref-resample-{i}', 'oport': 0}
                                    for i in range(len(references))]
    stages['diffusion-conditioner']['config']['grounded_negative'] = cfg > 1
    stages['generate-image']['iports'][1] = {
        'src': 'diffusion-conditioner' if cfg > 1 else '', 'oport': 1 if cfg > 1 else 0}
    stages['generate-image']['config'].update(width=width, height=height, steps=steps,
                                            seed=seed, guidance_scale=cfg)
    stages['save-image']['config']['path'] = str(output)
    return pipeline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['vpipe', 'sd', 'both'], default='both',
                        help='sd means stable-diffusion.cpp; both runs sequentially')
    parser.add_argument('--size', type=int, choices=[256, 512, 1024], default=256)
    parser.add_argument('--pose', type=Path, default=HERE / 'inputs/reference.png',
                        help='Pose/reference image, used as image1')
    parser.add_argument('--avatar', type=Path, default=HERE / 'inputs/avatar.png',
                        help='Character image, used as image2')
    parser.add_argument('--lora', type=Path, help='Override the default VNCCS PoseStudio V2 safetensors')
    parser.add_argument('--lora-strength', type=float, default=1.0)
    parser.add_argument('--prompt', default='Draw character from image2',
                        help='References are image1=pose, image2=avatar')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--vpipe-model', type=Path, default=HUB / 'vpipe-prepared/Qwen-Image-2.1-Turbo-8bit')
    parser.add_argument('--prepare-only', action='store_true', help='Validate and save inputs/commands without loading models')
    args = parser.parse_args()
    if args.steps < 1 or not 0 <= args.seed <= 2147483647:
        parser.error('steps must be positive; seed must be between 0 and 2147483647')
    if not math.isfinite(args.lora_strength) or args.lora_strength < 0:
        parser.error('lora-strength must be finite and nonnegative')
    if not args.prompt.strip() or '<lora:' in args.prompt:
        parser.error('Provide a nonempty prompt without LoRA tags; use --lora and --lora-strength')
    engines = ['sd', 'vpipe'] if args.engine == 'both' else [args.engine]
    reference, avatar = [p.expanduser().resolve(strict=True) for p in (args.pose, args.avatar)]
    adapter = args.lora.expanduser().absolute() if args.lora else cached('MIUProject/VNCCS_PoseStudio_QI2.1', 'VNCCS_QI2_PoseStudioV2.safetensors')
    if not adapter.is_file() or adapter.suffix != '.safetensors':
        raise ValueError(f'LoRA must be an existing .safetensors file: {adapter}')
    binaries = {'vpipe': ROOT / 'vpipe/build/apps/vpipe/vpipe', 'sd': ROOT / 'stable-diffusion.cpp/build/bin/sd-cli'}
    for engine in engines:
        if not os.access(binaries[engine], os.X_OK):
            raise ValueError(f'Missing executable: {binaries[engine]}')
    models = {}
    if 'vpipe' in engines:
        model = args.vpipe_model.expanduser().resolve(strict=True)
        for part in ('model_index.json', 'transformer/config.json', 'text_encoder/config.json', 'vae/config.json'):
            if not (model / part).is_file():
                raise ValueError(f'Incomplete vpipe model: {model / part}')
        models['vpipe'] = str(model)
    if 'sd' in engines:
        for key, repo, name in [
            ('diffusion-model', 'unsloth/Qwen-Image-2.1-Turbo-GGUF', 'qwen-image-2.1-turbo-Q4_K_M.gguf'),
            ('vae', 'Comfy-Org/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors'),
            ('llm', 'unsloth/Qwen3-VL-8B-Instruct-GGUF', 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf'),
            ('llm_vision', 'unsloth/Qwen3-VL-8B-Instruct-GGUF', 'mmproj-F16.gguf')]:
            models[key] = str(cached(repo, name))
    workspace = tempfile.TemporaryDirectory(prefix='qwen-user-testing-')
    try:
        return run_engines(args, engines, reference, avatar, adapter, binaries, models, Path(workspace.name))
    finally:
        workspace.cleanup()


def run_engines(args, engines, reference, avatar, adapter, binaries, models, out):
    inputs = out / 'inputs'
    inputs.mkdir()
    for role, source in [('reference', reference), ('avatar', avatar)]:
        prepare_image(source, inputs / (role + '.png'), args.size)
    pose_name = re.sub(r'\s+', '-', reference.stem)
    output_name = f'{args.size}-{pose_name}.png'
    commands = {}
    for engine in engines:
        folder = out / engine
        folder.mkdir()
        output = HERE / 'outputs' / engine / output_name
        if engine == 'sd':
            command = [str(binaries[engine])]
            for key in ('diffusion-model', 'vae', 'llm', 'llm_vision'):
                command += ['--' + key, models[key]]
            command += ['-r', str(inputs / 'reference.png'), '-r', str(inputs / 'avatar.png'),
                        '--lora-model-dir', str(adapter.parent), '--lora-apply-mode', 'at_runtime',
                        '--width', str(args.size), '--height', str(args.size), '--steps', str(args.steps),
                        '--sigmas', 'qwen-image-2.1-turbo', '--cfg-scale', '1', '--sampling-method', 'euler',
                        '--rng', 'cpu', '--params-backend', 'disk', '--vae-tiling',
                        '-p', args.prompt + f' <lora:{adapter.stem}:{args.lora_strength}>',
                        '--seed', str(args.seed), '-o', str(output), '-v']
        else:
            pipeline = build_vpipe_pipeline(
                models['vpipe'], args.prompt,
                [inputs / 'reference.png', inputs / 'avatar.png'],
                args.size, args.size, output,
                adapters={'lora2': str(adapter), 'lora2_scale': args.lora_strength},
                steps=args.steps, seed=args.seed, pipeline_id=out.name)
            write_json(folder / 'pipeline.json', pipeline)
            write_json(folder / 'config.json', {'log': {'level': 'normal', 'delegate': 'stdout'}, 'db': {'path': str(folder)}})
            command = [str(binaries[engine]), '--config', str(folder / 'config.json'), '--launch', str(folder / 'pipeline.json')]
        commands[engine] = command
    if args.prepare_only:
        print('Prepared; no models loaded.', flush=True)
        return 0
    failed = False
    for engine, command in commands.items():
        folder = out / engine
        output = HERE / 'outputs' / engine / output_name
        output.parent.mkdir(parents=True, exist_ok=True)
        # Remove an older result so it cannot be mistaken for this render.
        output.unlink(missing_ok=True)
        print(f'{engine}: rendering {args.size}x{args.size} → {output}', flush=True)
        try:
            with (folder / 'render.log').open('w') as log:
                process = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            if process.returncode:
                raise ValueError(f'Engine exited {process.returncode}')
            if not output.is_file():
                raise ValueError('Engine produced no image; diagnostic output follows')
            if png_size(output) != (args.size, args.size):
                raise ValueError('Output dimensions do not match requested size')
            print(f'Saved: {output}', flush=True)
        except (OSError, ValueError) as error:
            failed = True
            print(f'{engine}: {error}', file=sys.stderr)
            log = folder / 'render.log'
            if log.is_file():
                print(log.read_text(errors='replace')[-6000:], file=sys.stderr)
    return int(failed)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit('Stopped.')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'Error: {error}')
