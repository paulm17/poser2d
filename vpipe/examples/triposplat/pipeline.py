"""Stage-scoped TripoSplat orchestration; all inference uses Metal."""
from contextlib import contextmanager
import gc
import re
import time
from unittest.mock import patch

import numpy as np
from PIL import Image
import torch
from accelerate import init_empty_weights

from streaming import MetalWeights
from metal_ops import deform_conv2d, gaussian_class, timestep_embedding, level_embedding, MetalCompute


def dino_name(name):
    name = (name.replace("embeddings.patch_embeddings.", "patch_embed.proj.")
            .replace("embeddings.cls_token", "cls_token")
            .replace("embeddings.register_tokens", "register_tokens"))
    if name == "embeddings.mask_token":
        return None
    match = re.match(r"layer\.(\d+)\.(.+)", name)
    if match:
        rest = match[2]
        for proj in ("q_proj", "k_proj", "v_proj", "o_proj"):
            rest = rest.replace("attention."+proj, "attn."+proj)
        rest = rest.replace("layer_scale1.lambda1", "ls1").replace("layer_scale2.lambda1", "ls2")
        name = f"blocks.{match[1]}.{rest}"
    return name


def vae_name(name):
    if name.startswith(("decoder.", "post_quant_conv.")):
        return None
    for pattern, replacement in (
        (r"encoder\.down_blocks\.(\d+)\.resnets\.(\d+)\.(.+)", r"encoder.down_\1_resnets.\2.\3"),
        (r"encoder\.down_blocks\.(\d+)\.downsamplers\.0\.(.+)", r"encoder.down_\1_sampler.\2"),
        (r"encoder\.mid_block\.resnets\.(\d+)\.(.+)", r"encoder.mid_resnets.\1.\2"),
        (r"encoder\.mid_block\.attentions\.0\.(.+)", r"encoder.mid_attn.\1"),
    ):
        if re.fullmatch(pattern, name):
            return re.sub(pattern, replacement, name)
    return name


def flow_units(model):
    units = []
    for rope, stack in (("noise_repo_layers", "noise_refiner"),
                        ("context_repo_layers", "context_refiner"), ("repo_layers", "blocks")):
        for i in range(len(getattr(model, stack))):
            units += [f"{rope}.{i}", f"{stack}.{i}"]
    return units


def vae_units(model):
    units = []
    for i in range(4):
        units += [f"encoder.down_{i}_resnets.{j}" for j in range(2)]
        if i < 3:
            units.append(f"encoder.down_{i}_sampler")
    return units+["encoder.mid_resnets.0", "encoder.mid_attn", "encoder.mid_resnets.1"]


def biref_units(model):
    return [f"bb.layers.{i}.blocks.{j}" for i, layer in enumerate(model.bb.layers)
            for j in range(len(layer.blocks))]


def remove_background(model, image):
    """Upstream BiRefNet preprocessing with tensor arithmetic on Metal."""
    array = np.asarray(image.convert("RGB"), dtype=np.float32)/255.0
    tensor = torch.from_numpy(array).to("mps").permute(2, 0, 1).unsqueeze(0)
    tensor = torch.nn.functional.interpolate(tensor, size=model.INPUT_SIZE, mode="bilinear", align_corners=True)
    mean = torch.tensor(model._NORM_MEAN, device="mps").view(1, 3, 1, 1)
    std = torch.tensor(model._NORM_STD, device="mps").view(1, 3, 1, 1)
    with MetalCompute():
        alpha = model(((tensor-mean)/std).to(model.dtype))
    alpha = torch.nn.functional.interpolate(alpha.float(), size=(image.height, image.width),
                                           mode="bilinear", align_corners=True)[0, 0]
    rgba = image.convert("RGB")
    rgba.putalpha(Image.fromarray((alpha.clamp(0, 1)*255).to(torch.uint8).cpu().numpy(), mode="L"))
    return rgba


class Pipeline:
    def __init__(self, upstream, modules, paths, progress=None, capture=None):
        self.upstream, self.modules, self.paths = upstream, modules, paths
        self.progress, self.capture = progress, capture
        self.stats = {"backend": "mps", "cpu_fallback": False, "stages": {}, "status": "running"}

    @contextmanager
    def stage(self, name, build, dtype, units, rename=lambda name: name):
        started = time.perf_counter()
        print(f"[{name}] loading streamed stage", flush=True)
        with init_empty_weights(include_buffers=False):
            model = build()
        model.eval()
        weights = None
        try:
            weights = MetalWeights(model, self.paths[name], units(model), dtype,
                                   rename=rename, progress=self.progress)
            yield model
        except NotImplementedError as exc:
            self.stats["failed_stage"] = name
            raise RuntimeError(f"Metal operation unsupported in stage '{name}': {exc}; CPU fallback is disabled") from exc
        except BaseException:
            self.stats["failed_stage"] = name
            raise
        finally:
            if weights is not None:
                weights.close()
                self.stats["stages"][name] = dict(weights.stats, elapsed_seconds=time.perf_counter()-started)
            del model
            gc.collect()
            torch.mps.empty_cache()
            print(f"[{name}] released stage weights", flush=True)

    def emit(self, name, value):
        if self.capture is not None:
            self.capture(name, value)

    def run(self, image, seed=42, steps=20, guidance=3.0, num_gaussians=32768):
        with patch.object(self.modules.TimestepEmbedder, "timestep_embedding", staticmethod(timestep_embedding)), \
             patch.object(self.modules.LevelEmbedder, "level_embedding", staticmethod(level_embedding)):
            return self._run(image, seed, steps, guidance, num_gaussians)

    def prepare(self, image):
        m, up = self.modules, self.upstream
        has_alpha = image.mode == "RGBA" and image.getchannel("A").getextrema()[0] < 255
        if not has_alpha:
            with self.stage("background", m.BiRefNet, torch.float16, biref_units) as model:
                # Upstream resizes before invoking its background remover.
                class Background:
                    def remove_background(self, rgb):
                        return remove_background(model, rgb)
                with patch.object(m, "deform_conv2d", deform_conv2d):
                    prepared = up.preprocess_image(image, Background())
            del model
        else:
            prepared = up.preprocess_image(image, None)
        return prepared

    def _run(self, image, seed, steps, guidance, num_gaussians):
        torch.mps.manual_seed(seed)
        generator = torch.Generator(device="mps").manual_seed(seed)
        m, up = self.modules, self.upstream
        prepared = self.prepare(image)
        self.emit("prepared", prepared)
        with self.stage("dino", m.DinoV3ViT, torch.bfloat16,
                        lambda model: [f"blocks.{i}" for i in range(len(model.blocks))], dino_name) as model:
            tensor = up.transforms.ToTensor()(prepared).unsqueeze(0).to("mps", dtype=torch.float32)
            tensor = up._DINOV3_NORMALIZE(tensor)
            with MetalCompute():
                feature1 = model(tensor.to(torch.bfloat16))
            feature1 = torch.nn.functional.layer_norm(feature1.float(), feature1.shape[-1:])
        del model, tensor
        self.emit("feature1", feature1)
        with self.stage("vae", m.Flux2VAEEncoder, torch.bfloat16, vae_units, vae_name) as model:
            tensor = up.transforms.ToTensor()(prepared).unsqueeze(0).to("mps", dtype=torch.bfloat16)
            with MetalCompute():
                feature2 = model.encode(tensor*2-1, deterministic=False, generator=generator)
            feature2 = torch.cat([torch.zeros(1, 5, feature2.shape[2], device="mps", dtype=feature2.dtype), feature2], dim=1)
        del model, tensor
        self.emit("feature2", feature2)
        cond = {"feature1": feature1, "feature2": feature2}
        with self.stage("flow", lambda: m.LatentSeqMMFlowModel(**up.FLOW_MODEL_ARGS), torch.float16, flow_units) as model:
            with MetalCompute():
                latent = up.sample_latent(model, cond, steps=steps, guidance_scale=guidance,
                                          shift=3.0, generator=generator, show_progress=True)
        del model, cond, feature1, feature2
        self.emit("latent", latent)
        torch.mps.empty_cache()
        with self.stage("decoder", lambda: m.OctreeGaussianDecoder(up.OCTREE_DECODER_ARGS, up.GS_DECODER_ARGS),
                        torch.float16, lambda model: [f"octree.blocks.{i}" for i in range(len(model.octree.blocks))]
                        +[f"gs.blocks.{i}" for i in range(len(model.gs.blocks))]) as model:
            # Reference decoder sampling uses the global MPS RNG, unlike the
            # VAE/flow's explicit generator. Seed it explicitly for repeatability.
            torch.mps.manual_seed(seed)
            self.emit("decoder_rng", torch.mps.get_rng_state())
            with patch.object(up, "Gaussian", gaussian_class(up.Gaussian)), MetalCompute():
                gaussian = model.decode(latent["latent"], num_gaussians=num_gaussians)
        del model, latent
        self.emit("gaussian", gaussian)
        return gaussian, prepared
