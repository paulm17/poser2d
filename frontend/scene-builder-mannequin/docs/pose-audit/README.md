# Exhaustive pose-data audit

## Result

All **12,106 records** pass: 254 gallery poses and 11,852 frames. Every record
checks all **53 target bones** and all **47 original joints**. There are zero
failed records and zero introduced frame-step rotation discrepancies above the
specified tolerances. This report supersedes the earlier finite-number tests as
evidence of pose-transfer correctness.

- UAL1: 120 gallery poses and 6,243 frames.
- UAL2: 134 gallery poses and 5,609 frames.
- Rotation and segment-direction tolerance: **0.001 degrees**.
- Target joint-position and preserved-anchor tolerance: **0.00001 metres**.
- Maximum rotation error: approximately **1.61e-13 degrees**.
- Maximum segment-direction error: approximately **8.18e-13 degrees**.
- Maximum target joint-position error: approximately **1.25e-15 metres**.
- Pelvis-anchor and unintended local-position changes: **zero**.

Exact maxima, failing-record counts, provenance hashes and coverage are in
[summary.json](summary.json). [records.ndjson.gz](records.ndjson.gz) contains one
JSON line for every gallery pose/frame, keyed by library, animation, kind and
frame. Each line includes the original evaluated joint world positions and
quaternions, per-target-joint rotation/position/direction errors, original physical
segment directions, pelvis-anchor error and exact-state serialization result.

## What is independently compared

The oracle imports the **actual original converter and exact-state modules** from
the protected editor and constructs the **actual installed mannequin-js Male**.
Only renderer bootstrapping and texture loading are suppressed. Geometry and
joint construction run unchanged; render meshes are removed only after the
constructor has established its normalization. No browser or screenshot matching
is used.

Production evaluates a byte-identical copy of that converter on a transform-only
snapshot of the original hierarchy. For every record, the audit checks these
results against the actual original Joint instances, including all joint origins
and orientations. It then independently reconstructs target world matrices using
the original Joint world matrices, the fixed anatomical coordinate changes and
the target's real rest offsets/scales. This reconstruction does not call the
production converter's target local/world conversion code.

Target segment directions are also compared **directly to the original physical
segments**, not just to the target's own mapped quaternion. Hand orientation uses
both the palm's forward direction and index-to-pinky span. Foot direction uses the
original shoe's forward and up axes, matched to the neutral sole frame. The downward ankle-to-forefoot bone is not used as a horizontal sole direction.
Frame-step rotation magnitudes must match the expected original-driven changes;
source discontinuities are retained rather than smoothed or confused with new
errors.

Each record is serialized, restored to the target and compared with its exact
state before measurement. Unit tests additionally exercise both entry paths
through the shared library-pose function, translated/rotated/scaled figures,
non-default pelvis anchors, reverse/forward history-state replay, joint reset and
project validation/restoration. These are data tests, not UI tests.

## Mapping and units

The explicit 46-joint mapping and coordinate quaternions are in
`src/poses/rig-mapping.json`. They are generated from the actual original hierarchy
and generator rest joints, not guessed Blender bone tails. A correction maps a
target bone's rest-local physical frame into its original joint frame. Production
applies `original evaluated world rotation × correction`, then converts to the
already-evaluated target parent's local coordinates.

| Target | Source and policy |
| --- | --- |
| Pelvis | Original `body` orientation; preserve the selected target pelvis anchor |
| Upper spine | Original `torso`, calibrated through the actual neck joint origin |
| Neck and head | Original neck/head; retain their distinct joint frames |
| Arms, elbows, legs, knees | Corresponding original joints and joint-to-joint directions |
| Wrists | Original wrists, calibrated by forward/across palm directions |
| Thirty finger segments | Corresponding original finger, mid and tip joints |
| Feet | Original ankles; shoe-forward and shoe-up mapped to neutral sole-forward and sole-up; ankle-to-forefoot is projected onto the neutral floor plane |
| Skeleton root | Rest local transform; scene placement remains separate |
| Lower and middle spine | Rest local transforms, inheriting original body motion; upper-spine motion supplied by original torso |
| Two clavicles | Rest local transforms inheriting torso motion; arms retain original evaluated world orientations |
| Two forefeet | Rest local transforms inheriting ankle motion; the original builder has no independent forefoot joints |

All 53 bones have exactly one policy. The last seven bones are explicit inherited
motion, not independently invented poses. Raw Blender forefoot/clavicle/spine
rotations that the original editor does not apply are deliberately not added.

Generator native units are converted by its existing normalization to a 1.7m
body. The original Male's 1.8m normalization and wrapper offsets are retained by
the source evaluator. Source-world positions in the report are the actual
original scene's metres (root at Y=0.25, original floor at Y=-0.7). Target expected
positions use the target's own lengths and attachment offsets; raw positions of
different bodies are not falsely required to coincide. Animation adds no pelvis
translation in either gallery or scrubbing, matching the original editor.

This verifies the skeletal mapping. Different body proportions, head/hand/foot
shapes and skin weights still produce different surface contacts and silhouettes;
the report does not describe those different meshes as pixel-identical.

## Reproduce

From the repository root:

```
node frontend/scene-builder-mannequin/scripts/build-source-reference.mjs
node frontend/scene-builder-mannequin/scripts/audit-poses.mjs
npm --prefix frontend test
npm --prefix frontend run build
```

The first command regenerates only the new editor's source snapshot and mapping.
The audit reads the original editor and assets without modifying them. It exits
nonzero for an incomplete corpus, altered copied evaluator, invalid/missing data
or a measured discrepancy above tolerance. The original source hashes are stored
in both the generated snapshot and report.

BackFlip frame 17 is also recorded in `backflip-17-regression.json`. Its prior
1.048m skin clearance is now 0.162m without changing the preserved pelvis anchor.
That remaining clearance is a concrete body-proportion/contact difference, not a
claim of identical surface contact. Automatically snapping it to the floor would
change the original editor's placement rule and is deliberately not performed.

Existing saved projects retain their exact joint transforms and pelvis anchors;
they are not silently rewritten. To replace a pose produced by the old converter,
use a fresh mannequin and apply the gallery entry. Reapplying on an old figure
intentionally preserves its existing pelvis anchor, including any previously
stored offset.

## Foot-calibration correction

The first audit used an incorrect foot-frame definition: it aligned the original
shoe's forward axis with the generator's ankle-to-ball bone. That segment slopes
downward by 28.096 degrees in the neutral body. Aligning it horizontally tipped
the visible sole upward by the same amount. The earlier passing report did not
validate the physical sole normal and therefore did not establish correct foot
orientation.

The mapping now uses the neutral sole's forward direction (the horizontal
projection of ankle-to-ball) and its upward normal, and compares both axes
directly with the actual original shoe frame on every record. A dedicated
Celebration frame 18 regression constructs the actual original Male and compares
its shoe-up vectors to the replacement's sole-up vectors on both sides. This
corrects orientation without changing body proportions or moving the figure.
