# MakeHuman library limb corrections

Scope: the 82 clips flagged after the separately confirmed Crouch Fwd L Loop repair. The confirmed clip is excluded. Wooden mannequin repairs and verification are excluded from this milestone.

The reusable exporter checks the final skinned MakeHuman mesh, then adjusts shoulders/clavicles and knee direction as needed. Knees rotate around the hip-to-ankle line; planted feet retain their targets. Difficult airborne poses may use measured foot spacing adjustments. Trajectory refinement can move the pelvis by up to 30 mm while solving the legs back to their existing foot positions. Every correction is recorded per bone and frame. Neutral vertices, topology, UVs, weights and all 65 bones are retained; original UAL Blender sources are unchanged.

Publication is transactional. Runtime versus Blender geometry, reopened baked action, floor and foot contact checks, and an independent visible-skin intersection audit must pass before the generated asset replaces its previous version. The actual built app is then exercised through its gallery and frame controls.

Reproduce the repair and checks:

```sh
node frontend/scene-builder-mannequin/scripts/repair-all-limb-clearance.mjs
# Optional trajectory refinement of an existing corrected clip:
UAL_TRAJECTORY_REFINE=1 node frontend/scene-builder-mannequin/scripts/repair-limb-clearance.mjs /path/to/clip-directory
node frontend/scene-builder-mannequin/scripts/audit-limb-continuity.mjs
node frontend/scene-builder-mannequin/scripts/summarize-limb-repairs.mjs
```

Fresh exports automatically run trajectory refinement when corrections have large adjacent changes or a closed-loop seam. Wooden metadata synchronization is opt-in (`UAL_SYNC_WOODEN=1`); MakeHuman milestone aliases are maintained independently.

The current machine-readable result is [makehuman-batch-summary.json](makehuman-batch-summary.json). Each clip has numerical comparisons, recorded corrections, a saved Blender comparison scene and a GLB. App evidence is under `batch-app/<clip>/makehuman/`.

Limits: checks cover all integer frames and all six pairs among the four limb regions. Dominant skin-weight classification omits attachment seams. These checks do not certify in-between-frame collision freedom, torso/head collisions, physical balance, joint limits or smooth motion. The continuity report lists correction steps and loop seams explicitly, including unresolved sharp changes; geometric clearance alone is not a claim of anatomical correctness. No existing test suites are run by this workflow.
