> Latest: the remaining 14 clips were repaired by the automated tools (591 frames), all 254 clips pass the floor audit, and the complete catalog is published. See [final repair evidence](floor-repair/README.md). Earlier results below are historical.

Latest limb check: Crouch Fwd L Loop is corrected in all 61 frames in MakeHuman and both original scene variants. The full 254-clip skin-intersection audit flags 82 other clips for review; floor acceptance does not imply collision-free anatomy. See [limb-clearance report](limb-clearance/README.md).

> Current binding: `makehuman-ual65-v2`. Visible triangle-referenced skin defines normalization and contact checks. Crouch all 61 frames revalidated; crawl all 76 frames documented in [crawl audit](crawl-audit/README.md). Previous full-library acceptance is superseded.

# Crouch Fwd Loop — fitted UAL65 comparison

The original MakeHuman body has the full UAL deform skeleton, positioned using its existing volume-derived anatomical joint coordinates. No neutral body shape edits were made. All 65 deform bones are retained. Existing anatomical skin weights were retained and normalized; no vertices are unweighted.

Only UAL1 `Crouch_Fwd_Loop`, frames 0–60, is exposed in this editor.

## Measured Blender/app agreement

The browser comparison drives the actual editor's gallery and integer-frame controls and measures every vertex and bone at all 61 frames.

| Measurement | Maximum difference | Allowed |
|---|---:|---:|
| Deformed vertex position | 0.001115 mm | 0.1 mm |
| Bone position | 0.000813 mm | 0.1 mm |
| Bone rotation | 0.00005174° | 0.01° |

All 61 frames, all 65 bones and all 19,158 vertices meet those thresholds. Exact save/restore, manual elbow editing and undo also passed. The independently reopened Blender action agrees with the exported local poses: maximum position difference 0.000000 mm and rotation difference 0.00000487°.

This export reused the saved anatomical binding. Animation JSON SHA-256: `b6b471067c1406f6ebf6e098b87cc2588a4125a0e7bcf0bac83163a266412b0d`.

## Fitting and proportional motion

The body retains the previous editor's 1.7 m height. Original UAL body height: 1.828717 m. Root travel is scaled by 0.929614; hip lowering uses measured leg-length proportions instead of pelvis-bone length. The UAL root coordinate frame is retained. The largest recorded stance correction is 88.78 mm; every correction and detected stance interval is recorded in the fitting report.

The fit uses the existing internal joint landmarks rather than moving pivots to skin-surface centroids. Cross-sectional skin measurements are included for inspection, and terminal bones use distal weighted skin extents. Source hierarchy and anatomical movement are preserved. MakeHuman's different body proportions and surface mean it does not have the same silhouette as the original UAL mannequin.

Maximum neutral-coordinate Float32 rounding: 0.00006158 mm. Vertex order, original triangle indices, UVs and skin texture are retained. Unmapped or unweighted influences are rejected by the exporter.

## Review artifacts

- [Key frames 0, 15, 30, 45 and 60](key-frames.png): original UAL, fitted MakeHuman in Blender, and actual app captures, front and side.
- [All 61 front frames](all-frames-front.png) and [all 61 side frames](all-frames-side.png). Larger ten-frame sheets are named `front-00-09.png`, `side-00-09.png`, and so on.
- [Front skeleton fit](fit-overlay-front.png) and [side skeleton fit](fit-overlay-side.png).
- [Actual browser measurements](browser-comparison.json), [direct runtime comparison](numerical-comparison.json), and [saved Blender action comparison](baked-action-comparison.json).
- [Full fitting, weight and motion report](../../assets/ual-fit/fit-report.json), [reusable binding](../../assets/ual-fit/binding.json), [Blender comparison scene](../../assets/ual-fit/comparison.blend), and [animated GLB](../../assets/ual-fit/makehuman-ual.glb).

Blender and browser lighting differ; the numerical comparisons concern skeleton and skin geometry. No existing test suites were run. This milestone does not claim that the remaining UAL animations have been ported or verified.

## Independent foot-contact inspection — all frames

The previous joint-speed contact rule missed planted feet. It left the left sole about 42 mm above the floor at frame 3, despite Blender/app geometry agreement. That rule has been replaced with evaluated source foot-surface measurements for every frame.

An independent script reopens the original UAL file and measures both soles at all 61 frames. Source clearance within 2 mm of the authored ground is treated as contact; source penetration is clamped to ground. Positive swing clearance is scaled by body height. Left contact: frames 0–44 and 60. Right contact: frames 0–2 and 29–60.

The actual browser checks both feet against those independent measurements on every frame. Maximum clearance error across all 122 foot/frame combinations: **0.000610 mm**. Frame 3's left sole is on the floor within 0.000035 mm. This check now fails independently of Blender/export agreement. Root and figure placement remain fixed by the animation and user, without per-frame body grounding.

See [original source measurements](all-frame-foot-inspection.json) and the per-frame feet records in [browser measurements](browser-comparison.json). The original UAL has up to 8.31 mm sole penetration, corrected to ground in the fitted result.

Contact correction measures the actual skinned soles. Maximum absolute sole clearance at full stance: 0.00000766 mm. The figure is not automatically grounded or recentered at each frame.

The exporter now solves the shared pelvis position and both leg chains together, using the nearest point inside both leg-reach spheres. This corrects the previous fixed-pelvis rejection of valid standing and moving poses. Per-frame pelvis shifts and leg-length errors are included in the fitting report. All 41 Walk Loop frames were also visually inspected in [front](corrected-walk-front.png) and [side](corrected-walk-side.png) sheets; gold lines mark the ground plane.
