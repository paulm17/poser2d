# SF3D versus TripoSplat on the supplied character image

Investigated 2026-10-14. The observed SF3D loss of detail is already present in
its predicted geometry/colour field. Weight streaming and query chunking did
not change the tested neural outputs. This is a finding for this image and
checkpoint, not a general ranking of the models.

## Controls performed

The input was the original `Desktop/1.png`, not either viewer screenshot.

1. Ran the full SF3D image encoder, reconstruction backbone and upsampler with
   streamed weights, and saved both the direct and upsampled scene codes.
2. Ran the same input and upstream model classes with every streamed parameter
   loaded permanently into independent MPS tensors using the official
   `safetensors.safe_open` reader. All block hooks and prefetch were disabled.
3. Both direct codes `[1,3,1024,96,96]` and scene codes `[1,3,40,384,384]`
   were **bit-for-bit identical**, with maximum absolute difference zero.
4. At 65,537 seeded sample positions, compared the combined chunked query and
   decoder adapter against untouched upstream `SF3D.query_triplane` and
   `MaterialMLP.forward`. Density, colour features, perturb normals and vertex
   offsets all had maximum absolute difference zero.

The resident control shares model construction/configuration and preprocessing
with the bridge. It independently checks tensor loading/residency and bypasses
streaming, but is not a separate CUDA baseline or an independent validation of
all upstream pretrained constructors. These checks do not assess model quality;
they establish that the tested streaming/chunking operations preserve results.
Metrics and arrays are in the ignored `output/diagnosis/` directory.

## Causes and contributing factors

| Stage | Stable Fast 3D | Local TripoSplat pipeline |
|---|---|---|
| Conditioning canvas | 512 x 512 | 1024 x 1024 |
| Approximate character height after framing | 430 pixels | 850 pixels |
| Image conditioning | DINOv2 | DINOv3 plus Flux2 VAE image features |
| Reconstruction | One feed-forward reconstruction | Iterative flow sampling; runner defaults to 20 steps |
| Output | Mesh plus predicted PBR texture | Coloured Gaussian splats |
| Actual local output | 7,492 geometric vertices, 14,988 triangles | 32,768 Gaussians |

These differences jointly explain why substantially different quality is
plausible; this investigation does not isolate a causal percentage for each.

**Fine image detail is heavily reduced before SF3D reconstruction.** The full
body shares a 512-pixel input with the background margin. Eyes, hands and fine
dress folds occupy very few pixels. A larger exported texture does not increase
the conditioning resolution.

**SF3D's geometry is coarse for this subject.** The checkpoint uses the 160-cell
marching-tetrahedra lattice. Its bundled vertices span 0..1 in steps of 1/160;
the configured world box is 1.74 units across. The generated character is
0.87587 units tall, covering about 80.5 lattice intervals in height. The model
also predicts offsets, so this is a lattice sampling measure rather than a
claim that every surface detail is quantized to the grid. Thin cloth, fingers,
facial features and hair are difficult at this sampling density.

**The SF3D texture is regenerated from learned features.** In `system.py`,
texture positions query the triplanes, the material MLP predicts `features`,
and those predictions become the albedo atlas. It does not project the original
high-resolution image back onto the front surface. Inspection of the extracted
1024 atlas shows blurred features and smeared/striped dress detail already
baked into it. That loss exists before the scene viewer applies lighting.

**The rendering representations differ.** TripoSplat stores Gaussian colour,
opacity, orientation and scale. SF3D exports an opaque triangle surface with
PBR albedo, a normal texture and predicted material properties. Splats can
represent soft boundaries and apparent fine detail differently from a coarse
mesh. A sharp front view of a splat does not by itself establish equally good
surface topology or hidden-side accuracy.

**Lighting is secondary.** The SF3D GLB has roughness approximately 0.915 and
metallicity 0.022. Stage lighting/normal mapping can emphasize rough surfaces
or dullness. The scene-builder importer uses GLTFLoader and scales/positions
the model; no flat-shading override was found in that import path. Since the
albedo itself is degraded, viewer lighting cannot explain all of the gap.

## Practical implications

- Keep streaming: removing it did not improve scene codes.
- Raising only the texture atlas from 1024 to 2048 cannot recover details
  absent from the predicted colour field.
- A controlled source-image reprojection onto the visible SF3D surface could
  improve front-view texture fidelity, but would not repair geometry or unseen
  textures. It requires visibility/occlusion handling and seam blending.
- A denser extraction lattice could reduce geometric faceting, but requires a
  matching tetrahedral asset and more geometry memory; it cannot restore
  details absent from the learned density field.
- Raising SF3D conditioning resolution is an experiment outside the checkpoint's
  512-pixel configuration, not an established quality fix.

Relevant source: SF3D `sf3d/system.py` (input preparation, query, mesh extraction
and material baking), checkpoint `config.yaml`, and TripoSplat `triposplat.py`
(preprocessing, DINOv3/VAE conditioning and flow sampling).
