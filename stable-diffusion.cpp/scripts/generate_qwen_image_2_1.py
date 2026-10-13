#!/usr/bin/env python3
"""Generate an image with the Metal sd-cli and cached Qwen Image 2.1 Turbo weights.

Example: python3 scripts/generate_qwen_image_2_1.py --prompt "A lovely cat"
Download the Q8_0 diffusion model, Unsloth Q4_K_M encoder, and Qwen 2.1
BF16 VAE into the Hugging Face cache before running. No Python packages required.
"""

import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys


MODELS = {
    "diffusion_model": ("unsloth/Qwen-Image-2.1-Turbo-GGUF", "qwen-image-2.1-turbo-Q8_0.gguf"),
    "llm": ("unsloth/Qwen3-VL-8B-Instruct-GGUF", "Qwen3-VL-8B-Instruct-Q4_K_M.gguf"),
    "vae": ("Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors"),
}


def cached_model(cache, repo, filename):
    root = cache / ("models--" + repo.replace("/", "--"))
    ref = root / "refs" / "main"
    if ref.is_file():
        candidate = root / "snapshots" / ref.read_text(encoding="utf-8").strip() / filename
        if candidate.is_file():
            return candidate
    candidates = list((root / "snapshots").glob("*/" + filename))
    candidates = [path for path in candidates if path.is_file()]
    if candidates:
        return max(candidates, key=lambda path: path.stat().st_mtime)
    raise ValueError(f"Missing cached {filename} from {repo}; download it or supply its model-path option.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", "-p", required=True)
    parser.add_argument("--output", "-o", type=Path, default=Path("output_qwen_image_2_1.png"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--width", "-W", type=int, default=1024)
    parser.add_argument("--height", "-H", type=int, default=1024)
    parser.add_argument("--diffusion-model", type=Path)
    parser.add_argument("--llm", type=Path)
    parser.add_argument("--vae", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="Validate paths and print the command without generating.")
    args = parser.parse_args()
    if not args.prompt.strip():
        parser.error("prompt must not be empty")
    if any(value <= 0 or value % 32 for value in (args.width, args.height)):
        parser.error("width and height must be positive multiples of 32")
    if args.output.suffix.lower() != ".png":
        parser.error("output must be a PNG file")

    hf_home = Path(os.environ.get("HF_HOME", Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "huggingface"))
    cache = Path(os.environ.get("HF_HUB_CACHE", os.environ.get("HUGGINGFACE_HUB_CACHE", hf_home / "hub"))).expanduser()
    cli = Path(__file__).resolve().parents[1] / "build" / "bin" / "sd-cli"
    command = [str(cli)]
    try:
        if not cli.is_file() or not os.access(cli, os.X_OK):
            raise ValueError(f"Build the executable first: {cli}")
        for key, (repo, filename) in MODELS.items():
            path = getattr(args, key)
            path = path.expanduser().absolute() if path else cached_model(cache, repo, filename)
            if path.name != Path(filename).name:
                raise ValueError(f"--{key.replace('_', '-')} requires {Path(filename).name}; other precisions are not supported.")
            if not path.is_file():
                raise ValueError(f"Model file does not exist: {path}")
            command.extend(["--" + key.replace("_", "-"), str(path)])
        output = args.output.expanduser().absolute()
        if not output.parent.is_dir():
            raise ValueError(f"Output directory does not exist: {output.parent}")
        if output.exists():
            raise ValueError(f"Output already exists; choose a new path: {output}")
    except ValueError as error:
        parser.error(str(error))

    command.extend([
        "-p", args.prompt, "-o", str(output), "--seed", str(args.seed),
        "-W", str(args.width), "-H", str(args.height),
        "--sampling-method", "euler", "--steps", "8", "--cfg-scale", "1",
        "--sigmas", "qwen-image-2.1-turbo", "--offload-to-cpu",
        "--model-args", "qwen_image_2_1_prefix_cache_type=f32",
        "-v",
    ])
    print(shlex.join(command), flush=True)
    if args.dry_run:
        return 0
    try:
        result = subprocess.run(command, check=False)
    except KeyboardInterrupt:
        return 130
    except OSError as error:
        print(f"Failed to run sd-cli: {error}", file=sys.stderr)
        return 1
    if result.returncode:
        print(f"sd-cli failed with exit code {result.returncode}", file=sys.stderr)
        return result.returncode if result.returncode > 0 else 128 - result.returncode
    if not output.is_file() or output.stat().st_size == 0:
        print(f"sd-cli did not produce the expected image: {output}", file=sys.stderr)
        return 1
    print(f"Generated: {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
