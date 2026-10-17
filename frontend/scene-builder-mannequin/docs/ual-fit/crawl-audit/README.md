# Crawl Bwd Loop correction

The original native scene is backed up as `crawl-bwd-before-rig-fix.json`. `crawl-bwd-corrected-frame36.json` retains its camera and lighting and uses the new rig. Source assets were not changed.

The native app was running the old `vnccs-makehuman-v2` converter. The rebuilt application now embeds the UAL65 v2 model. Another error was measuring unused helper vertices: visible soles started about 3 cm above the normalization floor. Binding v2 uses only triangle-referenced vertices for its uniform height and origin. Neutral shape, topology, UVs and skin are preserved.

The reusable exporter now checks visible body, soles and toes separately at every frame. Body clearance corrections raise the pelvis and solve both legs together without stretching them. Small bounded forefoot corrections retain contact when the sole minimum alone would hide floating toes. Crawl requires at most 60 mm pelvis lift and approximately 3.26 degrees forefoot correction. Corrections are in the asset fit-report.json.

All 76 frames were compared against Blender and captured in the browser editor. Every frame was also selected and captured in the rebuilt native app, in `native/000.png` through `075.png`; `native/all-frames.jpg` is the overview. Blender GUI key-frame captures are under `native/blender/`. Front/side sheets contain original UAL, fitted Blender and app rows for all frames.

Measured maxima across 76 frames:

| Check | Maximum |
|---|---:|
| Blender/app deformed vertices | 0.00106943 mm |
| Bone positions | 0.00078264 mm |
| Bone rotations | 0.00005475 degrees |
| Visible body below floor | 0.00362191 mm |
| Contact toes from floor | 0.00100076 mm |

Save/load, joint editing and undo passed in the real browser editor. No existing test suites were run. The native application is left on frame 36.

These results cover Crawl Bwd Loop. The previous whole-library pass is superseded. The stronger pipeline has now reproduced all 254 actions / 11,852 frames; 240 pass the default-floor audit and 14 remain excluded for floor crossings. See ../batch-automation/full-batch-summary.json. Source-context classification outside ordinary floor-supported motion still needs review; passing numerical reproduction alone does not establish anatomical correctness.

Contact flexion now uses axes calculated from posed ankle/forefoot landmarks. A bounded ankle/forefoot geometry search handles cases where an isolated toe hinge stalls; these corrections are recorded, and unresolved contacts reject export. The batch runner supports `--workers 3` for independent concurrent clip conversions.
