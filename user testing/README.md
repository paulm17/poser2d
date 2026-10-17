# User testing

From the repository root:

```sh
python3 "user testing/run.py" --engine both --size 256 --pose "/path/to/pose.png" --avatar "/path/to/avatar.png"
```

Or use the included images:

```sh
python3 "user testing/run.py" --engine both --size 256
```

- `--engine`: `vpipe`, `sd` (stable-diffusion.cpp), or `both` (sequential).
- `--size`: `256`, `512`, or `1024`.
- `--pose`: image 1, the pose/mannequin. Default: `inputs/reference.png`.
- `--avatar`: image 2, the tunic avatar. Default: `inputs/avatar.png`.

Results are `outputs/vpipe/256-<pose-filename>.png` and `outputs/sd/256-<pose-filename>.png`, inside this directory. The selected size and pose filename determine the output name. Spaces in the pose filename become hyphens: `lying pose.png` becomes `256-lying-pose.png`. Repeating an engine and size replaces that result. Temporary configuration and working files are cleaned up automatically; errors are printed in the terminal.

Defaults: Qwen Image 2.1 Turbo, VNCCS PoseStudio **V2** at strength 1.0, prompt `Draw character from image2`, 8 steps, seed 42, CFG 1. sd.cpp adds the required LoRA activation tag. vpipe uses the LoRA configuration directly. Both inputs are stretched to the selected square size.

`--prepare-only` validates paths and input preparation without rendering or creating output files. Cached models and built executables are required. vpipe defaults to 8-bit weights and sd.cpp uses Q4_K_M.

## Generate splats

```sh
python3 "user testing/splat.py" \
  "user testing/outputs/vpipe/512-lying-pose.png" \
  "user testing/outputs/vpipe/512-standing-pose.png"
```

Runs the app's TripoSplat Metal streaming bridge sequentially. Defaults: 20 steps,
seed 42, guidance 3, 32,768 Gaussians. Each image gets its own directory beneath
`outputs/splats/`, containing `.ply`, `.splat`, the preprocessed input, status JSON,
command JSON and render log. Existing names are reused on rerun.

`--prepare-only` checks input images and local runtime/model paths without inference.
Use `--output-dir`, `--source`, `--python`, or `--model-dir` to override locations;
the app's `TRIPOSPLAT_SOURCE`, `TRIPOSPLAT_PYTHON`, and `TRIPOSPLAT_MODEL_DIR`
environment variables are also supported. Sampling options are `--steps`, `--seed`,
`--guidance`, and `--num-gaussians`. Weights are never downloaded automatically.

## Qwen scene editing with optional AnyAngle

`image.py` runs the vpipe Turbo editor with ordered references and retains the
pipeline, prepared inputs, manifest and log in its output directory.

```sh
python3 "user testing/image.py" --anyangle \
  --reference /path/to/coarse-scene.png \
  --reference /path/to/appearance-reference.png \
  --prompt 'Change the camera angle from <image2> to <image1>.'
```

Repeat `--reference` for additional appearance references. `--anyangle` enables
the app's AnyAngle adapter at strength 1 and forces CFG 3, including grounded
negative conditioning. Omit it for ordinary editing. Options include
`--anyangle-strength`, `--anyangle-lora`, `--width`, `--height`, `--steps`,
`--seed`, `--cfg`, `--model`, `--output-dir`, and `--prepare-only`.
Defaults: Turbo 8-bit, 704 × 512, eight steps, seed 42. Inputs are resized to
that canvas like the existing testing runner; choose matching aspect ratios
when image geometry matters. AnyAngle with multiple separate character
references is an experimental extension of its two-image angle-transfer use.

Use `image.py --fit contain` to resize references proportionally and pad the
canvas instead of stretching them. For a 1424 × 1011 scene at width 1024,
use `--width 1024 --height 736 --fit contain`; this places 1024 × 727 scene
content inside a model-compatible canvas. A centered 1024 × 727 crop of the
result removes the nine padding rows. Keep the uncropped output for comparison.

## Scene workflow with detail-preserving appearance reference

```sh
python3 "user testing/scene.py" \
  --layout artifacts/splat-scene/scene-corrected.png \
  --registration artifacts/splat-scene/editor-camera.json \
  --standing "user testing/outputs/vpipe/512-standing-pose.png" \
  --lying "user testing/outputs/vpipe/512-lying-pose.png" \
  --width 512 --anyangle
```

The pose runner remains the source of character appearance. This workflow builds
image2 directly from the detailed posed images at the measured camera positions,
instead of asking Qwen to generate another full-scene appearance image first.
Image1 is the coarse splat render. The assembly assumes the testing pose outputs
have a black or transparent background, and the layout has a plain floor/backdrop;
it recovers the background's row colours and adds subtle contact shadows. Black
background removal is a matte heuristic and can affect very dark edge details.
Standing height and lying width are preserved; neither sprite is stretched.

`--anyangle` runs the documented two-image prompt, adapter 1.0 and CFG 3 using
Turbo's eight-step schedule. Omit it to inspect the input pair before inference.
`--prepare-only --anyangle` validates the pipeline without inference. Pair,
placement metadata, generation inputs/logs, and final image remain under
`outputs/scene-repaired/` (override with `--output-dir`). Final aspect ratio comes
from the layout; only model-required padding is removed after generation.
Original source images and previous scene attempts remain unchanged.

The image runner now leaves VAE decoding to the engine's automatic policy unless
`--vae-tile` is explicitly passed. A larger requested output should use newly
rendered pose outputs at that size, rather than reusing a previous generated
full-scene appearance reference as though it contained new detail.

TripoSplat input handling: Qwen outputs can be RGBA with alpha 230–255 everywhere,
which is not a genuine transparent background. `splat.py` detects those nearly
opaque inputs and saves an RGB copy under the output's `input/` directory so the
bridge runs BiRefNet instead of skipping background removal. `input.json` records
the original and normalized input paths. Genuine cutouts with lower alpha values
remain unchanged.
