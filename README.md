# Qwen Image Studio

Rust desktop app using the local `../rust-cef` library, with the existing React + TypeScript Studio UI.

## Build and launch on macOS

```bash
cargo run
```

`cargo run` installs frontend dependencies when needed, builds the UI and Rust host, bundles CEF and its helper processes, and launches the desktop app. It requires npm and the sibling `rust-cef` checkout. The first Cargo build may download CEF and Rust dependencies. `cargo bundle` prepares the app bundle without launching it.

## Layout

- `src/`: Rust desktop entrypoint.
- `frontend/`: Vite project, source, and built assets in `dist/`.
- `stable-diffusion.cpp/`: separate inference engine checkout, not yet connected.
- `xtask/`: macOS development bundle command.

## Frontend development

```bash
npm --prefix frontend run dev
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

The desktop app loads built assets through `app://`; rebuild its bundle after frontend changes.

Generate submits to the Rust engine queue and bundled stable-diffusion.cpp executable. Stage scene opens the bundled pose-toolkit editor. Load demo take previews the gallery and image actions. Session settings persist in browser local storage; references and demo takes remain in memory. The engine connection is implemented in `frontend/src/engine.ts`.

## Known runtime limitation

The window and Studio interactions were verified in CEF. Cmd-Q currently hangs inside the sibling rust-cef runtime: CEF pumps a native termination event while winit already holds its event-handler mutex. This host does not modify that library. Native window close uses rust-cef's existing hide-to-background behavior.

## Scene builder

The forked pose-toolkit is vendored in `frontend/scene-builder/` and built as a
second Vite HTML entry. Its iframe isolates its global styles and mannequin stage.
The source checkout is not needed to install, build, or run this app. The bundled
pose gallery adds about 142 MB of runtime assets, plus small WebM preview variants.

Each Studio session has an independent in-memory scene and undo/redo history.
Duplicate copies the current scene; subsequent changes stay independent. Returning
to Studio pauses the editor's renderer and gallery previews. Save/Load in the
editor exports/imports project JSON, including embedded GLBs, exact mannequin
poses, camera target, export framing, and annotations. Scenes do not persist
across app restarts unless saved to JSON.

In Stage scene, open **Export**, frame the scene, then choose **Send to Studio**.
The PNG is added to that session's reference list and Studio opens. Captures use
the same naming, image decoding, ten-reference limit, prompt mentions, and request
pipeline as uploaded images. **Download image** still exports a local PNG/JPEG.
Generation is connected through `frontend/src/engine.ts` to the Rust queue and bundled `sd-cli`.

```bash
npm --prefix frontend test
npm --prefix frontend run typecheck
cargo bundle
```

The bridge validates the sender window, origin, token, session, request, and
payload. Its identifier uses a query parameter: the current rust-cef asset handler
strips queries but does not strip URL fragments. Embedded assets require a fresh
app process after a bundle rebuild; reloading an older process does not replace
its compiled frontend assets.

The copied editor is GPL-3.0; see `frontend/scene-builder/LICENSE` and
`frontend/scene-builder/ATTRIBUTION.md` for notices and the source revision.

CEF does not support the upstream H.264 previews. The gallery selects bundled
WebM previews when H.264 is unavailable. After regenerating upstream MP4s, run
`node frontend/scene-builder/scripts/convert-pose-previews.mjs` (requires FFmpeg)
to refresh the WebM variants. App installation and builds use the committed
previews and do not require FFmpeg or Blender.

## Image engine

Open the **Model** popover at the top left to select Turbo or Non-Turbo and 4-bit or 8-bit precision. The app detects the prepared Safetensors directories in your Hugging Face cache. Run the preparation script below before generating; the app does not download models automatically.

Generate queues an immutable request. A single worker runs native vpipe pipelines, streams logs and denoising progress to the Studio, and registers the output in the submitting session. References are converted to immutable PNGs per job. Cancellation kills the active inference process group and allows the next job to run.

### Build vpipe

```sh
git -C vpipe submodule update --init extern/lmdb extern/pugixml extern/metal-cpp
git -C vpipe apply ../scripts/patches/vpipe-studio-compatibility.patch
cmake -S vpipe -B vpipe/build -DVPIPE_BUILD_PYTHON=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0
cmake --build vpipe/build --target vpipe-cli -j 6
cargo bundle
```

Apply the patch once to the supplied vpipe checkout (`068c343d5bd1f591d816b8a6fe272183e7eb5c78`). If the ignored checkout is absent, clone `https://github.com/tgo-app-dev/vpipe` into `vpipe` and check out that revision first. It pins portable shaders to Metal 3.1 for macOS 15 and uses compile-time compatibility guards for tensor APIs unavailable in SDK 26.1. Newer SDK builds retain the M5 paths. This Mac uses the existing M1 SIMDgroup kernels. The patch also adds PoseStudio fused gate/up adapter support, with a regression test that verifies row order and shared factors. Vpipe is an ignored nested repository; the patch is tracked here so the build is reproducible.

### Prepare models

All source and prepared model files live under `/Volumes/Data/Users/paul/.cache/huggingface/hub`. No GGUF weights are used.

```sh
python3 scripts/prepare-vpipe-models.py
```

The script downloads `Qwen/Qwen-Image-2.1-Turbo`, `Qwen/Qwen-Image-2.1`, `Qwen/Qwen-Image-2.1-PE-T2I`, `Qwen/Qwen-Image-2.1-PE-I2I`, and the Lightning adapter, then uses vpipe's `model-quantize` stage to prepare:

- `vpipe-prepared/Qwen-Image-2.1-Turbo-4bit` and `Qwen-Image-2.1-Turbo-8bit`, group size 64.
- A shared 4-bit Qwen3-VL language encoder, preserving its vision components and the VAE at source precision.
- `vpipe-prepared/Qwen-Image-2.1-PE-T2I-4bit` and `Qwen-Image-2.1-PE-I2I-4bit`, using their official system prompts and tokenizers; PE-I2I also retains its vision tower.
- `vpipe-prepared/Qwen-Image-2.1-4bit` and `Qwen-Image-2.1-8bit`, with a shared base 4-bit text encoder and a separate compatible Lightning runtime adapter.

Preparation recipes, logs, and source snapshot revisions are retained in `vpipe-prepared`. Base Qwen components add approximately 33 GB to the Turbo and enhancer downloads; prepared weights need additional disk space. Component copies use vpipe's hard-link support. Original source files remain unchanged. Use `--skip-download` to prepare already-cached sources.

The model catalog detects these prepared directories and the existing PoseStudio V1.1 adapter. Saved precision and pose preferences migrate automatically; generation resolves model paths internally.

### Generation and enhancement

Turbo uses its official eight-step schedule, CFG 1, and prefix KV caching. Image edits feed each reference into both vision conditioning and VAE encoding. PoseStudio applies only to edits, at strength 0.7 by default; incomplete adapter binding fails visibly.

**Enhance prompt** runs the 4-bit PE-T2I model through vpipe's Qwen3.5 backend before image generation. Its process exits before the image model starts. The official system prompt, thinking option, JSON parsing, and displayed rewritten prompt are retained. The enhancer output head and embedding table are quantized together so both load through the affine backend. With reference images, enhancement automatically uses PE-I2I and its own official system prompt. Reference order is preserved; automatic canvas sizing respects `wh_ratio` or `ratio_follow`, while explicit sizes take precedence. Image attachments that cannot be encoded fail the job. Sampling uses temperature 1.0, top-p 0.95, top-k 20, seed 42, and a 16,256-token cap for T2I or 24,000 for I2I; MTP is disabled.

Outputs and per-job pipelines/logs live in the application data directory under `qwen-image-studio/renders`. Models run sequentially using vpipe's automatic SSD streaming. VAE decoding uses overlapping 512-pixel windows by default to bound GPU command and memory costs at 1024 × 1024; windows are blended and can differ from a full-frame decode. Set `VPIPE_VAE_TILE` to override the latent window size (32 by default, 16 pixels per cell for Qwen 2.1). `/usr/bin/time -l` records elapsed process time and peak resident memory in each render log. This measures process residency, not total system memory.

### Verification

```sh
cargo test --bin theapp
npm --prefix frontend test
cargo run --bin validate-vpipe
python3 scripts/report-vpipe-validation.py
```

The validation runner uses the same backend as the desktop app. It covers plain T2I, I2I, PoseStudio I2I, enhanced T2I, enhanced I2I, and enhanced multi-image editing for both precisions and both Turbo and standard models, using seed 42. The default validation size is 512 × 512; set `VPIPE_VALIDATION_SIZE` to override it. Pass reference paths as its first and optional second arguments, and use `VPIPE_VALIDATION_FILTER` to select individual jobs.

Outputs, final pipelines, enhancer replies, complete render logs, model paths, and timing are saved under `artifacts/vpipe-validation`; `results.json` records the results. The runner checks output dimensions and reports any failed job. Fixture tests cover pipeline construction, settings migration, enhancement parsing, progress, queue order, cancellation, and failure recovery.

For targeted reruns, set `VPIPE_VALIDATION_FILTER` to comma-separated names such as `turbo-4-t2i,base-8-pose`. The results manifest keeps the latest attempt for each workflow.

The earlier six Turbo/enhancer jobs passed on an M1 Pro with 32 GB RAM. Generation took approximately 4–6 minutes per job, with peak process residency of approximately 9–14 GiB. Both editing runs bound all 192 PoseStudio modules. The reference character's dress, pointed ears, and standing pose influenced the outputs, although facial identity changed. See the generated `artifacts/vpipe-validation/report.md` for images, exact timings, memory measurements, and model identities.

## Qwen model selection

Use the Model popover at the top left to select Turbo or Non-Turbo and 4-bit or 8-bit weights. Installed models are discovered automatically in the Hugging Face cache. Add adapters in the left-hand LoRAs section; each row has a model, strength, and remove button. Lightning is available only for Non-Turbo, uses four steps, and can be stacked with Pose. Pose applies only to image edits. AnyAngle is discovered from the cached `lilylilith/QI_2.1_AnyAngle` adapter and can be stacked with the other adapters. CFG defaults to 1 and accepts values from 1 to 10; selecting AnyAngle locks it at 3, and removing AnyAngle restores the previous value.

`python3 scripts/prepare-qwen-base.py` downloads the standard Qwen-Image-2.1 components and Lightning adapter, verifies component identities before sharing cached Turbo files, and prepares both transformer precisions. The original Lightning file stays intact; a tensor-name-compatible runtime copy is written under `vpipe-prepared`.

### Image editing prompt enhancer

Prepare just PE-I2I with:

```sh
python3 scripts/prepare-vpipe-models.py --only-pe-i2i --cache /Volumes/Data/Users/paul/.cache/huggingface/hub
```

Official sources are stored in `models--Qwen--Qwen-Image-2.1-PE-I2I` beneath that cache. The 4-bit runtime checkpoint, including vision weights, tokenizer, and system prompt, lives in `vpipe-prepared/Qwen-Image-2.1-PE-I2I-4bit`. Full preparation also includes this model; `--skip-download` reuses cached sources.

Enable **Enhance prompt** with one or more references to use PE-I2I. **Let it think** remains available; reasoning is recommended for the official enhancer models. The enhancer exits before the image model loads. The bundled compatibility patch includes vision tensor-prefix detection for official Qwen3.5 checkpoints; rebuild vpipe after applying it. For real validation, select `turbo-4-enhanced-i2i`, `turbo-4-enhanced-multi`, or `turbo-4-enhanced` through `VPIPE_VALIDATION_FILTER` when running `cargo run --bin validate-vpipe -- /path/to/reference.png /path/to/second-reference.png` (the second reference is optional).

### AnyAngle CLI comparison

AnyAngle can be tested independently of the app's LoRA selector. Download the original adapter into the Hugging Face cache:

```sh
hf download lilylilith/QI_2.1_AnyAngle QI2.1_AnyAngle.safetensors --cache-dir "$HOME/.cache/huggingface/hub"
```

After applying the existing vpipe compatibility patch, also apply `scripts/patches/vpipe-qwen21-cfg.patch` and rebuild `vpipe` and `vpipe_test`. This fixes Qwen 2.1 CFG bookkeeping: positive and negative conditioning retain separate image-slot metadata, layouts, and prefix caches. Setting guidance above 1 requires negative conditioning to be wired; the runner uses an empty, image-grounded negative.

```sh
git -C vpipe apply ../scripts/patches/vpipe-qwen21-cfg.patch
cmake --build vpipe/build --target vpipe vpipe_test -j 4
python3 scripts/validate-anyangle.py /path/to/pose.png /path/to/avatar.png
```

The runner uses the full pose as reference 1 and avatar as reference 2, with `Change the camera angle from <image2> to <image1>.` It preserves reference content with padding and derives the output aspect ratio from the pose canvas, aligned to 32 pixels. All runs use CFG 3: Turbo 8-bit at eight steps with seeds 42 and 43 compares no adapter, AnyAngle 1.0, and AnyAngle 0.7; standard 8-bit at 20 steps compares no adapter and AnyAngle 1.0 with seed 42; a separate Turbo seed-42 run stacks AnyAngle 1.0 with PoseStudio 0.7. Standard runs do not use Lightning; prompt enhancement is disabled throughout.

Pipelines, logs, model revision/hash, timings, memory measurements, saved latents, and results are saved under `artifacts/anyangle-cli-tests`. VAE decoding uses the app's 32-cell (512-pixel) overlapping tiles for every run; these can differ from full-frame decoding. `--prepare-only` writes the pipelines without inference; `--filter` selects comma-separated job names; `--resume` skips successful runs whose pipeline is unchanged. Each successful adapter run must bind all 192 modules and execute both CFG branches. These checks establish runtime compatibility; viewpoint and identity fidelity still require reviewing the outputs. Metal inference and the fused-LoRA test require GPU access outside environments that hide the Metal device.

### Image-to-splat preview

Completed generated takes offer **Generate splat**, followed by **View splat** after completion. The splat viewer replaces the image preview; **View image** returns to the image. Image and splat inference share one queue.

The engine uses `vpipe/examples/triposplat/run.py` with its `.venv/bin/python` (or the upstream checkout's `.venv/bin/python`), the sibling `TripoSplat` checkout and locally cached weights. Prepare the bridge environment using its README. Override locations with `TRIPOSPLAT_PYTHON`, `TRIPOSPLAT_SOURCE` and `TRIPOSPLAT_MODEL_DIR`. Generation uses Metal only, with 20 steps, guidance 3, seed 42 and 32,768 Gaussians. The viewer and pinned Three.js 0.180.0 / Spark 2.3.1 assets are bundled locally; their notices accompany the assets.
