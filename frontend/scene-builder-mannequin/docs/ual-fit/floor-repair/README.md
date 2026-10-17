# Automated UAL floor repair

All 14 rejected clips were re-exported by the tools, covering **591 integer frames**. No poses or individual frames were hand-edited. The existing 240 accepted exports were retained.

Support is inferred from sustained source-foot contact and pelvis height, without animation-name exceptions. Ground-supported clips keep their contact solver and enforce whole-body clearance in every frame. Free-space clips preserve the transferred articulation and original motion; one constant, geometry-measured vertical placement offset puts the entire clip above the floor. There is no frame-by-frame grounding or bobbing. Every offset is recorded in fit-report.json.

Independent source evaluation records all 65 bone transforms. Free-space bone orientations and proportioned positions are checked against that source evaluation, independently of the exporter, after removing the fixed placement offset. Skin vertices and bones are compared with Blender at every frame. Whole-body floor checks have no source-context exemption. The saved Blender actions are also reopened and checked.

The actual app renderer reproduced all 591 frames. Front and side source/Blender/app images and sheets cover every frame of every repaired clip. `browser-comparison.json` records numerical results; `measurements.json` records policies and offsets. `all-clips.jpg` shows a floor-relevant frame from each clip.

The audited catalog now contains all 254 clips, with zero floor exclusions. No existing test suites were run.

The published native app gallery contains all 254 verified clips. Native gallery and Slide Start frames 0 and 8 were inspected. The final browser comparison uses the actual gallery and frame controls, rather than applying poses outside those controls. See `summary.json` for final measurements.
