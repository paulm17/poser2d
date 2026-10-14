# TripoSplat integration assessment

Assessed 2026-10-14 against the local TripoSplat checkout and cached VAST-AI
checkpoints. Scope: CLI generation with weight streaming as the priority.

## Finding

TripoSplat is a feasible target for vpipe. Its major networks have explicit
sequential transformer-block loops, compatible with vpipe's two reusable block
slots, prefetch and optional resident-block promotion. It is not currently a
supported native model. A Python streaming bridge and a native C++/Metal port
are distinct deliverables.

Streaming need not change model quality: preserve image preprocessing, model
arithmetic, sampling schedule, guidance, decoder and Gaussian output. Native
numerical parity must still be established; this assessment is not a claim
that the complete port already works or a speed/memory benchmark.

## Practical probe

Used actual weights from `diffusion_models/triposplat_fp16.safetensors`:
`repo_layers.0` and `blocks.0`. Executed their real upstream RePo positional
embedding, attention, normalization, modulation and MLP on MPS with fp16
parameters, a 31-token input and the checkpoint's full 1024-channel width.

Compared independent permanent tensors loaded with official safetensors against
the reusable-buffer Python streamer built for the SF3D bridge. Three repeated
runs produced maximum absolute differences `[0.0, 0.0, 0.0]`. The two modules
executed six streamed units in total. Slot capacity was 25,200,640 bytes; two
host and two MPS slots were allocated. This proves a real block can be streamed
without changing its tested outputs. It does not validate the full 12,294-token
flow pass, DINOv3, decoder, full generation, or native Metal kernels.

## Components and existing vpipe coverage

| Component | Local TripoSplat code | vpipe reuse and required work |
|---|---|---|
| Foreground preprocessing | `triposplat.py:437` | Preserve alpha handling, erosion, crop and 1024 canvas. BiRefNet is unnecessary for input that already has real alpha, including the supplied image; it is needed for the general opaque-image path. |
| DINOv3 image encoder | `model.py:107` | 32 blocks, 1280 channels. Stream one block at a time. Reuse tensor/GEMM/attention primitives, but implement the actual DINOv3 tower: DINOv2 is not a drop-in replacement. Differences include patch size, register tokens, 2D rotary positions and gated MLP. |
| Flux2 VAE image encoder | `model.py:257` | Existing `MetalFlux2Vae` is a strong reuse candidate. Match convolution/downsampling, stochastic posterior sampling, pixel unshuffle and running-stat normalization against TripoSplat. Do not assume compatibility from the family name alone. |
| Flow generation model | `model.py:1573` | 24 main blocks, plus two noise refiners and two context refiners. Implement family-specific equations/checkpoint mapping using existing dense attention, norms, modulation and MLP primitives. Stream each RePo module with its associated transformer block where practical. |
| Octree probability decoder | `model.py:1328` | Four cross-attention blocks invoked at eight octree levels. Needs density-controlled point selection, prefix sums/scatter and count expansion. Small host-side sampling implementation is possible first, with parity checks. |
| Gaussian decoder | `model.py:1476` | 16 transformer blocks plus attribute heads. Stream blocks, retain point activations and export colour, opacity, position, scale and rotation. |
| Export | `triposplat.py:183` | Existing upstream `.ply` and `.splat` writers are a usable reference. No mesh extraction/UV baking required. Native writer integration is new work. |

The separate `triposplat_vae_encoder_fp16.safetensors` checkpoint encodes training
3D representations and is not loaded by the image-to-Gaussians runner. Do not
include it in the runtime weight budget.

Relevant vpipe infrastructure:
- `generative-models/shared/block-slots.h`: reusable destinations, prefetch,
  promotion and lifetime management.
- `generative-models/weight-set.h`: checkpoint ownership and direct reads.
- `generative-models/flux2/metal-flux2-transformer.h`: established streamed
  transformer execution pattern.
- `generative-models/flux2/metal-flux2-vae.h`: VAE encoder building blocks.

## Checkpoint inspection

Sizes below were read from the actual local safetensors headers, not inferred
from marketing model names. Decimal MB:

| Runtime component | Checkpoint tensor bytes | Largest relevant block |
|---|---:|---:|
| DINOv3 | 1,681,185,280 (BF16) | 52,474,880 |
| Flow model | 741,052,202 (F16) | 25,200,640 main block, excluding paired RePo weights |
| Octree + Gaussian decoder | 576,107,666 (F16) | 29,464,576 Gaussian block |
| Flux2 VAE encoder portion | approximately 137,704,456 (F32 on disk) | Stage/block residency or convolution streaming can be chosen separately |
| Optional BiRefNet | 444,386,812 (mostly F16) | Stream inner Swin blocks rather than treating an entire Swin stage as one block |

The Flux2 file also contains an unused decoder: the whole file is 336,185,492
bytes, but image conditioning only needs its encoder, quantization convolution
and running statistics. Runtime uses BF16 there, so disk and live weight byte
counts differ. Total useful stored tensors are approximately 3.14 GB without
BiRefNet, or 3.58 GB with it. These are not activation-inclusive memory floors.

## Streaming trade-off

The default local runner uses 20 sampling steps and guidance 3.0. The current
sampler performs a conditional and an unconditional model pass at every step:
40 flow forwards. The main 24 blocks total 604,815,360 bytes. With both refiner
stacks, transformer blocks alone account for about 705.6 MB per forward, or
28.2 GB of logical weight reads over 40 forwards if none stay resident. Reading
the entire flow checkpoint each time would be about 29.6 GB. These are traffic
estimates, not measured SSD reads or duration; OS caching, reuse and scheduling
matter.

Use vpipe's resident-block policy when memory allows. Running both guidance
branches through each acquired block can also reduce duplicate weight reads,
at the expense of retaining both activation streams and additional scheduling
work. Do not disable guidance or reduce steps as an undocumented memory
optimization: that changes the generation settings and potentially quality.

The octree stack repeats across levels too, so retaining its relatively small
block stack may be worthwhile. Encoders and decoder should not all stay on the
device together: retain their outputs and release completed stage weights.

## Remaining memory and numerical risks

- The flow model attends over 8192 latent tokens, 4101 image tokens and one
  camera token: 12,294 total at the default 1024 conditioning resolution.
  A naive 16-head fp16 full attention score matrix alone would be about
  4.84 GB per batch item. Use tiled/memory-efficient noncausal attention;
  streaming weights does not remove attention or activation memory.
- Maximum 262,144 Gaussians means 8192 Gaussian-decoder point tokens (32
  Gaussians per point), versus 1024 point tokens for the runner's 32,768 output.
- RePo computes content-dependent rotary phases through learned projections.
  It is not standard fixed-position RoPE; match fp32 phase/complex rotation
  semantics carefully in real-valued Metal code.
- Preserve mixed precision, layer-norm epsilons, stochastic VAE sampling and
  probability/count selection. A common random seed alone does not guarantee
  identical random streams across PyTorch and native generators; captured
  random tensors are useful parity fixtures.
- Gaussian files require a splat renderer. The existing scene-builder GLB
  importer cannot render them merely by renaming the file. Converting splats
  to an ordinary mesh is separate work and may lose appearance detail.

## Suggested implementation sequence

1. Establish saved upstream fixtures for the supplied image, including prepared
   image, encoder features, noise, sampled latent and Gaussian attributes.
2. Build a CLI streaming bridge using unchanged upstream operators, stage
   release and streamed DINO/flow/decoder blocks; verify full-run quality parity.
3. Port the native flow model first, retaining the reference encoders/decoder
   as validation boundaries. Integrate `WeightSet`/`BlockSlots` from the start.
4. Add native DINOv3, validate/adapt the existing Flux2 VAE encoder, then port
   octree selection and Gaussian decoding/export.
5. Profile full-size activation/attention memory and weight traffic before
   claiming a device memory floor or runtime improvement.

The investigation itself did not implement the complete pipeline. The subsequent
[Metal-only Python streaming CLI](../examples/triposplat/README.md) implements
the first bridge phase; native C++/Metal integration remains separate.
