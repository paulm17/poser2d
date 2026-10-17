> Historical verification of the superseded 53-bone rig. Current UAL65 results are in [ual-fit/README.md](ual-fit/README.md).

# Current pose-transfer verification

The earlier pose-transfer claims below are historical and superseded by the
exhaustive original-data audit in [pose-audit/README.md](pose-audit/README.md).
The former independent Blender calibration and animation-driven pelvis-height
transfer were incorrect for matching the working builder and have been replaced.
All 254 gallery poses and 11,852 frames now pass independent source-rig and
53-bone target reconstruction checks. No UI comparison is used for this result.

# Verification — 15 October 2026

## Control reversion

The added rotation rings, always-visible joint markers, focus mode and collapsed position-offset disclosure were removed at the user's request. The original scene-builder Properties layout and named controls are restored. A real wrist slider edit moved bend from 0 to 0.5 degrees and undo restored 0; no mannequin rotation widgets were attached. Dragging the optional Left Arm IK handle moved the hand from [0.441813, 1.034006, 0.184365] to [0.393405, 1.265990, 0.184365], recording one undo step. No browser console errors were observed. Camera code, rig geometry and skinning were unchanged in this correction. The initial acceptance results below describe the earlier control implementation where stated.

## Original-control compatibility correction

The earlier reversion restored labels but did not convert coordinate frames. The panel now converts the original joint-local positions and Euler rotations to the MakeHuman skeleton using a measured, transform-only reference. No second mannequin or renderer is added. Posed skin bounds are refreshed before body picking so a moved elbow remains selectable.

The reported case was reproduced using BackFlip frame 29 at a -43-degree viewing angle. The original live editor measured Left Elbow position [0,11,0] and bend 32.3801642534 degrees. The replacement now reports the same values. Setting position [-0.15,11.15,-0.20] and bend 33.56 changes the elbow, leaves the scene position [0,0,0] unchanged, and retains BackFlip frame 29. A click on that posed elbow changed selection from Root to Left Elbow. Undo/redo restored Z from -0.20 to zero and back, while retaining the frame and bend.

An independent regression compares the edited physical rotation with the original captured parent frame and original Joint.z Euler rule, and checks that local offset values do not become metre-scale scene movement. All 54 menu entries are tested through the actual panel compatibility bindings. The frontend build and all **75 tests** pass. Original editor source and camera code are not changed by this correction.

## Automated

- Production frontend build: passed, including the separate editor entry and bundled morph worker/binary/texture. Vite reports its usual large-chunk advisory.
- Frontend tests: **74 passed, 0 failed**.
- Geometry: exact comparison against the generator's default morph output for vertices, topology, UVs, skin indices/weights and bone hierarchy. Scene height normalization is outside these source buffers.
- Surface deformation: **159/159 bone-axis tests** passed on 53 bones and all 19,158 vertices. Each forefoot joint moved 1,057 vertices per tested axis.
- Pose library: **254 static poses and 11,852 animation frames** passed bounds and finite normalized rotation checks. This is mathematical validation, not exhaustive visual comparison.
- Exact pose round trips, invalid-pose atomic validation, generator import, new-project/legacy validation, reachable arm/leg IK, seated hip height and helper exclusion from captures passed.

## Browser acceptance

| Check | Observed result |
|---|---|
| All panel rotations | **162/162** inputs moved rendered surface positions; 30 finger-segment options and 53 markers present |
| Real neck slider input | 0° to 0.5°; one history step; undo restored 0°, redo restored 0.5° |
| Direct fingertip selection | Pointer selected `Joint_index_03_l`; markers take priority over overlapping rotation rings |
| Fingertip gizmo drag | Y rotation changed from 0 to -0.34866314047119 radians; one history step |
| Save / Load | New-format project downloaded and reloaded; all mannequin/import transforms round-tripped exactly |
| Legacy Load | Error displayed and current mannequin retained |
| Malformed GLB project | Rejected before changing existing scene |
| Generator pose import | Neck ≈15°, index segment ≈30°, forefoot 20° from JSON |
| Multiple figures / GLB | Two mannequins plus one self-contained triangle GLB restored successfully |
| Frame slider | GroundSit_Enter 64 to 65; scene position remained [0,0,0] |
| Visual pose inspection | Standing/default, raised arms, ground sitting, crawling and hand close-up inspected; contacts remain approximate |
| Lighting | Three-point preset produced four lights and retained casting shadows |
| Production Studio sessions | Neck 0.5° in one session; 0° in another; returning restored 0.5° |
| Send to Studio | With Include Gizmo checked, returned to Studio and added a decoded `scene.png` reference (1/10) |
| Production console | No errors observed during the integration/capture run |

## Protected files

SHA-256 inventories were captured before editing and compared after completion, including untracked files:

- `frontend/scene-builder`: **1,353 files unchanged**.
- `frontend/scene-builder-2`: **36 files unchanged**.
- `mannequin-generator`: **753 files unchanged**.

See `integrity.json` for the comparison summary and `preview.png` for the new editor's after capture.

The original editor/generator comparison was performed earlier in live browser sessions. These results do not imply anatomically constrained joints, individual toe articulation, or exact source-character silhouettes/contact points.

## Root Reset Part correction (15 October)

Compared the running original and replacement with Root selected. The original
returns the body upright with bend 0, tilt 0 and turn -90. The replacement had
used the Blender pelvis segment direction as its neutral control frame; this
made zero control values leave the visible body pitched. Root controls now use
the neutral MakeHuman body's actual rest orientation. Reset Part restores the
selected joint transform atomically rather than writing sequential Euler fields.

Live verification: the replacement's rendered body returns upright and its
pelvis local quaternion returns to [0, 0, 0, 1]. A slider edit changes that
quaternion; Reset Part restores it; Undo restores the edit; Redo restores the
upright body. A regression checks both pose-library calibrations, repeated
reset, restoration through exact pose snapshots, and unchanged descendant local
rotations. All 76 frontend tests and the frontend build pass.

Neither protected editor's source was changed. The directory inventory has only
an additional `.DS_Store` in the original editor, already present before this fix.

## Red skin selection highlight

Added the original editor's `0xbc4e4e` emissive selection colour, blended by the
selected bone's existing skin weights. No overlay geometry or pose changes are
involved. Live browser checks covered elbow, thigh and torso selection; clicking
the torso; finger selection (218 influenced vertices); forefoot selection (1057
influenced vertices); finger posing; two figures with only one highlighted; and
Root clearing all highlights. Compared against the running original editor's
selection feedback. The original has separate rigid parts; the new skin has
soft region boundaries and separate spine sections.

The shared capture render path disables tint during the image draw and restores
it afterward, covering both image export and Send to Studio. Verified this with
the live renderer and regression tests, including a failing capture. All 78
frontend tests and the frontend build pass. Protected editor sources unchanged.

## Elevated-pose floor framing

Reproduced the missing floor with BackFlip frame 17 in the running editor. The
floor remained visible in scene state, but the posed skin's lowest point was
1.048m above the floor. Fitting only the skin moved the floor below the viewport.
Camera fitting now includes floor height beneath the figure when the floor is
enabled. It retains the locked camera height and does not alter joint transforms
or scene placement. A hidden floor does not participate in framing.

Verified BackFlip frame 17 visibly retains floor and shadow. Regression coverage
checks the actual frame at portrait, square and landscape aspects and three
horizontal orbit angles, asserting floor visibility and unchanged exact pose.
All 79 frontend tests and the frontend build pass. Screenshot:
`backflip-floor-fixed.png`.

## Rebuilt transfer acceptance

The original-data audit passes all 12,106 records, all 47 source joints and all
53 target bones per record. Source copies match the protected files byte for
byte. The compressed report was independently read back: exactly 12,106 rows,
zero failures. The unit suite has 81 passing tests; the frontend build passes.
Protected directory inventories show zero changed/removed source or asset files;
only the original editor's pre-existing `.DS_Store` addition differs from the
older session baseline. No UI or image comparison is used as pose evidence.

Existing exact projects and pelvis anchors are preserved. Use a fresh mannequin
to apply the corrected library to data previously produced by the bad converter.
BackFlip frame 17 has zero mapped segment-direction discrepancy but about 0.162m
of skin clearance above the target floor; this remaining geometry/contact
limitation is recorded explicitly in the audit, not hidden by moving the pelvis.

## Celebration frame 18 foot correction

The previous audit's foot direction was wrong: the downward-sloping ankle-to-ball
bone (28.096 degrees below horizontal at rest) was treated as the sole-forward
axis. Its passing quaternion/direction comparisons did not test the physical sole
normal. This caused the visible raised-toe error; it was not explained by body
proportions. The mapping now uses the neutral sole's horizontal forward direction
and up normal. All 12,106 records were re-audited, including direct sole-up
comparison with the actual original shoe frame. Maximum sole-up direction error
is 1.85e-13 degrees. Both sides of Celebration 18 have a separate regression
against the actual original Male. All 82 frontend tests and the build pass.
Neither protected builder was modified.
