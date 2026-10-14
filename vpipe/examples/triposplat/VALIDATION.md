# Validation — 2026-10-14

Environment: Apple Silicon, Python 3.11, PyTorch 2.14.1, torchvision 0.29.1.
Upstream TripoSplat base revision: `d8db9e018b413dd9c4a9fe22463781bf98e8e68d`.
The local upstream checkout includes its existing image runner/export changes;
validation used the actual local implementation and cached checkpoints.

## Result

**18 tests passed.** Tested MPS parity, FP32-to-BF16 narrowing and integer
buffers, fixed slot capacity, repeated/reordered traversal, read/forward failure
cleanup, CPU-arithmetic rejection, fallback rejection, unavailable-Metal errors,
checkpoint mappings/extents, exact positional constants, Gaussian construction,
Metal deformable convolution and binary export validation.

The supplied `1.png` completed with the normal **20 steps**, guidance **3.0**,
seed **42**, and **32,768 Gaussians**, without reducing conditioning resolution.

The independent permanent-weight reference and guarded streamed run matched
**bit-for-bit** for prepared pixels, DINOv3 features, VAE features, final latent,
camera, decoder RNG state and all raw Gaussian attributes. Both exported files
were also byte-identical:

| File | SHA-256 |
|---|---|
| SPLAT | `5284ead3527a6d177a6a3eefcdfe17c1377e6ce6ea86b4c258e70ea59d28f677` |
| PLY | `7cc236d8b598a7483621b88e065d3e283fe8438a291ea2fa456a63093a4d42e1` |

The resident reference deliberately uses unmodified upstream fixed-frequency
arithmetic as an oracle. The production CLI loads exact constant tables onto
Metal and enforces its CPU-arithmetic guard. Both tests and real captures
confirmed equality; no CPU inference fallback is used by the CLI.

The exported default model was loaded in the existing Spark viewer and inspected
from front, side and back. It retains the face, hand and fabric appearance of
the TripoSplat result rather than the coarse SF3D reconstruction.

## Streaming and additional paths

| Stage | Streamed unit executions | Each slot, bytes | Resident weights, bytes |
|---|---:|---:|---:|
| DINOv3 | 32 | 52,474,880 | 1,986,560 |
| Flux2 VAE | 14 | 18,886,656 | 608,008 |
| Flow, 20 steps and both guidance branches | 2,240 | 25,200,640 | 20,301,866 |
| Octree + Gaussian decoder | 48 | 29,464,576 | 20,436,114 |
| Opaque-image BiRefNet check | 48 | 56,879,744 | 62,442,004 |

Each stage uses two host slots and two Metal slots and binds at most one unit
at a time. All completed stages reported closed/released state. For RGBA input,
the largest stage weight allocation is approximately **202 MiB**, excluding
activations, tiny constants, cast temporaries and allocator/driver caches.
The opaque-image stage additionally uses its own larger buffers and trunk.

- Full-size opaque RGB preprocessing succeeded on Metal, including the new
  deformable convolution. Its prepared image and stage counters were saved.
- **262,144-Gaussian decoding** succeeded from the reference latent with the
  CPU-arithmetic guard enabled. PLY and SPLAT counts, sizes and finite attributes
  passed validation. This exercises maximum-density decoding, not a second
  complete image-generation pass at maximum output density.
- A default CLI run recorded about **356 seconds** and **754,122,752 bytes peak
  process RSS**. Later parity runs shared the GPU and their timing is not a
  resident-versus-streamed benchmark. RSS is not total/peak GPU memory.
- The 20-step streamed flow logically read approximately **28.85 GB**. Filesystem
  caching affects physical SSD traffic; streaming trades weight memory for reads.
- The final transfer implementation copies only the current unit's used bytes
  into its fixed Metal slot. Unit tests and maximum-density decoding exercised
  this bounded-transfer variant; the full parity run used the same bindings
  with a full-slot byte copy. Only unbound padding/unused slot bytes differ.

Reproducible commands are in [README.md](README.md). Local captures, full parity
metrics, reports and assets are retained under the ignored `output/` directory.
No source in the SF3D bridge or the upstream TripoSplat checkout was modified.
