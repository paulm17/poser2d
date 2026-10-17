# MakeHuman scene builder — full fitted UAL skeleton

Latest limb check: Crouch Fwd L Loop is corrected in all 61 frames in MakeHuman and both original scene variants. The full 254-clip skin-intersection audit flags 82 other clips for review; floor acceptance does not imply collision-free anatomy. See [limb-clearance report](docs/ual-fit/limb-clearance/README.md).

The editor preserves MakeHuman's neutral shape, topology, UVs and texture. It uses `makehuman-ual65-v2`, with all 65 UAL deform bones and direct animation sampling. The gallery contains all **254 UAL1/UAL2 clips**. Figure placement is separate from animation-root movement; library frames disable IK. Exact joint transforms survive save/load and undo. Older incompatible rigs are rejected.

## Automated export and floor correction

From the repository root:

```sh
node frontend/scene-builder-mannequin/scripts/export-ual-fit.mjs /path/to/UAL1.blend Crouch_Fwd_Loop /path/to/output
node frontend/scene-builder-mannequin/scripts/export-ual-libraries.mjs --ual1 /path/to/UAL1.blend --ual2 /path/to/UAL2.blend --workers 3
```

The exporter reuses `binding.json`, checking the body and source-rest layout. Anatomical joint correspondence, bilateral measurements and existing skin influences define the fitted skeleton. Source actions are evaluated with their constraints at every integer frame. Full translations, rotations and scales are exported as frame JSON, animated GLB and a portable Blender comparison scene. Source assets remain unchanged.

Support is inferred from source-foot contact stability and pelvis height, without animation-name or individual-frame exceptions. Ground-supported clips retain planted-foot/toe constraints and whole-body clearance, using a shared pelvis/leg solver without stretching bones. Free-space clips retain their transferred articulation and motion and receive one constant, measured vertical placement offset for the entire clip. This keeps every rendered vertex above the floor without frame-by-frame grounding or bobbing. Original vertical travel is preserved in free-space clips. Classification evidence, contact corrections and fixed offsets are recorded in `fit-report.json`.

Every frame is compared with Blender using the real app rig implementation. Independent source evaluation also records the full source skeleton; free-space orientations and proportioned joint positions are checked against it after removing the fixed placement offset. All visible skin is checked against the floor, with no source-context exemption. Saved Blender animations are independently reopened. Position tolerance is 0.1 mm; rotation tolerance is 0.01 degrees. The tools do not invoke existing test suites.

To repair only rejected clips while retaining other accepted exports:

```sh
node frontend/scene-builder-mannequin/scripts/repair-ual-floor.mjs
```

When no clips are rejected, this command rechecks the last repair set. The last repair covered **14 clips / 591 frames**. All passed, bringing the catalog to **254 clips / 11,852 frames**, with zero floor exclusions. This is measured reproduction and floor acceptance, not a universal anatomical or environmental simulation.

## App verification and publication

With Vite running at `127.0.0.1:5173`:

```sh
node frontend/scene-builder-mannequin/scripts/render-ual-floor-repairs.mjs
node frontend/scene-builder-mannequin/scripts/ual-floor-review-server.mjs
```

Open `/scene-builder-mannequin/scripts/ual-floor-review.html` and choose **Compare all repaired frames**. It uses the actual gallery and frame controls, checks every bone and skin vertex, and captures matching front/side app images for every repaired frame. Blender render framing is fixed for each entire clip. The evidence sink binds only to localhost and accepts predefined clip IDs.

The same page's **Generate verified catalog thumbnails** button renders the actual fitted mannequin for every catalog entry. Publish the audited catalog with:

```sh
node frontend/scene-builder-mannequin/scripts/publish-ual-catalog.mjs
```

Publication rejects missing previews or incompatible fitted-model hashes. It generates the gallery manifest and bundled asset URLs from the audited catalog, without maintaining a pose list by hand. `cargo bundle` embeds the updated catalog in the desktop app.

```sh
python3 frontend/scene-builder-mannequin/scripts/assemble-ual-floor-review.py
```

Assembly requires Pillow. [Repair evidence and all-frame sheets](docs/ual-fit/floor-repair/README.md), [full-batch summary](docs/ual-fit/batch-automation/full-batch-summary.json). Historical audits describe earlier implementations and are superseded where marked.
