# TripoSplat streaming CLI — Metal only

Generate TripoSplat `.ply` and `.splat` files with bounded weight streaming on
Apple Silicon. Neural inference uses PyTorch MPS (Metal) exclusively. There is
no device selector, CUDA execution or CPU inference fallback.

This is a Python CLI bridge in vpipe, not the native C++/Metal model port.
It uses the upstream TripoSplat operators with a separate streaming adapter;
it does not call the C++ `WeightSet` API. The SF3D bridge is unchanged.

## Setup

Use Python 3.11 on a Mac with MPS support and a local TripoSplat source checkout.
From this directory:

```sh
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Weights must already exist in the Hugging Face cache, or a directory with:

```text
clip_vision/dino_v3_vit_h.safetensors
vae/flux2-vae.safetensors
diffusion_models/triposplat_fp16.safetensors
vae/triposplat_vae_decoder_fp16.safetensors
background_removal/birefnet.safetensors  # only for opaque input
```

No weights are downloaded by this CLI. The separate 3D VAE encoder checkpoint
is not used for image-to-Gaussian inference.

## Run

```sh
env -u PYTORCH_ENABLE_MPS_FALLBACK .venv/bin/python run.py /path/to/image.png \
  --triposplat-source /path/to/TripoSplat \
  --output-dir output/character
```

The default cache is `~/.cache/huggingface/hub`. Add `--cache-dir /path/to/cache`
or `--model-dir /path/to/checkpoints` to change the checkpoint location.

Defaults match the existing image runner: seed **42**, **20 steps**, guidance
**3.0**, **32,768 Gaussians**. Options: `--seed`, `--steps`, `--guidance`,
`--num-gaussians` and `--verbose`. Gaussian counts must be multiples of 32 from
32,768 through 262,144. No resolution or generation setting is reduced silently.

Outputs use the image's stem:

- `image.ply` and `image.splat`: Gaussian assets, not ordinary meshes/GLBs.
- `image_preprocessed.png`: the actual 1024-pixel conditioning image.
- `image.streaming.json`: completion/error status, settings, checkpoint paths,
  stage timing, byte traffic, weight-buffer allocations and memory observations.

The decoder's global MPS random generator is explicitly seeded, in addition to
the original VAE/flow generator, so repeated invocations are reproducible.
Upstream does not explicitly seed that decoder generator in its image runner;
validation controls it rather than comparing unrelated random point samples.

## Streaming and Metal guarantees

- Parameters are constructed on meta. Checkpoint mappings, shapes, extents and
  types are checked before the stage executes. No complete CPU state dictionary
  or checkpoint mmap is created.
- Each stage has two reusable host byte slots and two reusable Metal slots.
  One reader prefetches the next unit while the current unit computes. Metal
  buffers are synchronized before reuse; completed block parameters return to
  meta. Repeated/skipped traversals are supported.
- DINOv3, flow refiners/positional modules/main blocks, octree and Gaussian
  decoder blocks are streamed. VAE residual/downsampling/attention blocks and
  BiRefNet Swin blocks are streamed too. Smaller trunk weights remain resident
  only during their stage.
- Stages release parameters, buffers, pending reads and slot storage when
  finished, including on failure. Activations needed by later stages remain.
- Checkpoint dtype conversion executes on Metal. Narrowing an FP32 VAE tensor
  uses a temporary Metal tensor bounded by the largest converted tensor; this
  is counted separately from the two reusable slots.
- Input with real transparency skips BiRefNet. Opaque images use a Metal-only
  deformable convolution implemented with grid sampling and matrix products.
- Fixed timestep/level frequency tables preserve upstream float32 constants
  while eliminating its CPU frequency arithmetic during inference.
- Enabled `PYTORCH_ENABLE_MPS_FALLBACK` is rejected before torch initialization.
  An inference dispatch guard also rejects CPU tensor arithmetic. Unsupported
  Metal kernels fail explicitly. Host work handles image preparation, I/O,
  orchestration and export; fixed model constants are initialized during setup.

Weight buffers are bounded, not all pipeline memory. Activations, attention
scratch, converted tensors, outputs and Metal allocator/driver caches are extra.
Memory observations in the report are samples at block boundaries, not a claim
of exact peak GPU usage. Peak process RSS is recorded separately. Logical bytes
read do not necessarily equal physical SSD traffic because of filesystem caching.

Streaming repeatedly reloads the flow model across all guidance passes. It
trades weight memory for traffic; it is not advertised as faster than resident
TripoSplat. No quantization, altered sampling or resident-block cache is used.

## Tests and real-checkpoint validation

```sh
.venv/bin/pip install pytest
TRIPOSPLAT_SOURCE=/path/to/TripoSplat .venv/bin/python -m pytest -q test_streaming.py
```

For the independent resident-weight control and streamed pipeline, run these
in separate processes with identical settings. The reference intentionally
retains the upstream fixed-frequency implementation as an oracle; the public
CLI never uses that CPU arithmetic.

```sh
env -u PYTORCH_ENABLE_MPS_FALLBACK .venv/bin/python validate.py \
  --mode reference --capture-dir output/reference /path/to/image.png \
  --triposplat-source /path/to/TripoSplat
env -u PYTORCH_ENABLE_MPS_FALLBACK .venv/bin/python validate.py \
  --mode streamed --capture-dir output/streamed /path/to/image.png \
  --triposplat-source /path/to/TripoSplat
.venv/bin/python compare.py output/reference output/streamed --report output/parity.json
```

`compare.py` requires exact equality by default and reports differences for
prepared pixels, image features, sampled latent/camera, decoder random state
and raw Gaussian attributes. Captures are optional validation artifacts, not
additional copies held by the production pipeline.

Exercise maximum-density decoding from a saved latent:

```sh
env -u PYTORCH_ENABLE_MPS_FALLBACK .venv/bin/python validate.py \
  --mode decode --latent-dir output/reference --capture-dir output/maximum \
  /path/to/image.png --triposplat-source /path/to/TripoSplat \
  --num-gaussians 262144
```

For an opaque-image preprocessing check, use `--mode background` with an RGB
input and its own `--capture-dir`. Unit tests validate the Metal deformable
convolution against tiny independent torchvision CPU test fixtures; the runtime
has no CPU deformable-convolution fallback.

Checkpoint mapping, Gaussian construction and positional constants adapt the
MIT-licensed upstream TripoSplat implementation. Its notice is retained in
[TRIPOSPLAT-LICENSE](TRIPOSPLAT-LICENSE).
