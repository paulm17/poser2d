#!/usr/bin/env python3
"""SF3D CLI bridge with bounded disk-to-device block weight streaming."""
import argparse
import json
from pathlib import Path
import sys
import time
import resource
from unittest.mock import patch


def positive(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--verbose", action="store_true", help="Log each streaming unit")
    parser.add_argument("--sf3d-source", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path, help="Local directory containing config.yaml and model.safetensors")
    parser.add_argument("--dino-config", required=True, type=Path, help="Local DINOv2 config.json; no DINO checkpoint is loaded")
    parser.add_argument("--output", default=Path("output/mesh.glb"), type=Path)
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"], default="mps")
    parser.add_argument("--texture-resolution", type=positive, default=1024)
    parser.add_argument("--query-chunk-size", type=positive, default=32768)
    parser.add_argument("--remove-background", action="store_true", help="Use rembg for opaque input; alpha is otherwise preserved")
    parser.add_argument("--foreground-ratio", type=float, default=0.85)
    args = parser.parse_args()
    for path in (args.image, args.sf3d_source / "sf3d/system.py", args.model / "config.yaml",
                 args.model / "model.safetensors", args.dino_config):
        if not path.is_file():
            parser.error(f"Missing file: {path}")
    if not 0 < args.foreground_ratio <= 1:
        parser.error("--foreground-ratio must be in (0, 1]")
    sys.path.insert(0, str(args.sf3d_source.resolve()))
    import torch
    from accelerate import init_empty_weights
    from omegaconf import OmegaConf
    from PIL import Image
    from transformers import Dinov2Config
    from sf3d.system import SF3D
    from uv_unwrapper import Unwrapper
    from sf3d.models.tokenizers.dinov2 import Dinov2Model
    from sf3d.utils import resize_foreground
    import open_clip
    from streaming import WeightStream, sf3d_units

    if args.device == "mps" and not torch.backends.mps.is_available():
        parser.error("MPS is unavailable; select --device cpu or cuda")
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA is unavailable")
    cfg = OmegaConf.load(args.model / "config.yaml")
    OmegaConf.resolve(cfg)
    dino_cfg = Dinov2Config.from_json_file(str(args.dino_config))
    create_clip = open_clip.create_model_and_transforms

    def empty_clip(*pos, **kw):
        kw["pretrained"] = None
        kw["device"] = "meta"
        return create_clip(*pos, **kw)

    # Avoid all eager pretrained loaders, including auxiliary CLIP. Real
    # nonpersistent buffers (normalization constants, tetrahedra) stay on CPU.
    with patch.object(Dinov2Model, "from_pretrained", side_effect=lambda *a, **k: Dinov2Model(dino_cfg)), \
         patch.object(open_clip, "create_model_and_transforms", side_effect=empty_clip), \
         init_empty_weights(include_buffers=False):
        model = SF3D(cfg)
    model.eval()
    # This CLI does not request illumination estimation.
    model.global_estimator = None
    units = sf3d_units(model)
    progress = (lambda event, name: print(f"[stream {event}] {name}", flush=True)) if args.verbose else None
    stream = WeightStream(model, args.model / "model.safetensors", units, args.device, progress=progress)
    from chunking import install_chunked_queries
    install_chunked_queries(model, args.query_chunk_size)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Upstream PCA uses an MPS SVD that can stall on this mesh. Keep that
    # small UV-orientation step on CPU; the rest of unwrapping stays upstream.
    original_align = Unwrapper._align_mesh_with_main_axis

    def align_mesh(unwrapper, positions, normals):
        if positions.device.type == "mps":
            result = original_align(unwrapper, positions.cpu(), normals.cpu())
            return tuple(value.to(positions.device) for value in result)
        return original_align(unwrapper, positions, normals)

    started = time.perf_counter()
    try:
        image = Image.open(args.image).convert("RGBA")
        if args.remove_background:
            import rembg
            from sf3d.utils import remove_background
            image = remove_background(image, rembg.new_session())
        image = resize_foreground(image, args.foreground_ratio)
        image.save(args.output.with_suffix(".input.png"))
        print(json.dumps({"streaming_plan": stream.stats, "units": units}), flush=True)
        with torch.inference_mode(), patch.object(Unwrapper, "_align_mesh_with_main_axis", align_mesh):
            mesh, _ = model.run_image(image, bake_resolution=args.texture_resolution)
            mesh.export(str(args.output), include_normals=True)
        print(f"Wrote {args.output}")
    finally:
        stream.close()
        stream.stats["elapsed_seconds"] = time.perf_counter() - started
        max_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        stream.stats["process_peak_rss_bytes"] = max_rss if sys.platform == "darwin" else max_rss * 1024
        args.output.with_suffix(".streaming.json").write_text(json.dumps(stream.stats, indent=2) + "\n")


if __name__ == "__main__":
    main()
