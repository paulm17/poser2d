#!/usr/bin/env python3
"""Generate TripoSplat Gaussian files with bounded disk-to-Metal weight streaming."""
import argparse
import json
import os
from pathlib import Path
import resource
import sys
import time


def require_no_fallback():
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "0").strip() not in ("", "0"):
        raise RuntimeError("PYTORCH_ENABLE_MPS_FALLBACK is enabled. Unset it: this CLI requires Metal-only inference.")


def positive(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--triposplat-source", type=Path, required=True)
    location = parser.add_mutually_exclusive_group()
    location.add_argument("--model-dir", type=Path, help="Local VAST-AI/TripoSplat checkpoint directory")
    location.add_argument("--cache-dir", type=Path, default=Path.home()/".cache/huggingface/hub")
    parser.add_argument("--output-dir", type=Path, default=Path("output"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--steps", type=positive, default=20)
    parser.add_argument("--guidance", type=float, default=3.0)
    parser.add_argument("--num-gaussians", type=positive, default=32768)
    parser.add_argument("--verbose", action="store_true", help="Log every streamed block")
    args = parser.parse_args(argv)
    if not args.image.is_file():
        parser.error(f"Missing image: {args.image}")
    for name in ("triposplat.py", "model.py"):
        if not (args.triposplat_source/name).is_file():
            parser.error(f"Missing upstream source: {args.triposplat_source/name}")
    if not 32768 <= args.num_gaussians <= 262144 or args.num_gaussians % 32:
        parser.error("--num-gaussians must be a multiple of 32 between 32768 and 262144")
    import math
    if not math.isfinite(args.guidance) or args.guidance < 0:
        parser.error("--guidance must be finite and nonnegative")
    return args


def resolve_paths(args, needs_background):
    root = args.model_dir
    if root is None:
        from huggingface_hub import snapshot_download
        try:
            root = Path(snapshot_download("VAST-AI/TripoSplat", cache_dir=str(args.cache_dir), local_files_only=True))
        except Exception as exc:
            raise FileNotFoundError(f"TripoSplat checkpoints are missing from local cache {args.cache_dir}. "
                                    "Supply --model-dir or prepare the cache separately; no download was attempted.") from exc
    paths = {"dino": root/"clip_vision/dino_v3_vit_h.safetensors",
             "vae": root/"vae/flux2-vae.safetensors",
             "flow": root/"diffusion_models/triposplat_fp16.safetensors",
             "decoder": root/"vae/triposplat_vae_decoder_fp16.safetensors"}
    if needs_background:
        paths["background"] = root/"background_removal/birefnet.safetensors"
    for path in paths.values():
        if not path.is_file():
            raise FileNotFoundError(f"Missing local checkpoint: {path}. This CLI never downloads weights.")
    return paths


def validate_gaussian(gaussian, count):
    import torch
    tensors = {"position": gaussian.get_xyz, "colour": gaussian._features_dc,
               "opacity": gaussian.get_opacity, "scale": gaussian.get_scaling,
               "rotation": gaussian._rotation + gaussian.rots_bias}
    for name, tensor in tensors.items():
        if tensor.device.type != "mps":
            raise RuntimeError(f"Non-Metal Gaussian tensor: {name}")
        if tensor.shape[0] != count or not bool(torch.isfinite(tensor).all()):
            raise RuntimeError(f"Invalid Gaussian {name}: expected {count} finite entries")
    return {name: list(tensor.shape) for name, tensor in tensors.items()}


def main(argv=None):
    args = arguments(argv)
    require_no_fallback()  # Before importing torch: no fallback-enabled initialization.
    import torch
    if not torch.backends.mps.is_available():
        raise RuntimeError("Metal (PyTorch MPS) is required; no other inference backend is available in this CLI.")
    from PIL import Image
    image = Image.open(args.image)
    needs_background = not (image.mode == "RGBA" and image.getchannel("A").getextrema()[0] < 255)
    paths = resolve_paths(args, needs_background)
    sys.path.insert(0, str(args.triposplat_source.resolve()))
    import model
    import triposplat
    from pipeline import Pipeline
    progress = (lambda event, name: print(f"[weights {event}] {name}", flush=True)) if args.verbose else None
    pipe = Pipeline(triposplat, model, paths, progress=progress)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem = args.image.stem
    report = args.output_dir/f"{stem}.streaming.json"
    started = time.perf_counter()
    pipe.stats.update(seed=args.seed, steps=args.steps, guidance=args.guidance,
                      num_gaussians=args.num_gaussians, background_removal=needs_background,
                      checkpoints={name: str(path) for name, path in paths.items()})
    try:
        with torch.inference_mode():
            gaussian, prepared = pipe.run(image, seed=args.seed, steps=args.steps,
                                           guidance=args.guidance, num_gaussians=args.num_gaussians)
            pipe.stats["gaussian_shapes"] = validate_gaussian(gaussian, args.num_gaussians)
            prepared.save(args.output_dir/f"{stem}_preprocessed.png")
            gaussian.save_ply(str(args.output_dir/f"{stem}.ply"))
            gaussian.save_splat(str(args.output_dir/f"{stem}.splat"))
            from exports import validate_exports
            pipe.stats["exports"] = validate_exports(args.output_dir/f"{stem}.ply", args.output_dir/f"{stem}.splat", args.num_gaussians)
            pipe.stats["status"] = "complete"
        print(f"Saved {args.num_gaussians:,} Gaussians to {args.output_dir.resolve()}", flush=True)
    except BaseException as exc:
        pipe.stats["status"] = "failed"
        pipe.stats["error"] = str(exc)
        raise
    finally:
        pipe.stats["elapsed_seconds"] = time.perf_counter()-started
        pipe.stats["process_peak_rss_bytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        pipe.stats["metal_allocated_bytes_after_export"] = torch.mps.current_allocated_memory()
        pipe.stats["metal_driver_bytes_after_export"] = torch.mps.driver_allocated_memory()
        report.write_text(json.dumps(pipe.stats, indent=2)+"\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, FileNotFoundError, ImportError) as exc:
        print(f"TripoSplat: {exc}", file=sys.stderr)
        sys.exit(1)
