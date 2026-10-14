"""Bounded, inference-only safetensors streaming for the SF3D CLI bridge.

No checkpoint mmap or state_dict: readinto fills two reusable CPU byte arenas.
A single reader prefetches the next unit while the current unit executes.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import math
import struct

import torch
from torch import nn

DTYPES = {"F64": torch.float64, "F32": torch.float32, "F16": torch.float16,
          "BF16": torch.bfloat16, "I64": torch.int64, "I32": torch.int32,
          "I16": torch.int16, "I8": torch.int8, "U8": torch.uint8, "BOOL": torch.bool}


class TensorFile:
    def __init__(self, path):
        self.path = str(path)
        with open(path, "rb") as f:
            raw = f.read(8)
            if len(raw) != 8:
                raise ValueError("Truncated safetensors header")
            size, = struct.unpack("<Q", raw)
            if size > 100_000_000:
                raise ValueError("Unreasonable safetensors header")
            self.entries = json.loads(f.read(size))
            self.base = 8 + size
            f.seek(0, 2)
            length = f.tell() - self.base
        self.aliases = self.entries.pop("__metadata__", {})
        for name, entry in self.entries.items():
            lo, hi = entry["data_offsets"]
            dtype = DTYPES[entry["dtype"]]
            count = math.prod(entry["shape"])
            if not 0 <= lo <= hi <= length or hi - lo != count * dtype.itemsize:
                raise ValueError(f"Invalid tensor extent: {name}")

    def resolve(self, name):
        seen = set()
        while name not in self.entries:
            if name in seen or name not in self.aliases:
                raise ValueError(f"Checkpoint is missing tensor {name}")
            seen.add(name)
            name = self.aliases[name]
        return name

    def read(self, name, target):
        entry = self.entries[self.resolve(name)]
        lo, hi = entry["data_offsets"]
        if target.numel() != hi - lo:
            raise ValueError(f"Wrong destination size for {name}")
        view = memoryview(target.numpy()).cast("B")
        with open(self.path, "rb", buffering=0) as f:
            f.seek(self.base + lo)
            while view:
                n = f.readinto(view)
                if not n:
                    raise EOFError(f"Short read: {name}")
                view = view[n:]


@dataclass
class Binding:
    name: str
    owner: nn.Module
    attr: str
    parameter: bool
    shape: tuple
    dtype: torch.dtype
    offset: int
    size: int

    def assign(self, value):
        if self.parameter:
            self.owner._parameters[self.attr] = nn.Parameter(value, requires_grad=False)
        else:
            self.owner._buffers[self.attr] = value


class WeightStream:
    """Two CPU slots + two device slots; non-unit weights are resident.

    All parameters must be meta at entry. Modules passed as units must be
    disjoint, listed in expected execution order. The plan validates every
    persistent tensor before allocating or running any model computation.
    """
    def __init__(self, model, checkpoint, units, device="cpu", progress=None):
        self.model = model
        self.progress = progress
        self.file = TensorFile(checkpoint)
        self.device = torch.device(device)
        self.units = list(units)
        if not self.units:
            raise ValueError("No streaming units found")
        modules = dict(model.named_modules())
        for name in self.units:
            if name not in modules:
                raise ValueError(f"Unknown unit: {name}")
            if any(name.startswith(other + ".") for other in self.units if other != name):
                raise ValueError("Nested streaming units are not supported")
        self.groups = {name: [] for name in self.units}
        self.resident = []
        sizes = {name: 0 for name in self.units}
        resident_size = 0
        # Traverse direct registrations so shared modulation aliases are included.
        for module_name, module in model.named_modules(remove_duplicate=False):
            for parameter, items in ((True, module._parameters), (False, module._buffers)):
                for attr, tensor in items.items():
                    if tensor is None or (not parameter and attr in module._non_persistent_buffers_set):
                        continue
                    name = f"{module_name}.{attr}" if module_name else attr
                    entry = self.file.entries[self.file.resolve(name)]
                    if tuple(entry["shape"]) != tuple(tensor.shape) or DTYPES[entry["dtype"]] != tensor.dtype:
                        raise ValueError(f"Checkpoint shape/dtype mismatch: {name}")
                    if parameter and not tensor.is_meta:
                        raise ValueError("Construct the model with empty (meta) parameters first")
                    group = next((u for u in self.units if name.startswith(u + ".")), None)
                    offset = sizes[group] if group else resident_size
                    offset = (offset + 63) // 64 * 64
                    size = tensor.numel() * tensor.element_size()
                    binding = Binding(name, module, attr, parameter, tuple(tensor.shape), tensor.dtype, offset, size)
                    if group:
                        self.groups[group].append(binding)
                        sizes[group] = offset + size
                    else:
                        self.resident.append(binding)
                        resident_size = offset + size
        self.slot_bytes = max(sizes.values())
        if not self.slot_bytes:
            raise ValueError("Streaming units contain no checkpoint tensors")
        self.stats = dict(slot_bytes=self.slot_bytes, host_slot_bytes=2*self.slot_bytes,
                          device_slot_bytes=0 if self.device.type == "cpu" else 2*self.slot_bytes,
                          resident_weight_bytes=resident_size, bytes_read=0, units_executed=0,
                          max_active_units=0)
        self.host = [torch.empty(self.slot_bytes, dtype=torch.uint8) for _ in range(2)]
        self.slots = self.host if self.device.type == "cpu" else [
            torch.empty(self.slot_bytes, dtype=torch.uint8, device=self.device) for _ in range(2)]
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sf3d-weights")
        self.pending = None
        self.active = None
        self.next_slot = 0
        self.hooks = []
        try:
            # Resident tensors are read individually; no full CPU model is created.
            for b in self.resident:
                raw = torch.empty(b.size, dtype=torch.uint8)
                self.file.read(b.name, raw)
                b.assign(raw.view(b.dtype).reshape(b.shape).to(self.device))
                self.stats["bytes_read"] += b.size
            # Empty-weight construction deliberately preserves real nonpersistent buffers.
            for module in model.modules():
                for attr in module._non_persistent_buffers_set:
                    value = module._buffers.get(attr)
                    if value is not None:
                        if value.is_meta:
                            raise ValueError(f"Nonpersistent buffer {attr} was constructed on meta")
                        module._buffers[attr] = value.to(self.device)
            for name in self.units:
                self.hooks.append(modules[name].register_forward_pre_hook(self._before(name)))
                self.hooks.append(modules[name].register_forward_hook(self._after(name), always_call=True))
        except BaseException:
            self.close()
            raise

    def _sync(self):
        if self.device.type == "cuda":
            torch.cuda.synchronize(self.device)
        elif self.device.type == "mps":
            torch.mps.synchronize()

    def _fill(self, name, slot):
        for b in self.groups[name]:
            self.file.read(b.name, self.host[slot][b.offset:b.offset+b.size])
        return sum(b.size for b in self.groups[name])

    def _before(self, name):
        def hook(module, args):
            if torch.is_grad_enabled():
                raise RuntimeError("Weight streaming requires torch.inference_mode()")
            if self.active is not None:
                raise RuntimeError("Concurrent/nested streamed inference is unsupported")
            if self.progress:
                self.progress("load", name)
            self._sync()
            slot = self.next_slot
            if self.pending:
                prefetched_name, prefetched_slot, future = self.pending
                self.pending = None
                self.stats["bytes_read"] += future.result()
                if prefetched_name == name:
                    slot = prefetched_slot
                else:
                    self.stats["bytes_read"] += self._fill(name, slot)
            else:
                self.stats["bytes_read"] += self._fill(name, slot)
            if self.device.type != "cpu":
                self.slots[slot].copy_(self.host[slot])
            for b in self.groups[name]:
                b.assign(self.slots[slot][b.offset:b.offset+b.size].view(b.dtype).reshape(b.shape))
            self.active = name
            self.stats["units_executed"] += 1
            self.stats["max_active_units"] = 1
            self.next_slot = 1 - slot
            index = self.units.index(name) + 1
            if index < len(self.units):
                next_name = self.units[index]
                self.pending = (next_name, self.next_slot,
                                self.pool.submit(self._fill, next_name, self.next_slot))
        return hook

    def _after(self, name):
        def hook(module, args, output):
            if self.active == name:
                self._sync()
                for b in self.groups[name]:
                    b.assign(torch.empty(b.shape, dtype=b.dtype, device="meta"))
                self.active = None
                if self.progress:
                    self.progress("done", name)
            return output
        return hook

    def close(self):
        self.pool.shutdown(wait=True)
        for hook in self.hooks:
            hook.remove()
        self.hooks.clear()


def sf3d_units(model):
    """Stream DINO layers, each reconstruction fuse/basic block, and estimators."""
    names = dict(model.named_modules())
    layers = model.image_tokenizer.model.encoder.layer
    result = [f"image_tokenizer.model.encoder.layer.{i}" for i in range(len(layers))]
    for i, block in enumerate(model.backbone.main_blocks):
        prefix = f"backbone.main_blocks.{i}"
        result.append(prefix + ".fuse_block_in")
        result.extend(prefix + f".transformer_block.{j}" for j in range(len(block.transformer_block)))
        result.append(prefix + ".fuse_block_out")
    # DINO modulation modules are also registered outside their layers. Remove
    # those duplicate registrations; layer-owned modules remain authoritative.
    model.image_tokenizer.modulations = nn.ModuleList()
    # Upsampler convolutions run once in sequence and can share the slots.
    for name, module in model.post_processor.named_modules():
        if isinstance(module, nn.Conv2d):
            result.append("post_processor." + name)
    if model.image_estimator is not None:
        clip = model.image_estimator.model
        # encode_image only uses visual. Leave the unused text tower out of
        # the execution model, rather than loading hundreds of unused MB.
        class VisualOnly(nn.Module):
            def __init__(self, visual):
                super().__init__()
                self.visual = visual

            def encode_image(self, image):
                return self.visual(image)
        model.image_estimator.model = VisualOnly(clip.visual)
        for i in range(len(clip.visual.transformer.resblocks)):
            result.append(f"image_estimator.model.visual.transformer.resblocks.{i}")
    if model.global_estimator is not None:
        result.append("global_estimator")
    return result
