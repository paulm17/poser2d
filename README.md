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

The script downloads `Qwen/Qwen-Image-2.1-Turbo`, `Qwen/Qwen-Image-2.1`, `Qwen/Qwen-Image-2.1-PE-T2I`, and the Lightning adapter, then uses vpipe's `model-quantize` stage to prepare:

- `vpipe-prepared/Qwen-Image-2.1-Turbo-4bit` and `Qwen-Image-2.1-Turbo-8bit`, group size 64.
- A shared 4-bit Qwen3-VL language encoder, preserving its vision components and the VAE at source precision.
- `vpipe-prepared/Qwen-Image-2.1-PE-T2I-4bit`, using the official system prompt and tokenizer.
- `vpipe-prepared/Qwen-Image-2.1-4bit` and `Qwen-Image-2.1-8bit`, with a shared base 4-bit text encoder and a separate compatible Lightning runtime adapter.

Preparation recipes, logs, and source snapshot revisions are retained in `vpipe-prepared`. Base Qwen components add approximately 33 GB to the Turbo and enhancer downloads; prepared weights need additional disk space. Component copies use vpipe's hard-link support. Original source files remain unchanged. Use `--skip-download` to prepare already-cached sources.

The model catalog detects these prepared directories and the existing PoseStudio V1.1 adapter. Saved precision and pose preferences migrate automatically; generation resolves model paths internally.

### Generation and enhancement

Turbo uses its official eight-step schedule, CFG 1, and prefix KV caching. Image edits feed each reference into both vision conditioning and VAE encoding. PoseStudio applies only to edits, at strength 0.7 by default; incomplete adapter binding fails visibly.

**Enhance prompt** runs the 4-bit PE-T2I model through vpipe's Qwen3.5 backend before image generation. Its process exits before the image model starts. The official system prompt, thinking option, JSON parsing, and displayed rewritten prompt are retained. The enhancer output head and embedding table are quantized together so both load through the affine backend. Enhancement remains text-to-image only. Sampling uses temperature 1.0, top-p 0.95, top-k 20, seed 42, and a 16,256-token cap; MTP is disabled.

Outputs and per-job pipelines/logs live in the application data directory under `qwen-image-studio/renders`. Models run sequentially using vpipe's automatic SSD streaming. VAE decoding uses overlapping 512-pixel windows by default to bound GPU command and memory costs at 1024 × 1024; windows are blended and can differ from a full-frame decode. Set `VPIPE_VAE_TILE` to override the latent window size (32 by default, 16 pixels per cell for Qwen 2.1). `/usr/bin/time -l` records elapsed process time and peak resident memory in each render log. This measures process residency, not total system memory.

### Verification

```sh
cargo test --bin theapp
npm --prefix frontend test
cargo run --bin validate-vpipe
python3 scripts/report-vpipe-validation.py
```

The validation runner uses the same backend as the desktop app. It generates six 1024 × 1024 images with seed 42: plain T2I, enhanced T2I, and PoseStudio I2I for each precision. Both I2I runs use the supplied character image. Pass a different reference path as its first argument if needed.

Outputs, final pipelines, enhancer replies, complete render logs, model paths, and timing are saved under `artifacts/vpipe-validation`; `results.json` records the six results. The runner checks output dimensions and reports any failed job. Fixture tests cover pipeline construction, settings migration, enhancement parsing, progress, queue order, cancellation, and failure recovery.

For targeted reruns, set `VPIPE_VALIDATION_FILTER` to comma-separated names such as `turbo-4-t2i,base-8-pose`. The results manifest keeps the latest attempt for each workflow.

The earlier six Turbo/enhancer jobs passed on an M1 Pro with 32 GB RAM. Generation took approximately 4–6 minutes per job, with peak process residency of approximately 9–14 GiB. Both editing runs bound all 192 PoseStudio modules. The reference character's dress, pointed ears, and standing pose influenced the outputs, although facial identity changed. See the generated `artifacts/vpipe-validation/report.md` for images, exact timings, memory measurements, and model identities.

## Qwen model selection

Use the Model popover at the top left to select Turbo or Non-Turbo and 4-bit or 8-bit weights. Installed models are discovered automatically in the Hugging Face cache. Add adapters in the left-hand LoRAs section; each row has a model, strength, and remove button. Lightning is available only for Non-Turbo, uses four steps, and can be stacked with Pose. Pose applies only to image edits.

`python3 scripts/prepare-qwen-base.py` downloads the standard Qwen-Image-2.1 components and Lightning adapter, verifies component identities before sharing cached Turbo files, and prepares both transformer precisions. The original Lightning file stays intact; a tensor-name-compatible runtime copy is written under `vpipe-prepared`.
