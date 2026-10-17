# MakeHuman motion repairs

This milestone covers the fourteen clips identified in `../motion-review/summary.json` (698 integer frames). The wooden mannequin and the already confirmed Crouch Fwd L Loop are outside this repair scope.

**All 14 clips pass across all 698 frames.** The actual app comparison measured a maximum deformed vertex difference of **0.0034 mm**, bone rotation difference of **0.00000342°**, and floor penetration of **0.0045 mm** (below the 0.1 mm limit). All six distinct limb pairs have zero detected triangle intersections.

`summary.json` is the current acceptance record. A clip passes only when its motion-continuity report, independent Blender/runtime comparison, reopened Blender action, exact limb-intersection audit, unchanged bound model, and matching actual-app frame audit all pass. App records must match the current clip SHA-256 and use verification version 3, which enforces the separate bone position/rotation tolerances and samples world-space skin after the app's own render/update step.

The automated exporter measures stable contact height separately for each source foot and distinguishes those contacts from airborne movement, preserves proportional leg chains, handles cyclic contact intervals, and records floor and limb corrections separately. Clearance trajectories constrain both joint correction changes and their fitting parameters. The knee hinge comes from the rig rather than an ambiguous nearly straight joint triangle. Anatomical hip-track adjustments are selected automatically against every frame, then checked again after the contact solve against skin collisions and source-relative correction steps. Airborne feet retain natural proportional movement without forced source ankle targets and receive only necessary floor clearance; knee-angle envelopes handle the nonlinear response near a straight leg.

Run only the targeted work:

```sh
node frontend/scene-builder-mannequin/scripts/reexport-motion-clips.mjs
node frontend/scene-builder-mannequin/scripts/summarize-motion-fixes.mjs
```

The batch reuses already accepted exports, preserving them when a newer attempt fails. `UAL_ONLY_IDS` selects clips. Failed support solves are retained in each clip's `rejected-last/support-solve.json`; `refine-support-solve.py` can replay those poses without refitting the source model. Original Blender source files are never saved.

`analysis/` contains before/after front and side comparison sheets and every-frame motion measurements. Actual app per-frame geometry audits and screenshots are in `../batch-app/<clip>/makehuman/`.

No existing test suites are part of this workflow.
