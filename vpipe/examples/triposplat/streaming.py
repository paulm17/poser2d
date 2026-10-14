"""Inference-only, two-slot disk -> Metal checkpoint streaming.

CPU tensors are byte destinations for I/O only. All casts execute on MPS.
There is no full state dictionary, checkpoint mmap, or CPU inference path.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import math
import struct
import time

import torch
from torch import nn

DTYPES = {"F64": torch.float64, "F32": torch.float32, "F16": torch.float16,
          "BF16": torch.bfloat16, "I64": torch.int64, "I32": torch.int32,
          "I16": torch.int16, "I8": torch.int8, "U8": torch.uint8, "BOOL": torch.bool}


class TensorFile:
    def __init__(self, path, rename=lambda name: name):
        self.path = str(path)
        with open(path, "rb") as f:
            prefix = f.read(8)
            if len(prefix) != 8:
                raise ValueError("Truncated safetensors header")
            length, = struct.unpack("<Q", prefix)
            if not 2 <= length <= 100_000_000:
                raise ValueError("Invalid safetensors header length")
            header = f.read(length)
            if len(header) != length:
                raise ValueError("Truncated safetensors header")
            entries = json.loads(header)
            self.base = 8 + length
            f.seek(0, 2)
            available = f.tell() - self.base
        self.entries = entries
        aliases = entries.pop("__metadata__", {})
        self.names = {}
        spans = []
        for name, entry in entries.items():
            if entry.get("dtype") not in DTYPES:
                raise ValueError(f"Unsupported checkpoint dtype: {name}")
            lo, hi = entry["data_offsets"]
            shape = entry["shape"]
            if any(not isinstance(n, int) or n < 0 for n in shape):
                raise ValueError(f"Invalid shape: {name}")
            if not 0 <= lo <= hi <= available or hi - lo != math.prod(shape)*DTYPES[entry["dtype"]].itemsize:
                raise ValueError(f"Invalid tensor extent: {name}")
            spans.append((lo, hi))
            target = rename(name)
            if target is not None:
                if target in self.names:
                    raise ValueError(f"Duplicate checkpoint mapping: {target}")
                self.names[target] = name
        spans.sort()
        if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
            raise ValueError("Overlapping checkpoint tensors")
        for alias, original in aliases.items():
            target = rename(alias)
            if target is not None and original in entries:
                self.names.setdefault(target, original)

    def entry(self, name):
        if name not in self.names:
            raise ValueError(f"Checkpoint is missing tensor {name}")
        return self.entries[self.names[name]]

    def read(self, name, destination):
        lo, hi = self.entry(name)["data_offsets"]
        if destination.numel() != hi-lo:
            raise ValueError(f"Wrong byte destination size: {name}")
        view = memoryview(destination.numpy()).cast("B")
        with open(self.path, "rb", buffering=0) as f:
            f.seek(self.base+lo)
            while view:
                count = f.readinto(view)
                if not count:
                    raise EOFError(f"Checkpoint short read: {name}")
                view = view[count:]


def align(value):
    return (value+63)//64*64


@dataclass
class Binding:
    name: str
    owner: nn.Module
    attr: str
    parameter: bool
    shape: tuple
    source_dtype: torch.dtype
    dtype: torch.dtype
    raw_offset: int
    offset: int
    raw_size: int
    size: int

    def assign(self, tensor):
        if self.parameter:
            self.owner._parameters[self.attr] = nn.Parameter(tensor, requires_grad=False)
        else:
            self.owner._buffers[self.attr] = tensor

    def release(self):
        self.assign(torch.empty(self.shape, dtype=self.dtype, device="meta"))


class MetalWeights:
    """Only the current stage's small trunk and two block arenas stay live.

    Units must be non-overlapping module paths in expected traversal order.
    Reordered, repeated and skipped units are supported. One inference at once.
    close() releases *all* weights, buffers, hooks and arenas, including on error.
    """
    def __init__(self, model, path, units, dtype, rename=lambda name: name, progress=None):
        if not torch.backends.mps.is_available():
            raise RuntimeError("Metal (PyTorch MPS) is required")
        self.model, self.progress = model, progress
        self.file = TensorFile(path, rename)
        self.units = list(units)
        modules = dict(model.named_modules())
        if len(set(self.units)) != len(self.units):
            raise ValueError("Duplicate streaming unit")
        for name in self.units:
            if name not in modules:
                raise ValueError(f"Unknown streaming unit: {name}")
            if any(name.startswith(other+'.') for other in self.units if other != name):
                raise ValueError("Nested streaming units are unsupported")
        self.groups = {name: [] for name in self.units}
        self.resident = []
        self.buffers = []
        raw_sizes = {name: 0 for name in self.units}
        sizes = dict(raw_sizes)
        resident_size = 0
        # Duplicate module aliases would otherwise let a resident alias overwrite
        # a streamed binding. These upstream models have no module aliases.
        seen = set()
        for module_name, module in model.named_modules(remove_duplicate=False):
            if id(module) in seen:
                raise ValueError(f"Shared module registration needs explicit mapping: {module_name}")
            seen.add(id(module))
            for parameter, items in ((True, module._parameters), (False, module._buffers)):
                for attr, tensor in items.items():
                    if tensor is None:
                        continue
                    if not parameter and attr in module._non_persistent_buffers_set:
                        if tensor.is_meta:
                            raise ValueError(f"Missing nonpersistent buffer values: {module_name}.{attr}")
                        self.buffers.append((module, attr, tensor))
                        continue
                    name = f"{module_name}.{attr}" if module_name else attr
                    entry = self.file.entry(name)
                    if tuple(entry["shape"]) != tuple(tensor.shape):
                        raise ValueError(f"Checkpoint shape mismatch: {name}")
                    if parameter and not tensor.is_meta:
                        raise ValueError("Model parameters must be constructed on meta")
                    source = DTYPES[entry["dtype"]]
                    target = dtype if source.is_floating_point else source
                    group = next((unit for unit in self.units if name.startswith(unit+'.')), None)
                    raw_size = math.prod(tensor.shape)*source.itemsize
                    size = math.prod(tensor.shape)*target.itemsize
                    if size > raw_size:
                        raise ValueError(f"Widening checkpoint conversion is unsupported: {name}")
                    raw_offset = align(raw_sizes[group]) if group else 0
                    offset = align(sizes[group]) if group else 0
                    b = Binding(name, module, attr, parameter, tuple(tensor.shape), source, target,
                                raw_offset, offset, raw_size, size)
                    if group:
                        self.groups[group].append(b)
                        raw_sizes[group] = raw_offset+raw_size
                        sizes[group] = offset+size
                    else:
                        self.resident.append(b)
                        resident_size += size
        if self.units and any(not self.groups[name] for name in self.units):
            raise ValueError("Empty streaming unit")
        self.raw_sizes = raw_sizes
        self.slot_bytes = max(raw_sizes.values(), default=0)
        self.stats = dict(slot_bytes=self.slot_bytes, host_slot_bytes=2*self.slot_bytes,
                          metal_slot_bytes=2*self.slot_bytes, resident_weight_bytes=resident_size,
                          bytes_read=0, prefetched_bytes=0, metal_bytes_copied=0, units_started=0, units_completed=0,
                          max_active_units=0, max_conversion_tensor_bytes=0,
                          max_observed_metal_allocated_bytes=0, closed=False)
        self.host, self.slots, self.hooks = [], [], []
        self.pending = None
        self.active = None
        self.next_slot = 0
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="triposplat-weights")
        self.closed = False
        try:
            if self.slot_bytes:
                self.host = [torch.empty(self.slot_bytes, dtype=torch.uint8) for _ in range(2)]
                self.slots = [torch.empty(self.slot_bytes, dtype=torch.uint8, device="mps") for _ in range(2)]
            for b in self.resident:
                raw = torch.empty(b.raw_size, dtype=torch.uint8)
                self.file.read(b.name, raw)
                value = raw.to("mps").view(b.source_dtype).reshape(b.shape)
                b.assign(value.to(dtype=b.dtype))
                self.stats["bytes_read"] += b.raw_size
            for module, attr, value in self.buffers:
                target = dtype if value.is_floating_point() else value.dtype
                module._buffers[attr] = value.to("mps").to(dtype=target)
            # Do not retain the original CPU buffer tensors.
            self.buffers = [(module, attr, None) for module, attr, _ in self.buffers]
            for name in self.units:
                self.hooks.append(modules[name].register_forward_pre_hook(self._before(name)))
                self.hooks.append(modules[name].register_forward_hook(self._after(name), always_call=True))
            self.observe()
        except BaseException:
            self.close()
            raise

    def observe(self):
        self.stats["max_observed_metal_allocated_bytes"] = max(
            self.stats["max_observed_metal_allocated_bytes"], torch.mps.current_allocated_memory())

    def _fill(self, name, slot):
        for b in self.groups[name]:
            self.file.read(b.name, self.host[slot][b.raw_offset:b.raw_offset+b.raw_size])
        return sum(b.raw_size for b in self.groups[name])

    def _join(self):
        if self.pending is None:
            return None
        name, slot, future = self.pending
        self.pending = None
        count = future.result()
        self.stats["bytes_read"] += count
        self.stats["prefetched_bytes"] += count
        return name, slot

    def _before(self, name):
        def hook(module, args):
            if self.closed:
                raise RuntimeError("Checkpoint stage has been released")
            if torch.is_grad_enabled():
                raise RuntimeError("Streaming requires torch.inference_mode()")
            if self.active is not None:
                raise RuntimeError("Concurrent or nested streamed inference is unsupported")
            if self.progress:
                self.progress("load", name)
            torch.mps.synchronize()
            ready = self._join()
            slot = ready[1] if ready and ready[0] == name else self.next_slot
            if not ready or ready[0] != name:
                self.stats["bytes_read"] += self._fill(name, slot)
            transfer_bytes = self.raw_sizes[name]
            self.slots[slot][:transfer_bytes].copy_(self.host[slot][:transfer_bytes])
            self.stats["metal_bytes_copied"] += transfer_bytes
            for b in self.groups[name]:
                source = self.slots[slot][b.raw_offset:b.raw_offset+b.raw_size].view(b.source_dtype)
                target = self.slots[slot][b.offset:b.offset+b.size].view(b.dtype)
                if b.source_dtype != b.dtype or b.offset != b.raw_offset:
                    # Process tensors in file-plan order. Narrowed destinations
                    # end before the next raw tensor; a temporary avoids overlap
                    # within the current tensor. The cast executes on Metal.
                    converted = source.to(dtype=b.dtype) if b.source_dtype != b.dtype else source.clone()
                    self.stats["max_conversion_tensor_bytes"] = max(
                        self.stats["max_conversion_tensor_bytes"], b.size)
                    target.copy_(converted)
                    del converted
                b.assign(target.reshape(b.shape))
            self.active = name
            self.stats["units_started"] += 1
            self.stats["max_active_units"] = 1
            self.next_slot = 1-slot
            index = self.units.index(name)+1
            if index < len(self.units):
                following = self.units[index]
                self.pending = (following, self.next_slot,
                                self.pool.submit(self._fill, following, self.next_slot))
            self.observe()
        return hook

    def _after(self, name):
        def hook(module, args, output):
            if self.active == name:
                torch.mps.synchronize()
                self.observe()
                for b in self.groups[name]:
                    b.release()
                self.active = None
                if output is not None:
                    self.stats["units_completed"] += 1
                if self.progress:
                    self.progress("done", name)
            return output
        return hook

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self._join()
        finally:
            self.pool.shutdown(wait=True)
            torch.mps.synchronize()
            for hook in self.hooks:
                hook.remove()
            self.hooks.clear()
            for group in [self.resident, *self.groups.values()]:
                for b in group:
                    b.release()
            for module, attr, _ in self.buffers:
                value = module._buffers[attr]
                module._buffers[attr] = torch.empty_like(value, device="meta")
            self.active = None
            self.host.clear()
            self.slots.clear()
            self.stats["closed"] = True
            torch.mps.empty_cache()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
