#!/usr/bin/env python3
"""Separate native Qwen 2.1 Union pipeline. Defaults to inspection, never inference."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REPO = "alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union"
WEIGHTS = "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors"


def snapshot(cache, repo):
    directory = cache / ("models--" + repo.replace("/", "--"))
    revision = (directory / "refs/main").read_text().strip()
    return directory / "snapshots" / revision


def pipeline(cache, cli, control_image, prompt, output, width, height, strength, references=(), turbo=False, steps=None, seed=43):
    base = snapshot(cache, "Qwen/Qwen-Image-2.1")
    command = [
        str(cli),
        "--diffusion-model", str(base / "transformer/diffusion_pytorch_model.safetensors.index.json"),
        "--vae", str(snapshot(cache, "Comfy-Org/Qwen-Image-2.1") / "vae/qwen_image_2.1_vae_bf16.safetensors"),
        "--llm", str(snapshot(cache, "unsloth/Qwen3-VL-8B-Instruct-GGUF") / "Qwen3-VL-8B-Instruct-Q4_K_M.gguf"),
        "--control-net", str(snapshot(cache, REPO) / WEIGHTS),
        "--control-image", str(control_image),
        "--control-strength", str(strength),
        "--cfg-scale", "1.0", "--steps", str(steps or (8 if turbo else 40)), "--sampling-method", "euler",
        "--offload-to-cpu", "--fa", "--vae-tiling",
        "-W", str(width), "-H", str(height), "-s", str(seed),
        "-p", prompt, "-o", str(output),
    ]
    if turbo:
        command[command.index("--diffusion-model") + 1] = str(
            snapshot(cache, "unsloth/Qwen-Image-2.1-Turbo-GGUF") / "qwen-image-2.1-turbo-Q4_K_M.gguf")
        command += ["--sigmas", "qwen-image-2.1-turbo"]
    if references:
        command += ["--llm_vision", str(snapshot(cache, "unsloth/Qwen3-VL-8B-Instruct-GGUF") / "mmproj-F16.gguf")]
        for reference in references:
            command += ["-r", str(reference.resolve())]
    return command


def validate_files(command):
    for flag in ("--diffusion-model", "--vae", "--llm", "--control-net"):
        path = Path(command[command.index(flag) + 1])
        if not path.is_file():
            raise ValueError(f"Missing {flag}: {path}")
        if path.suffix == ".json":
            index = json.loads(path.read_text())
            for shard in set(index["weight_map"].values()):
                if not (path.parent / shard).is_file():
                    raise ValueError(f"Missing base-model shard: {shard}")
    if "--llm_vision" in command and not Path(command[command.index("--llm_vision") + 1]).is_file():
        raise ValueError("Missing Qwen3-VL vision projector")
    cli = Path(command[0])
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise ValueError(f"Missing executable: {cli}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path(os.environ.get("HF_HUB_CACHE", str(Path.home() / ".cache/huggingface/hub"))))
    parser.add_argument("--cli", type=Path, default=ROOT / "stable-diffusion.cpp/build-union-reference/bin/sd-cli")
    parser.add_argument("--reference", type=Path, action="append", default=[])
    parser.add_argument("--turbo", action="store_true")
    parser.add_argument("--steps", type=int)
    parser.add_argument("--seed", type=int, default=43)
    parser.add_argument("--download", action="store_true", help="Download the Union adapter only")
    parser.add_argument("--control-image", type=Path, default=Path("pose.png"))
    parser.add_argument("--prompt", default="A person following the supplied pose")
    parser.add_argument("--output", type=Path, default=Path("union-output.png"))
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--strength", type=float, default=1.0)
    parser.add_argument("--run", action="store_true", help="Explicitly start inference; otherwise only validate and print")
    args = parser.parse_args()
    if args.width <= 0 or args.height <= 0 or args.width % 32 or args.height % 32:
        parser.error("Canvas dimensions must be positive multiples of 32")
    if not 0 <= args.strength <= 2:
        parser.error("Control strength must be between 0 and 2")
    if args.steps is not None and args.steps <= 0:
        parser.error("Steps must be positive")
    for reference in args.reference:
        if not reference.is_file():
            parser.error(f"Missing reference: {reference}")
    if args.download:
        subprocess.run(["hf", "download", REPO, WEIGHTS, "--cache-dir", str(args.cache)], check=True)
    try:
        command = pipeline(args.cache, args.cli.resolve(), args.control_image.resolve(), args.prompt,
                           args.output.resolve(), args.width, args.height, args.strength, args.reference, args.turbo, args.steps, args.seed)
        validate_files(command)
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))
    print(shlex.join(command), flush=True)
    if args.run:
        if not args.control_image.is_file():
            parser.error("Supply an existing RGB control map with --control-image")
        subprocess.run(command, check=True)
    else:
        print("Pipeline files verified. Inspection only; no generation started.")


if __name__ == "__main__":
    main()
