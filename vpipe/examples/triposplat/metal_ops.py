"""Metal equivalents for operations missing from upstream's MPS path."""
import torch
import torch.nn.functional as F


def deform_conv2d(input, offset, weight, bias=None, stride=(1, 1), padding=(0, 0),
                  dilation=(1, 1), mask=None):
    """Un-grouped modulated deformable convolution via Metal grid_sample/GEMM.

    torchvision offsets are interleaved (dy, dx) per kernel tap. Each tap is
    sampled separately, bounding sampled-feature scratch independently of K.
    """
    if input.device.type != "mps":
        raise RuntimeError("Deformable convolution requires Metal tensors")
    pair = lambda value: (value, value) if isinstance(value, int) else tuple(value)
    sy, sx = pair(stride)
    py, px = pair(padding)
    dy, dx = pair(dilation)
    batch, channels, height, width = input.shape
    output_channels, weight_channels, kh, kw = weight.shape
    oh, ow = offset.shape[-2:]
    if channels != weight_channels or offset.shape[1] != 2*kh*kw:
        raise ValueError("Only un-grouped deformable convolution is supported")
    if mask is not None and mask.shape != (batch, kh*kw, oh, ow):
        raise ValueError("Invalid deformable convolution mask")
    # Float coordinates preserve subpixel offsets; float accumulators avoid
    # rounding each of the nine partial convolution sums to half precision.
    yy, xx = torch.meshgrid(torch.arange(oh, device="mps", dtype=torch.float32)*sy-py,
                            torch.arange(ow, device="mps", dtype=torch.float32)*sx-px,
                            indexing="ij")
    result = torch.zeros(batch, output_channels, oh*ow, device="mps", dtype=torch.float32)
    source = input.float()
    for y in range(kh):
        for x in range(kw):
            tap = y*kw+x
            gy = yy+y*dy+offset[:, 2*tap].float()
            gx = xx+x*dx+offset[:, 2*tap+1].float()
            # align_corners=False works for singleton input dimensions too.
            grid = torch.stack(((gx+0.5)*2/width-1, (gy+0.5)*2/height-1), dim=-1)
            sampled = F.grid_sample(source, grid, mode="bilinear", padding_mode="zeros",
                                    align_corners=False)
            if mask is not None:
                sampled = sampled*mask[:, tap:tap+1].float()
            result.add_(torch.matmul(weight[:, :, y, x].float(), sampled.flatten(2)))
    if bias is not None:
        result.add_(bias.float()[None, :, None])
    return result.reshape(batch, output_channels, oh, ow).to(input.dtype)


def gaussian_class(base):
    class MetalGaussian(base):
        def __init__(self, aabb, sh_degree=0, mininum_kernel_size=0.0, scaling_bias=0.01,
                     opacity_bias=0.1, scaling_activation="exp", device="mps"):
            if torch.device(device).type != "mps":
                raise RuntimeError("Gaussian construction requires Metal")
            self.sh_degree, self.mininum_kernel_size = sh_degree, mininum_kernel_size
            self.scaling_bias, self.opacity_bias, self.device = scaling_bias, opacity_bias, torch.device("mps")
            self.aabb = torch.tensor(aabb, dtype=torch.float32, device="mps")
            if scaling_activation == "exp":
                self._scaling_activation, self._inverse_scaling_activation = torch.exp, torch.log
            elif scaling_activation == "softplus":
                self._scaling_activation = F.softplus
                self._inverse_scaling_activation = lambda x: x+torch.log(-torch.expm1(-x))
            else:
                raise ValueError(f"Unsupported scaling activation: {scaling_activation}")
            self._opacity_activation = torch.sigmoid
            self._inverse_opacity_activation = lambda x: torch.log(x/(1-x))
            self.scale_bias = self._inverse_scaling_activation(torch.tensor(scaling_bias, device="mps"))
            self.rots_bias = torch.tensor([1., 0., 0., 0.], device="mps")
            self.opacity_bias_val = self._inverse_opacity_activation(torch.tensor(opacity_bias, device="mps"))
            self._storage = {}
    return MetalGaussian


def timestep_embedding(t, dim, max_period=10000):
    half = dim//2
    freqs = frequencies(max_period, half)
    angles = t[:, None].float()*freqs[None]
    embedding = torch.cat([angles.cos(), angles.sin()], dim=-1)
    if dim % 2:
        embedding = torch.cat([embedding, torch.zeros_like(embedding[:, :1])], dim=-1)
    return embedding


def level_embedding(t, dim, max_period=1024):
    half = dim//2
    freqs = frequencies(max_period, half)
    angles = t[:, None].float()*freqs[None]*2*torch.pi
    embedding = torch.cat([angles.cos(), angles.sin()], dim=-1)
    if dim % 2:
        embedding = torch.cat([embedding, torch.zeros_like(embedding[:, :1])], dim=-1)
    return embedding


def frequencies(period, half):
    # Immutable pretrained formula constants, generated once using upstream's
    # float32 expression. Loading a table is I/O, not CPU tensor inference.
    # This also avoids CPU-vs-Metal exp rounding changes in iterative sampling.
    import json
    from pathlib import Path
    if not hasattr(frequencies, "tables"):
        frequencies.tables = json.loads(Path(__file__).with_name("embedding_frequencies.json").read_text())
    key = f"{period}:{half}"
    if key not in frequencies.tables:
        raise ValueError(f"Unsupported positional frequency configuration: {key}")
    return torch.tensor(frequencies.tables[key], device="mps", dtype=torch.float32)


from torch.utils._python_dispatch import TorchDispatchMode
from torch.utils._pytree import tree_leaves


class MetalCompute(TorchDispatchMode):
    """Reject CPU tensor arithmetic while neural inference is executing.

    Storage-only operations may import constants/weights or export scalar
    control values. uint8 tensors are checkpoint byte destinations, not model
    activations. Missing MPS kernels still raise because fallback is disabled.
    """
    storage = {"aten._to_copy.default", "aten.copy_.default", "aten.lift_fresh.default",
               "aten.detach.default", "aten.empty.memory_format", "aten.empty_strided.default",
               "aten.clone.default", "aten._local_scalar_dense.default"}

    def __torch_dispatch__(self, func, types, args=(), kwargs=None):
        kwargs = kwargs or {}
        cpu_values = [x for x in tree_leaves((args, kwargs)) if isinstance(x, torch.Tensor)
                      and x.device.type == "cpu" and x.dtype != torch.uint8]
        transfer = str(func).startswith("aten.to.") and any(
            isinstance(value, (str, torch.device)) and str(value).startswith("mps")
            for value in tree_leaves((args, kwargs)))
        if cpu_values and str(func) not in self.storage and not transfer:
            raise RuntimeError(f"CPU tensor computation prohibited during Metal inference: {func}")
        return func(*args, **kwargs)
