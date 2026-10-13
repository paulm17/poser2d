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

Open **Paths** and set the diffusion model, Qwen-Image-2.1 VAE, Qwen3-VL text encoder, and (for editing) vision projection weight files. The sd-cli executable defaults to the copy bundled with the app. Use compatible weights described in `stable-diffusion.cpp/docs/qwen_image_2.1.md`; a Hugging Face repository name or Diffusers directory is not a weight file. No models are downloaded automatically.

Generate queues an immutable request. A single Tokio worker runs sd-cli, sends logs/progress through CEF events, and adds the output to the submitting session. Cancel works for waiting and active jobs. References, including scene captures, are converted to PNG per job; removing a reference after submission does not change that job. Text-to-image prompt enhancement is available through the GGUF generate executable in the sibling mlx-rs project; editing enhancement remains unavailable.

The engine uses Euler sampling, CFG 6, CPU RNG, and disk-backed weight loading (`--params-backend disk`). Turbo mode uses its fixed 8-step sigma schedule and CFG 1. The cached Qwen Image 2.1 Turbo Q4_K_S diffusion model is filled into Paths when no model has been configured. Saved Qwen Turbo Q8_0 paths migrate to Q4_K_S when it is cached; the Q8_0 file remains untouched. Auto lets sd-cli choose its backend; the Apple Silicon selector maps to MTL0. The macOS binary supports Metal. Generated PNGs stay in the application data directory under `qwen-image-studio/renders`. Queue and take metadata survive frontend reload within the running app, but remain in memory across app restarts. Existing settings continue using local storage.

`cargo bundle` includes the existing `stable-diffusion.cpp/build/bin/sd-cli` binary. To rebuild it on macOS:

```bash
cmake -S stable-diffusion.cpp -B stable-diffusion.cpp/build -DSD_METAL=ON -DSD_BUILD_EXAMPLES=ON
cmake --build stable-diffusion.cpp/build --target sd-cli -j 4
cargo bundle
```

Engine verification: `cargo test -p theapp` exercises FIFO execution, waiting/active cancellation, recovery after failure, progress parsing, and output-image handling using a small subprocess fixture. A real Qwen render additionally requires local model weights.

### Vision and memory

The separate `mmproj-F16.gguf` vision projection is required for image editing. Download only this file with `hf download unsloth/Qwen3-VL-8B-Instruct-GGUF mmproj-F16.gguf`. The app detects cached vision weights and fills an empty vision path even when other model paths are already configured; explicit paths are preserved.

Disk loading fetches weights on demand and releases parameter buffers after use. Eager loading and CPU weight offloading are omitted. On Apple Silicon, CPU and GPU share physical memory; moving all weights to CPU RAM does not solve total memory pressure. Disk loading prioritizes reduced residency over speed, but working tensors, activations, and caches still consume memory. It does not guarantee that only one complete model component is resident.

One inference subprocess runs at a time and is reaped before the next job starts. Its model allocations are released when it exits.

Verified a real 256×256, 8-step Turbo edit changing a red mug to blue, using the cached Q8_0 diffusion model, Q4_K_M text encoder, F16 vision projection, and Qwen-Image-2.1 VAE. The result arrived in the Studio gallery and the inference process exited. On the Apple M1 Pro test host, peak sampled process RSS was 10.0 GiB (10,472,864 KiB), sampled every 0.5 seconds. This is an observed process-residency measurement, may miss brief peaks, and is not a limit or a measurement of total GPU/shared-system memory.

### Text prompt enhancement

Enable **Enhance prompt** for text-to-image generation. The queue runs `../mlx-rs/target/release/generate` using the cached PE-T2I Q4_K_M GGUF and official `system_prompt.txt`, then waits for that process to exit before starting sd-cli. This uses mlx-rs's GGUF/llama.cpp path, not its MLX backend. All three enhancer paths are configurable in Paths and detected automatically when empty.

The rewrite appears beneath the generated image. Explicit dimensions or aspect ratio win; otherwise a valid recommended ratio selects the nearest supported image size. **Let it think** enables the runtime's thinking option. Invalid JSON fails the job with a visible error; cancellation works during either stage. The runtime exposes temperature 1.0, top-p 0.95, top-k 20, and a 16,256-token generation cap. Its generate CLI does not expose presence penalty or an enhancer seed; the image-generation seed still applies. MTP acceleration is not enabled.

Downloaded files: `mozophe/Qwen-Image-2.1-PE-MTP-GGUF/qwen3.5_9b_qwen_image_2.1_pe_t2i.mtp.Q4_K_M.gguf` and `Qwen/Qwen-Image-2.1-PE-T2I/system_prompt.txt`, both in the Hugging Face cache. The GGUF weights include an MTP head but work here as ordinary generation weights. A direct real enhancement through mlx-rs returned valid JSON (308 generated tokens) in 26.5 seconds on the Apple M1 Pro.

The desktop end-to-end test also completed: PE-T2I enhanced the mug prompt through mlx-rs GGUF generation, then sd-cli produced a 256×256 image. The rewritten prompt and final image appeared in the Studio interface.

### PoseStudio LoRA

Paths detects the cached MIUProject/VNCCS_PoseStudio_QI2.1 V1.1 LoRA. PoseStudio is enabled for image edits at strength 0.7 by default; disable it or adjust its strength in Paths to compare results. Text-to-image requests omit it. The engine applies it at runtime with the quantized Turbo model. CLI tests applied all 384 tensors at 512×512; strength 1.0 reversed the subject orientation while 0.7 preserved the broad pose. Character identity transfer with a second reference remains unverified. Existing output size settings are preserved.
