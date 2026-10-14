# Stable Fast 3D streaming CLI

This is a **PyTorch CLI bridge**, using SF3D's operators and mesh/UV/texture
implementation. It is not a native vpipe Metal model or a registered vpipe
pipeline stage. It implements vpipe's two-slot weight-streaming strategy in
Python; it does not call the C++ `WeightSet` API.

## Streaming contract

- Construct parameters on `meta`, without downloading/loading DINO or CLIP
  pretrained weights. Real nonpersistent buffers retain their initial values.
- Validate checkpoint names, aliases, shapes, dtypes and extents before inference.
- Keep weights on disk, without a checkpoint mmap or a full state dictionary.
- Read directly into two reusable CPU arenas with `readinto`; prefetch the next
  unit on one reader thread while the current unit executes.
- On MPS/CUDA, copy into two reusable device arenas. Synchronize before reuse;
  completed units have their parameters replaced by meta tensors.
- Stream individual DINO layers; reconstruction fuse and basic blocks;
  upsampler convolutions; CLIP visual residual blocks; and the global estimator.
  CLIP's unused text tower is removed from the execution model.
- Other weights are resident. The CLI reports their byte count separately.
  Slot allocation depends on the largest unit, not the number of blocks.
- Chunk geometry/texture sampling **and decoding together**, avoiding a full
  `N x 120` sampled-feature allocation. Required decoded outputs are preallocated.

CPU arena allocation is `2 * largest_unit`; non-CPU devices additionally
allocate `2 * largest_unit` on device. Resident weights, activations, tetrahedra,
mesh and texture memory are additional. macOS unified memory does not eliminate
the host/device arena copies. File-system caching is controlled by the OS.
There is no resident-block cache, quantization, or native vpipe acceleration yet.
One model instance supports one inference at a time, under `torch.inference_mode`.
On MPS, UV principal-axis alignment runs on CPU to avoid an upstream PCA/SVD
stall; its result returns to MPS for the remaining mesh/texture operations.

## Setup

Use an existing SF3D source checkout with its `load/tets/160_tets.npz` asset.
From this directory, with Python 3.11:

```sh
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
# Replace SF3D_SOURCE with the path to the upstream checkout.
.venv/bin/pip install --no-build-isolation "$SF3D_SOURCE/texture_baker" "$SF3D_SOURCE/uv_unwrapper"
```

The native extensions require a working C++ toolchain. On Apple Silicon build
the texture baker with `USE_METAL=1`; the UV extension requires libomp.

Accept the model's license on Hugging Face and authenticate locally before
fetching `stabilityai/stable-fast-3d`'s `config.yaml` and `model.safetensors`.
Also fetch `facebook/dinov2-large`'s `config.json` (configuration only).
The runtime uses local paths and does not require network access.

## Run

```sh
.venv/bin/python run.py /path/to/image.png \
  --sf3d-source "$SF3D_SOURCE" \
  --model /path/to/local/sf3d-model \
  --dino-config /path/to/dinov2-large/config.json \
  --device mps --texture-resolution 1024 \
  --query-chunk-size 32768 --output output/mesh.glb
```

RGBA alpha is preserved. For opaque input needing segmentation, add
`--remove-background` (rembg may download its segmentation model). Foreground
is centered/resized with SF3D's existing preprocessing. Output includes the
GLB, prepared input PNG and `.streaming.json` counters (including elapsed
inference/export time and process peak RSS). CPU execution is useful
for operator testing; texture baking depends on upstream device support.

## Verification

```sh
.venv/bin/pip install pytest
SF3D_SOURCE="$SF3D_SOURCE" .venv/bin/python -m pytest -q test_streaming.py
```

Tests compare streamed and resident results over repeated runs, verify fixed
arena sizes as depth grows, cover skipped/reordered units and failure cleanup,
validate checkpoint aliases/missing tensors, and exercise MPS where available.
With `SF3D_SOURCE` set, they also test upstream DINO and reconstruction operators.

## Recorded validation

On 2026-10-14, using upstream SF3D revision
`ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2` and checkpoint revision
`f0c9a8ffd62cb1bbc8a7a53c9f87a0be1b6be778`:

- 16 tests passed, including upstream operators on CPU and MPS.
- The supplied RGBA image exported successfully with both 512 and 1024 textures.
- The 1024 GLB reloaded with 9,150 UV-split vertices and 14,988 triangles;
  vertex coordinates were finite and the embedded base-color texture was 1024².
- 60 streaming units executed; at most one unit was bound at once.
- Each slot was 83,955,712 bytes. Host slots + device slots + resident weights
  occupied 503,267,844 bytes (about 480 MiB), excluding other pipeline memory.
- The final 1024 run recorded 6.11 seconds for preprocessing/inference/export
  and 1,312,309,248 bytes peak process RSS. This excludes model setup time and
  is one observed run, not a resident-versus-streamed performance benchmark or
  an assertion about total GPU memory.

The local result files are under `output/` (ignored by Git). Test dependencies
and model downloads were prepared in `/private/tmp/vpipe-sf3d-*`; use the setup
instructions above for a durable environment/cache.
