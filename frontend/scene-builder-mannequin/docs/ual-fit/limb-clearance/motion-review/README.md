# Review of the 14 MakeHuman motion flags

Current status: all 14 motion repairs pass across 698 frames; see [completed MakeHuman motion repairs](../motion-fixed/README.md). The observations below describe the earlier work.

Reviewed all **698 integer frames** in these 14 clips. Original UAL actions were evaluated directly in Blender, without saving the source files. The comparison also reconstructs the fitted MakeHuman immediately before limb clearance, so errors in the earlier floor/foot solve can be distinguished from clearance corrections.

**All 14 have correction-related discontinuities worth fixing: eight arm/shoulder cases and six leg cases.** The two sword clips required checking changes in rotation speed, rather than treating the largest correction angle as proof of a visible pop. This is a review; no animation assets or converter behavior were changed.

## Findings

| Clip | Frames to inspect | Region | Finding |
|---|---|---|---|
| [Death02](ual1-Death02.jpg) | 29–30 | Right shoulder | The shoulder correction adds a backward arm kick during the fall. The source is moving quickly, but the change in its rotation step is 4.1° versus 18.5° in the export. |
| [Idle_Tired_Loop](ual1-Idle_Tired_Loop.jpg) | 17–18 | Left shoulder | The original shoulder moves only 0.57°; the export moves 10.28°. The hand shifts away from the thigh abruptly. |
| [Pistol_Reload](ual1-Pistol_Reload.jpg) | 42–43 | Left shoulder | Original movement is 0.04°; exported movement is 12.14°. The arm changes position near the end of the reload. The correction also leaves a 4.75° difference between the matching source start/end poses. |
| [Roll](ual1-Roll.jpg) | 15–16; 22–23 | Collarbones / arms | The right collarbone adds 26° where the source barely moves. A later change in the other arm produces the largest visible correction-displacement change in this set: 183 mm. |
| [Sitting_Exit](ual1-Sitting_Exit.jpg) | 18–19 | Left collarbone | A 13° collarbone change is introduced while the original collarbone is effectively still. The arm kicks sideways as the figure rises. |
| [JogToFlip](ual2-JogToFlip.jpg) | 11–13; 21–22 | Collarbones / arms | The left collarbone correction switches on around frame 13 and off at 22. Its largest change is 24° while the original collarbone is effectively still. |
| [KipUp](ual2-KipUp.jpg) | 10–14 | Knees / compensating ankles | The knee path changes abruptly. A fast ankle turn already exists before limb clearance: 69.14° in the fitted baseline versus 41.08° in the source at frame 12. Limb clearance adds a further discontinuity around frame 11. Both the earlier foot solve and clearance need attention. |
| [LiftAir_Fall](ual2-LiftAir_Fall.jpg) | 13–16 | Knees / compensating ankles | The knee direction changes sharply and requires a rapid ankle counter-rotation. At frame 15 the ankle rotation-step change is 43.76°, compared with 18.67° before limb clearance and 5.65° in the source. |
| [LiftAir_Fall_Impact](ual2-LiftAir_Fall_Impact.jpg) | 6–8 | Knees / compensating ankles / pelvis | The selected leg solution changes from large knee swivels to another solution and then a 20 mm pelvis lift. At frame 7 the left ankle rotation-step change rises from 21.65° in the fitted baseline to 45.18°; the source is 3.92°. |
| [Sword_Regular_C](ual2-Sword_Regular_C.jpg) | 11–12; 14–15 | Knees / calves | The largest correction-angle warning alone is misleading: the calf turns less than in the source at frame 15. However, the full-frame review finds a separate frame-12 discontinuity: calf rotation-step change is 18.68° versus 8.58° before clearance and 1.02° in the source. |
| [Sword_Regular_Combo](ual2-Sword_Regular_Combo.jpg) | 38–42 | Knees / calves | Several changes occur during the leg crossing. Although the calf turns slightly less at frame 42, its rotation-step change is 14.95° versus 5.25° before clearance and 4.82° in the source. |
| [Zombie_Run_R_Loop](ual2-Zombie_Run_R_Loop.jpg) | 20–22 | Knees / compensating ankles | The knee-pole choices jump near the final frame, including a 20° ankle counter-rotation change. The right thigh rotation-step change reaches 52.94°, versus 30.40° before clearance and 14.16° in the source. The loop endpoints match; that does not remove this internal discontinuity. |
| [Zombie_Spawn](ual2-Zombie_Spawn.jpg) | 68–69 | Right collarbone | Original collarbone movement is 0.17°; exported movement is 11.33°. The right arm moves abruptly as it clears the bent leg. |
| [Zombie_Walk_Fwd_R_Loop](ual2-Zombie_Walk_Fwd_R_Loop.jpg) | 13–14 | Right shoulder | Original movement is 1.58°; exported movement is 10.43°. The correction adds a sideways arm kick. |

## Why the previous acceptance was insufficient

The collision solver accepts individual poses when the skin clears the other limbs and floor. Its trajectory selector penalizes jumps, but imposes no maximum allowed motion change. A collision-free path can therefore still contain a sudden correction. In the arm search, candidate templates are sampled every second frame and are not interpolated; a nearby smoother candidate can be absent. Leg candidates use coarse knee-direction steps. Retaining the already accepted pose as a fallback also permits switching between unlike solutions. These are code-level findings; they do not establish that changing only one of these details will fix every clip.

Recorded examples: `Roll` switches the right arm from zero correction at frame 15 to a template from frame 26 at frame 16. `JogToFlip` switches the left arm from an applied template to zero at frame 22. `Zombie_Run_R_Loop` changes its leg parameters from `(-30°, -20°)` at frame 21 to `(-20°, 0°)` at 22.

The older continuity report names some fingers because it measures inherited world rotation. Those are principally shoulder/collarbone changes, not independent finger snapping. Conversely, a large local ankle change can compensate for a knee swivel while preserving the foot’s world orientation; it is not necessarily a foot turning by that angle in the room.

## Evidence and measurements

- [Overview 1](overview-1.jpg) and [overview 2](overview-2.jpg) show every clip. Each full sheet shows five consecutive frames in fixed front and side views, before and after limb clearance.
- Grey is fitted MakeHuman before limb clearance; blue is the published result. The baseline is **not** the original UAL body.
- Each clip JSON records every frame, all 65 local joint rotation steps, changes between successive steps, and visible-skin displacement changes. `*-source.json` contains the original Blender-evaluated source matrices.
- Rotation-step change is the quaternion-angle difference between consecutive rotation increments. It is a frame-based continuity measure, not a physical joint-acceleration limit.
- The maximum change in correction displacement ranges from about **61 to 183 mm** at visible vertices. This is the difference between exported and pre-clearance vertex motion; it is not a whole-body translation or a penetration depth.
- Existing intersection/floor/app reports remain separate geometry checks. The assets reviewed match the hashes used by those checks. Their previous passes do not certify smoothness.
- No existing test suites were run.

## Required pipeline correction

Generate denser, interpolated candidate trajectories; solve collision clearance over a time window rather than selecting isolated poses; keep foot constraints while varying knee direction continuously; add an explicit continuity acceptance gate with source-motion comparison. If no continuous solution exists, reject publication for review instead of treating a geometric pass as completion. Revisit the earlier foot solve for `KipUp`, `LiftAir_Fall` and `LiftAir_Fall_Impact` as well as the limb-clearance stage.
