# Crouch Fwd L Loop: arm clearance

Current status: all 14 motion repairs pass across 698 frames; see [completed MakeHuman motion repairs](motion-fixed/README.md). The observations below describe the earlier work.

The left arm no longer intersects either leg in any of the 61 integer frames. Verified using actual editor gallery/frame controls in MakeHuman, Stage scene, and Stage scene 2 (183 captured poses). Every distinct limb pair was checked, not only the reported left arm/leg pair.

This is a code-generated shoulder correction. The elbow, wrist and finger **local** articulation is retained, while the complete arm moves with the shoulder. The right arm, torso, placement, legs and feet remain unchanged within floating-point rounding. The original UAL Blender sources are unchanged.

The overlap was deeper in some frames than the screenshot suggested. The final shoulder correction ranges from **4.96° to 19.38°**, with **5.12° at frame 19**. It includes a backward component where the knee travels outside the forearm. A tiny uniform outward spread could not clear the complete loop. Seven-frame torso-space smoothing reduces the largest change between adjacent correction samples to 1.78°; every smoothed pose is rechecked against skin triangles.

## Automated process

- `scripts/limb-collision.py`: visible skin anatomical regions, BVH broad phase, triangle separating-axis confirmation, small shoulder search, collision-constrained temporal smoothing. All six pairs among left/right arms and legs are checked. No animation-name exceptions or manual frame edits.
- `scripts/fit-ual.py` and `scripts/export-ual-fit.mjs`: run clearance on final solved poses; independently re-audit the exported skin before publication. Unresolved collisions reject the export.
- `scripts/repair-limb-clearance.mjs`: transactional repair of existing accepted exports, retaining their leg/floor solve. Blender, runtime, saved-action and independent mesh comparisons must pass before publication.
- `scripts/sync-legacy-limb-clearance.mjs`: shares measured shoulder rotations through metadata with both original mannequin editors. Raw source bone samples remain intact.
- `scripts/limb-review.html`, `limb-review-server.mjs`, `audit-app-limbs.py`: drive the actual gallery and every frame control, capture rendered geometry, independently audit it, and compare MakeHuman vertices against Blender.

```sh
node frontend/scene-builder-mannequin/scripts/repair-limb-clearance.mjs \
  frontend/scene-builder-mannequin/assets/ual-library/ual1-Crouch_Fwd_L_Loop

/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python frontend/scene-builder-mannequin/scripts/audit-limb-intersections.py -- \
  frontend/scene-builder-mannequin/assets/ual-library
```

## Results and limits

- All 61 frames pass in all three editor variants: **zero distinct-limb triangle intersections**.
- MakeHuman app versus Blender maximum vertex error: **0.00134 mm**.
- Maximum visible floor penetration: **0.00460 mm**, below the existing 0.1 mm acceptance threshold.
- Existing test suites were not run. The checks here are targeted geometry, animation, and app comparisons.
- The library audit covers **254 clips / 11,852 frames**. Initially 83 clips had intersections; after this repair **82 other clips remain flagged for review**. Some may be deliberate limb contact. They have not been silently corrected or claimed anatomically correct. See [remaining findings](remaining-library-findings.json).
- This audit checks intersections among the four limbs. It does not certify torso/head contact, joint limits, physical balance, or continuous in-between-frame collision freedom. Triangle regions use dominant anatomical skin weights; skin near shared attachment seams is omitted.

[Machine-readable results](summary.json) · [actual-editor geometry audit](app-limb-summary.json) · [frame 19 in the app](app-frame-19.png)

All 61 frames are shown in `frames-00-07.jpg` through `frames-56-60.jpg`. The per-editor PNG captures and compressed JSON geometry are retained for every frame.

## Subsequent MakeHuman batch

The historical remaining count above is superseded by [the MakeHuman batch report](MAKEHUMAN-BATCH.md). All 82 remaining clips / 4,246 integer frames now pass the actual-app limb, floor and Blender vertex comparisons. The full library audit reports zero limb intersections across 254 clips / 11,852 frames. Correction transitions above eight degrees remain explicitly listed for motion-quality review; these are not a claim of smooth or anatomically perfect motion. Wooden mannequin work is excluded.
