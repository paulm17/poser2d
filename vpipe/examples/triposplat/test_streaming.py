import json
import os
from pathlib import Path
import struct
import sys

import numpy as np
import pytest
import torch
from torch import nn
from accelerate import init_empty_weights
from safetensors.torch import save_file
from safetensors import safe_open

from streaming import MetalWeights, TensorFile
from pipeline import dino_name, vae_name
from run import require_no_fallback, resolve_paths, arguments

metal = pytest.mark.skipif(not torch.backends.mps.is_available(), reason="Metal required")


def resident(model, path, dtype):
    with safe_open(str(path), framework="pt", device="cpu") as f:
        values = {name: f.get_tensor(name).to("mps").to(dtype=dtype if f.get_tensor(name).is_floating_point() else f.get_tensor(name).dtype)
                  for name in model.state_dict()}
    model.load_state_dict(values, assign=True)
    for module in model.modules():
        for attr in module._non_persistent_buffers_set:
            module._buffers[attr] = module._buffers[attr].to("mps")
    return model


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm = nn.LayerNorm(8)
        self.linear = nn.Linear(8, 8)
        self.register_buffer("count", torch.tensor([3], dtype=torch.int64))
    def forward(self, x):
        return self.linear(self.norm(x)) / self.count.to(x.dtype)


class Model(nn.Module):
    def __init__(self, depth=4):
        super().__init__()
        self.input = nn.Linear(8, 8)
        self.blocks = nn.ModuleList([Block() for _ in range(depth)])
    def forward(self, x):
        x = self.input(x)
        for block in self.blocks:
            x = x+block(x)
        return x


def setup(tmp_path, depth=4):
    torch.manual_seed(42)
    path = tmp_path/f"model-{depth}.safetensors"
    save_file(Model(depth).state_dict(), str(path))
    with init_empty_weights(include_buffers=False):
        model = Model(depth).eval()
        reference = Model(depth).eval()
    reference = resident(reference, path, torch.bfloat16)
    weights = MetalWeights(model, path, [f"blocks.{i}" for i in range(depth)], torch.bfloat16)
    return model, reference, weights


@metal
def test_cast_parity_repeat_and_release(tmp_path):
    model, reference, weights = setup(tmp_path)
    pointers = [slot.data_ptr() for slot in weights.slots]
    with weights, torch.inference_mode():
        for _ in range(3):
            x = torch.randn(2, 7, 8, device="mps", dtype=torch.bfloat16)
            torch.testing.assert_close(model(x), reference(x), rtol=0, atol=0)
            assert all(p.is_meta for p in model.blocks.parameters())
            assert pointers == [slot.data_ptr() for slot in weights.slots]
        assert weights.stats["units_completed"] == 12
        assert weights.stats["max_active_units"] == 1
        assert model.blocks[0].count.dtype == torch.int64
    assert weights.stats["closed"]
    assert not weights.host and not weights.slots and not weights.hooks
    assert all(p.is_meta for p in model.parameters())


@metal
def test_fixed_slots_across_depth(tmp_path):
    _, _, a = setup(tmp_path, 2)
    _, _, b = setup(tmp_path, 16)
    try:
        assert a.slot_bytes == b.slot_bytes
        assert a.stats["resident_weight_bytes"] == b.stats["resident_weight_bytes"]
    finally:
        a.close()
        b.close()


@metal
def test_repeated_skipped_reordered_units(tmp_path):
    model, reference, weights = setup(tmp_path)
    with weights, torch.inference_mode():
        x = torch.randn(2, 8, device="mps", dtype=torch.bfloat16)
        for i in [2, 0, 3, 1, 1, 0]:
            torch.testing.assert_close(model.blocks[i](x), reference.blocks[i](x), rtol=0, atol=0)


@metal
def test_failure_cleanup(tmp_path):
    model, _, weights = setup(tmp_path)
    def fail(*args):
        raise RuntimeError("injected")
    model.blocks[0].forward = fail
    with pytest.raises(RuntimeError, match="injected"):
        with weights, torch.inference_mode():
            model(torch.randn(1, 8, device="mps", dtype=torch.bfloat16))
    assert weights.stats["closed"] and weights.active is None
    assert all(p.is_meta for p in model.parameters())


@metal
def test_prefetch_failure_cleanup(tmp_path):
    model, _, weights = setup(tmp_path)
    original = weights._fill
    def fail(name, slot):
        if name == "blocks.1":
            raise OSError("injected read failure")
        return original(name, slot)
    weights._fill = fail
    with pytest.raises(OSError, match="read failure"):
        with weights, torch.inference_mode():
            model(torch.randn(1, 8, device="mps", dtype=torch.bfloat16))
    assert weights.stats["closed"] and not weights.host


@metal
def test_reject_missing_shape_and_grad(tmp_path):
    model, _, weights = setup(tmp_path)
    with weights, pytest.raises(RuntimeError, match="inference_mode"):
        model(torch.randn(1, 8, device="mps", dtype=torch.bfloat16))
    with init_empty_weights():
        empty = Model(5)
    with pytest.raises(ValueError, match="missing tensor"):
        MetalWeights(empty, tmp_path/"model-4.safetensors", [f"blocks.{i}" for i in range(5)], torch.bfloat16)


def test_fallback_rejected(monkeypatch):
    monkeypatch.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    with pytest.raises(RuntimeError, match="Unset it"):
        require_no_fallback()
    monkeypatch.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "0")
    require_no_fallback()


def test_mappings():
    assert dino_name("embeddings.mask_token") is None
    assert dino_name("layer.7.attention.k_proj.weight") == "blocks.7.attn.k_proj.weight"
    assert dino_name("layer.7.layer_scale2.lambda1") == "blocks.7.ls2"
    assert vae_name("decoder.conv_in.weight") is None
    assert vae_name("encoder.down_blocks.2.resnets.1.conv1.weight") == "encoder.down_2_resnets.1.conv1.weight"
    assert vae_name("encoder.mid_block.attentions.0.to_q.weight") == "encoder.mid_attn.to_q.weight"


def test_invalid_checkpoint_extents(tmp_path):
    path = tmp_path/"broken.safetensors"
    header = json.dumps({"x": {"dtype": "F32", "shape": [4], "data_offsets": [0, 16]}}).encode()
    path.write_bytes(struct.pack("<Q", len(header))+header+b"1234")
    with pytest.raises(ValueError, match="extent"):
        TensorFile(path)


def test_cli_validation(tmp_path):
    (tmp_path/"triposplat.py").touch()
    (tmp_path/"model.py").touch()
    (tmp_path/"input.png").touch()
    base = [str(tmp_path/"input.png"), "--triposplat-source", str(tmp_path)]
    args = arguments(base)
    assert (args.steps, args.guidance, args.seed, args.num_gaussians) == (20, 3., 42, 32768)
    for invalid in (["--device", "cpu"], ["--steps", "0"], ["--num-gaussians", "32769"], ["--guidance", "nan"]):
        with pytest.raises(SystemExit):
            arguments(base+invalid)
    args.model_dir = tmp_path
    with pytest.raises(FileNotFoundError, match="never downloads"):
        resolve_paths(args, False)


@metal
@pytest.mark.parametrize("stride,padding,dilation", [(1, 1, 1), (2, 0, 1), (1, 2, 2)])
def test_deformable_convolution(stride, padding, dilation):
    # torchvision's CPU operator is an independent tiny test oracle only;
    # the CLI never calls it and has no CPU inference implementation.
    from torchvision.ops import deform_conv2d as oracle
    from metal_ops import deform_conv2d
    torch.manual_seed(24)
    x = torch.randn(2, 3, 9, 11)
    w = torch.randn(4, 3, 3, 3)
    bias = torch.randn(4)
    oh = (9+2*padding-dilation*2-1)//stride+1
    ow = (11+2*padding-dilation*2-1)//stride+1
    offset = torch.randn(2, 18, oh, ow)*.4
    mask = torch.rand(2, 9, oh, ow)*2
    expected = oracle(x, offset, w, bias, stride=stride, padding=padding, dilation=dilation, mask=mask)
    with torch.inference_mode():
        actual = deform_conv2d(x.to("mps"), offset.to("mps"), w.to("mps"), bias.to("mps"),
                               stride=stride, padding=padding, dilation=dilation, mask=mask.to("mps"))
    torch.testing.assert_close(actual.cpu(), expected, rtol=2e-5, atol=2e-5)


@metal
def test_metal_compute_guard():
    from metal_ops import MetalCompute
    cpu = torch.ones(2)
    gpu = cpu.to("mps")
    with MetalCompute():
        assert (gpu+gpu).device.type == "mps"
        assert torch.tensor([1., 2.], device="mps").device.type == "mps"
        imported = cpu.to("mps")
        assert imported.device.type == "mps"
        with pytest.raises(RuntimeError, match="CPU tensor computation prohibited"):
            cpu+cpu


@metal
def test_positional_constants_match_upstream(upstream_source):
    from metal_ops import timestep_embedding, level_embedding
    import model
    with torch.inference_mode():
        t = torch.tensor([0., 10., 500., 1000.], device="mps")
        torch.testing.assert_close(timestep_embedding(t, 256), model.TimestepEmbedder.timestep_embedding(t, 256), rtol=0, atol=0)
        for period in (1024, 100):
            torch.testing.assert_close(level_embedding(t, 256, period), model.LevelEmbedder.level_embedding(t, 256, period), rtol=0, atol=0)


@metal
def test_no_metal_fails_without_other_backend(monkeypatch, tmp_path):
    import run
    (tmp_path/"image.png").touch()
    for name in ("triposplat.py", "model.py"):
        (tmp_path/name).touch()
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="Metal .* required"):
        run.main([str(tmp_path/"image.png"), "--triposplat-source", str(tmp_path)])


@metal
def test_gaussian_metal_construction(upstream_source):
    import model
    import triposplat
    from metal_ops import gaussian_class, MetalCompute
    args = dict(aabb=[-.5, -.5, -.5, 1., 1., 1.], scaling_activation="softplus", device="mps")
    reference = triposplat.Gaussian(**args)
    with torch.inference_mode(), MetalCompute():
        actual = gaussian_class(triposplat.Gaussian)(**args)
    for name in ("aabb", "scale_bias", "rots_bias", "opacity_bias_val"):
        torch.testing.assert_close(getattr(actual, name), getattr(reference, name), rtol=1e-6, atol=1e-6)
        assert getattr(actual, name).device.type == "mps"


def test_export_validation(tmp_path):
    from exports import validate_exports
    fields = ['x','y','z','nx','ny','nz','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3']
    header = 'ply\nformat binary_little_endian 1.0\nelement vertex 2\n'+''.join(f'property float {name}\n' for name in fields)+'end_header\n'
    ply, splat = tmp_path/'test.ply', tmp_path/'test.splat'
    ply.write_bytes(header.encode()+np.zeros((2,17),dtype='<f4').tobytes())
    packed = np.zeros(2,dtype=[('xyz','<f4',3),('scale','<f4',3),('rgba','u1',4),('rot','u1',4)])
    packed['scale'] = .1
    splat.write_bytes(packed.tobytes())
    assert validate_exports(ply,splat,2)['splat_count'] == 2
    splat.write_bytes(b'bad')
    with pytest.raises(ValueError, match='size/count'):
        validate_exports(ply,splat,2)


@pytest.fixture
def upstream_source():
    source = os.environ.get("TRIPOSPLAT_SOURCE")
    if not source:
        pytest.skip("Set TRIPOSPLAT_SOURCE to exercise upstream model classes")
    sys.path.insert(0, str(Path(source).resolve()))
    return source
