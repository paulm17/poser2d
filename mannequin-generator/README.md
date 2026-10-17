# Original VNCCS mannequin generator

Run `./setup.sh` once to restore the pinned upstream checkout and dependency link (requires Git and installed `frontend/node_modules`). These local dependencies are intentionally ignored by Git. Then run `./run.sh`, then open http://127.0.0.1:8770. Drag joints using the original viewer controls; orbit the camera to choose the view. Export mannequin PNG captures the current viewport at 1024 × 1024, hiding joint helpers. Save/load pose JSON preserves the original core pose representation.

The original source is in `upstream/`, pinned to commit `2b0f4041b368e3408cfb826f4cf09e6f8dafa164` of AHEKOT/ComfyUI_VNCCS_Utils. All upstream files are unchanged, including the MakeHuman asset, Three.js, morph worker, viewer, IK and PNG capture implementation. Licenses are retained. `upstream-manifest.json` records SHA-256 checksums.

`index.html`, `launcher.js` and `run.sh` are a separate standalone shell. `model-adapter.js` contains the exact modelDataFromMorphMessage method copied from the upstream widget. The shell invokes the original APIs; it does not reproduce the complete ComfyUI node UI. This is mannequin rendering only, without Qwen inference or a LoRA. No Python packages or network downloads are needed to run after this copy.

## Saved project pose transfer

Open `project-poses.html?pose=0` for Celebration frame 93, or `project-poses.html?pose=1` for Crawl_Enter frame 51. `source-pose-project.json` is an unchanged copy of the supplied Desktop project. `source-exact-state.js` is copied unchanged from the source scene builder. Source mannequin-js and Three.js examples are linked to the existing frontend/node_modules.

`project-transfer.js` restores the original source joint transforms and maps their camera-space segment directions and finger rotations to the original VNCCS viewer. This is an approximate retarget to a different skeleton, not an exact anatomical reproduction. Upstream VNCCS files remain unchanged. The `*-source-pose.png` root files restore the original skeleton exactly, with a new fitted camera and black background. The `*-vnccs-pose.png` and JSON root files are the transferred poses.

## Exact standing geometry / VNCCS appearance experiment

`standing-experiment.html` restores entry 0 of `standing-experiment-project.json`
(a snapshot of the supplied Desktop project), including all 47 exact joint transforms.
It keeps the original mannequin-js geometry and replaces only its materials with
those from the loaded VNCCS body. The original uniform dummy texture is reused
without changing UVs. Both exports use VNCCS's default ambient lighting, black
background, and an identical mathematically fitted camera with the saved viewing
orientation. The control retains the source materials; it does not reproduce the
stage's directional lighting or crop.

Run `./run.sh 8771`, then in another terminal run
`node capture-standing-experiment.mjs`. The capture script uses the bundled
Playwright runtime and installed Chrome; set `PLAYWRIGHT_MODULE` to another
Playwright module path or `EXPERIMENT_URL` to another server URL when needed.
Results are in `standing-experiment-output/`:

- `standing-control.png`: original materials.
- `standing-experimental.png`: VNCCS appearance on the exact same surfaces.
- `verification.json`: world-coordinate, joint, topology, silhouette, texture,
  camera, material, renderer, and output pixel statistics.

The silhouette check renders both states with the same opaque white mask material
and compares the resulting PNGs exactly, independent of surface shading. Geometry
checks compare every mesh vertex in world space and every position/index buffer.
The test does not run the LoRA or change the app's stage.
