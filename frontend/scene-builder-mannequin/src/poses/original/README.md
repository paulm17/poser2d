# Original pose evaluator

`blender-retarget.js` and `exact-state.js` are byte-for-byte copies of the working
`frontend/scene-builder/src/poses/` modules. The audit verifies this before running.
They retain the original project's GPL-3.0 license, included here.

`rig.json` is generated from the installed, unmodified mannequin-js Male constructor
by `scripts/build-source-reference.mjs`. It includes all 47 original joints and
95 ancestor/wrapper transforms, exact default transforms and joint lengths. The
runtime uses transform-only Three.js objects; it does not instantiate a second
rendered doll. The sole original joint setter used during calibration (`body.turn`)
retains its original Y-axis/ZXY Euler rule. The audit independently runs the actual
Male Joint classes and original source files, and checks the transform-only
execution against them for every record.

Rebuild the snapshot and mapping together with:

```
node frontend/scene-builder-mannequin/scripts/build-source-reference.mjs
```
