#!/usr/bin/env python3
"""Optional real-checkpoint validation; permanent weights are an oracle only.

Run reference and streamed in separate processes with the same input/settings,
then compare the saved tensors. decode mode exercises maximum output density
from a previously captured latent without repeating image generation.
"""
import argparse
from contextlib import contextmanager, nullcontext
import json
from pathlib import Path
import sys
import time

import numpy as np
from PIL import Image
import torch

from run import arguments, resolve_paths, require_no_fallback, validate_gaussian
from pipeline import Pipeline
from metal_ops import gaussian_class, level_embedding, MetalCompute
from unittest.mock import patch


def save_capture(root):
    root.mkdir(parents=True, exist_ok=True)
    def save(name, value):
        if name == "prepared":
            value.save(root/"prepared.png")
        elif name == "gaussian":
            for key in ["_xyz", "_features_dc", "_opacity", "_scaling", "_rotation"]:
                np.save(root/f"gaussian{key}.npy", getattr(value, key).float().cpu().numpy())
        elif isinstance(value, dict):
            for key, tensor in value.items():
                np.save(root/f"{name}-{key}.npy", tensor.float().cpu().numpy())
        else:
            np.save(root/f"{name}.npy", value.float().cpu().numpy())
    return save


class Reference(Pipeline):
    @contextmanager
    def stage(self, name, build, dtype, units, rename=lambda name: name):
        print(f"[{name}] resident upstream reference", flush=True)
        loaders = {"dino": self.upstream.load_dinov3, "vae": self.upstream.load_vae_encoder,
                   "flow": self.upstream.load_flow_model, "decoder": self.upstream.load_decoder,
                   "background": self.upstream.load_rmbg}
        model = loaders[name](str(self.paths[name]), device="mps", dtype=dtype)
        try:
            yield model
        finally:
            # Outputs do not alias parameters. Permanent stage weights are no
            # longer needed; parameter-freeing is explicit before the next stage.
            model.to("meta")
            del model
            torch.mps.empty_cache()

    def run(self, image, seed=42, steps=20, guidance=3., num_gaussians=32768):
        # Keep original positional-embedding arithmetic as an independent oracle.
        import pipeline
        # Only the unmodified reference uses CPU-created fixed frequency
        # constants; all neural network operators still execute on MPS.
        with patch.object(pipeline, "MetalCompute", nullcontext):
            return self._run(image, seed, steps, guidance, num_gaussians)


def main():
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--mode", choices=["reference", "streamed", "decode", "background"], required=True)
    parser.add_argument("--capture-dir", required=True, type=Path)
    parser.add_argument("--latent-dir", type=Path)
    options, remainder = parser.parse_known_args()
    args = arguments(remainder)
    require_no_fallback()
    if not torch.backends.mps.is_available():
        raise RuntimeError("Metal required for validation")
    sys.path.insert(0, str(args.triposplat_source.resolve()))
    import model
    import triposplat
    image = Image.open(args.image)
    opaque = not (image.mode == "RGBA" and image.getchannel("A").getextrema()[0] < 255)
    paths = resolve_paths(args, opaque)
    capture = save_capture(options.capture_dir)
    kind = Reference if options.mode == "reference" else Pipeline
    pipe = kind(triposplat, model, paths, capture=capture)
    started = time.perf_counter()
    with torch.inference_mode():
        if options.mode == "background":
            prepared = pipe.prepare(image)
            capture("prepared", prepared)
            pipe.stats["status"] = "complete"
            (options.capture_dir/"validation.json").write_text(json.dumps(pipe.stats, indent=2)+"\n")
            return
        if options.mode == "decode":
            if options.latent_dir is None:
                raise ValueError("decode requires --latent-dir")
            latent = torch.from_numpy(np.load(options.latent_dir/"latent-latent.npy")).to("mps")
            with pipe.stage("decoder", lambda: model.OctreeGaussianDecoder(triposplat.OCTREE_DECODER_ARGS, triposplat.GS_DECODER_ARGS),
                            torch.float16, lambda m: [f"octree.blocks.{i}" for i in range(len(m.octree.blocks))]
                            +[f"gs.blocks.{i}" for i in range(len(m.gs.blocks))]) as decoder:
                torch.mps.manual_seed(args.seed)
                with patch.object(triposplat, "Gaussian", gaussian_class(triposplat.Gaussian)), \
                     patch.object(model.LevelEmbedder, "level_embedding", staticmethod(level_embedding)), MetalCompute():
                    gaussian = decoder.decode(latent, num_gaussians=args.num_gaussians)
            capture("gaussian", gaussian)
            prepared = image
        else:
            gaussian, prepared = pipe.run(image, args.seed, args.steps, args.guidance, args.num_gaussians)
        validate_gaussian(gaussian, args.num_gaussians)
        gaussian.save_ply(str(options.capture_dir/"result.ply"))
        gaussian.save_splat(str(options.capture_dir/"result.splat"))
    from exports import validate_exports
    pipe.stats["exports"] = validate_exports(options.capture_dir/"result.ply", options.capture_dir/"result.splat", args.num_gaussians)
    pipe.stats["elapsed_seconds"] = time.perf_counter()-started
    pipe.stats["status"] = "complete"
    (options.capture_dir/"validation.json").write_text(json.dumps(pipe.stats, indent=2)+"\n")


if __name__ == "__main__":
    main()
