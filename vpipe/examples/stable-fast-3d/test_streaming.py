import copy

from accelerate import init_empty_weights
import pytest
from safetensors.torch import save_file, save_model
import torch
from torch import nn

from streaming import TensorFile, WeightStream


class Model(nn.Module):
    def __init__(self, depth=5):
        super().__init__()
        self.input = nn.Linear(8, 8)
        self.blocks = nn.ModuleList([nn.Sequential(nn.LayerNorm(8), nn.Linear(8, 8), nn.GELU()) for _ in range(depth)])
        self.output = nn.Linear(8, 3)
        self.register_buffer("scale", torch.tensor(0.75), persistent=False)

    def forward(self, x):
        x = self.input(x)
        for block in self.blocks:
            x = x + block(x)
        return self.output(x) * self.scale


def setup(tmp_path, depth=5, device="cpu"):
    torch.manual_seed(7)
    reference = Model(depth).eval()
    path = tmp_path / "model.safetensors"
    save_model(reference, str(path))
    with init_empty_weights(include_buffers=False):
        model = Model(depth).eval()
    units = [f"blocks.{i}" for i in range(depth)]
    stream = WeightStream(model, path, units, device)
    return reference.to(device), model, stream


def test_parity_repeated_and_bounded(tmp_path):
    ref, model, stream = setup(tmp_path)
    pointers = [slot.data_ptr() for slot in stream.host]
    try:
        with torch.inference_mode():
            for _ in range(3):
                x = torch.randn(2, 11, 8)
                torch.testing.assert_close(model(x), ref(x), rtol=0, atol=0)
                assert all(p.is_meta for p in model.blocks.parameters())
        assert pointers == [slot.data_ptr() for slot in stream.host]
        assert stream.stats["units_executed"] == 15
        assert stream.stats["max_active_units"] == 1
    finally:
        stream.close()


def test_slots_do_not_grow_with_depth(tmp_path):
    _, _, shallow = setup(tmp_path, 2)
    _, _, deep = setup(tmp_path, 20)
    try:
        assert shallow.slot_bytes == deep.slot_bytes
        assert shallow.stats["resident_weight_bytes"] == deep.stats["resident_weight_bytes"]
    finally:
        shallow.close()
        deep.close()


def test_reordered_units_and_skipped_prefetch(tmp_path):
    ref, model, stream = setup(tmp_path)
    try:
        with torch.inference_mode():
            x = torch.randn(3, 8)
            for index in [2, 0, 4, 1, 1, 3]:
                torch.testing.assert_close(model.blocks[index](x), ref.blocks[index](x), rtol=0, atol=0)
    finally:
        stream.close()


def test_missing_tensor_fails_before_inference(tmp_path):
    path = tmp_path / "missing.safetensors"
    state = Model().state_dict()
    del state["blocks.2.1.weight"]
    save_file(state, str(path))
    with init_empty_weights():
        model = Model()
    with pytest.raises(ValueError, match="missing tensor"):
        WeightStream(model, path, [f"blocks.{i}" for i in range(5)])


def test_exception_releases_parameters(tmp_path):
    _, model, stream = setup(tmp_path)
    original = model.blocks[0].forward
    def fail(*args):
        raise RuntimeError("injected failure")
    model.blocks[0].forward = fail
    try:
        with torch.inference_mode(), pytest.raises(RuntimeError, match="injected"):
            model.blocks[0](torch.randn(1, 8))
        assert stream.active is None
        assert all(p.is_meta for p in model.blocks[0].parameters())
        model.blocks[0].forward = original
        with torch.inference_mode():
            model(torch.randn(1, 8))
    finally:
        stream.close()


def test_grad_mode_rejected(tmp_path):
    _, model, stream = setup(tmp_path)
    try:
        with pytest.raises(RuntimeError, match="inference_mode"):
            model(torch.randn(1, 8))
    finally:
        stream.close()


def test_alias_metadata(tmp_path):
    model = nn.Module()
    model.a = nn.Linear(8, 8)
    model.b = model.a
    path = tmp_path / "tied.safetensors"
    save_model(model, str(path))
    with init_empty_weights():
        empty = copy.deepcopy(model).to("meta")
    stream = WeightStream(empty, path, ["a"])
    try:
        with torch.inference_mode():
            x = torch.randn(1, 8)
            torch.testing.assert_close(empty.a(x), model.a(x))
    finally:
        stream.close()


@pytest.mark.skipif(not torch.backends.mps.is_available(), reason="MPS unavailable")
def test_mps_parity(tmp_path):
    ref, model, stream = setup(tmp_path, device="mps")
    try:
        with torch.inference_mode():
            x = torch.randn(2, 11, 8, device="mps")
            torch.testing.assert_close(model(x), ref(x))
    finally:
        stream.close()


@pytest.mark.parametrize("device", ["cpu", "mps"])
def test_real_sf3d_transformers(tmp_path, device):
    """Exercise upstream attention and tuple-returning reconstruction units."""
    import os
    import sys
    if device == "mps" and not torch.backends.mps.is_available():
        pytest.skip("MPS unavailable")
    source = os.environ.get("SF3D_SOURCE")
    if not source:
        pytest.skip("Set SF3D_SOURCE to test upstream SF3D operators")
    sys.path.insert(0, source)
    import PIL.Image
    from sf3d.models.transformers.backbone import TwoStreamInterleaveTransformer
    from sf3d.models.tokenizers.dinov2 import Dinov2Model
    from transformers import Dinov2Config
    cfg = dict(num_attention_heads=4, attention_head_dim=8,
               raw_triplane_channels=32, triplane_channels=32, raw_image_channels=32,
               num_latents=7, num_blocks=2, num_basic_blocks=2, norm_num_groups=4,
               cross_attention_dim=32)
    dino_cfg = Dinov2Config(hidden_size=32, num_hidden_layers=3,
                          num_attention_heads=4, mlp_ratio=2, image_size=28, patch_size=14)
    class Pipeline(nn.Module):
        def __init__(self):
            super().__init__()
            self.dino = Dinov2Model(dino_cfg)
            self.backbone = TwoStreamInterleaveTransformer(cfg)
        def forward(self, image, planes):
            tokens = self.dino(image).last_hidden_state
            return self.backbone(planes, tokens)
    torch.manual_seed(71)
    reference = Pipeline().eval()
    path = tmp_path / "sf3d.safetensors"
    save_model(reference, str(path))
    with init_empty_weights(include_buffers=False):
        model = Pipeline().eval()
    units = [f"dino.encoder.layer.{i}" for i in range(3)]
    for i in range(2):
        prefix = f"backbone.main_blocks.{i}"
        units += [prefix + ".fuse_block_in"]
        units += [prefix + f".transformer_block.{j}" for j in range(2)]
        units += [prefix + ".fuse_block_out"]
    stream = WeightStream(model, path, units, device)
    reference.to(device)
    try:
        with torch.inference_mode():
            image, planes = torch.randn(1, 3, 28, 28, device=device), torch.randn(1, 32, 21, device=device)
            for _ in range(2):
                torch.testing.assert_close(model(image, planes), reference(image, planes), rtol=0, atol=0)
    finally:
        stream.close()


@pytest.mark.parametrize("squeeze", [False, True])
@pytest.mark.parametrize("count", [0, 1, 19])
def test_chunked_query_decode(tmp_path, squeeze, count):
    from chunking import install_chunked_queries
    class Decoder(nn.Module):
        def forward(self, value, include=None):
            heads = {"density": value.square().sum(-1, keepdim=True), "features": value.sigmoid()}
            return {k: v for k, v in heads.items() if include is None or k in include}
    class Scene:
        def __init__(self):
            self.decoder = Decoder()
            self.max_query = 0
        def query_triplane(self, positions, planes):
            self.max_query = max(self.max_query, positions.shape[-2])
            return (positions * planes).unsqueeze(0) if positions.ndim == 2 else positions * planes
    original, chunked = Scene(), Scene()
    install_chunked_queries(chunked, 7)
    positions = torch.randn(count, 3)
    planes = torch.tensor(0.75)
    with torch.inference_mode():
        a, b = original.query_triplane(positions, planes), chunked.query_triplane(positions, planes)
        if squeeze:
            a, b = a[0], b[0]
        expected = original.decoder(a, include=["features"])
        actual = chunked.decoder(b, include=["features"])
    torch.testing.assert_close(actual, expected, rtol=0, atol=0)
    assert chunked.max_query <= 7
