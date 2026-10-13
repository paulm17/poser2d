# Lighting and shadows

Open **Lighting** in the existing scene editor toolbar. The editor uses its existing Three.js 0.163.0 renderer, camera, capture system, and session bridge.

## Compose and manipulate lights

The light list supports adding multiple instances of all six types, naming, duplication, enable/disable, and deletion. New lights start with shadows off; presets enable shadows on their key lights. Delete/Backspace acts on the selected light while the panel is open; text and select fields retain their own keyboard behavior. Select a model or close Lighting to return to object editing.

- **Ambient:** uniform color and intensity, without a spatial gizmo.
- **Directional:** position and an aim target determine direction. Distance does not attenuate illumination.
- **Hemisphere:** sky/ground colors and position-defined sky orientation.
- **Point:** position, range (zero means unlimited), and decay.
- **Spot:** point controls plus aim target, cone half-angle in degrees, and penumbra. Penumbra softens the cone boundary, not the shadow silhouette.
- **Rectangular area:** width, height, position, and Euler rotation in degrees; translation and rotation gizmos. These lights illuminate Standard/Physical materials and have no native WebGL shadow maps. Imported materials are retained, including unlit materials.

Numeric inputs allow values beyond the convenience slider ranges, subject to finite-value validation. A completed numeric/slider edit or gizmo drag creates one history entry. Aim at selection/scene center stores a fixed aim position; it does not follow the object afterward. Light and shadow-camera helpers are session UI settings, independent of enabled light state, and are always excluded from capture.

## Shadows, objects, and ground

Global shadows support Basic, PCF, PCF soft, and VSM. Lightweight, balanced, and high tiers request 512, 1024, and 2048 texels per map/point face. Per-light resolution can inherit global quality or override it. Migrated milestone-one lights retain their original 1024/2048/4096 resolution, so global quality does not override those explicit settings; select **Global quality** under Advanced shadows to opt in.

Directional, spot, and point lights expose cast shadows, bias, normal bias, and automatic/manual fitting. Manual directional fitting exposes orthographic bounds and near/far; manual point/spot fitting exposes near/far independently of attenuation range. PCF exposes radius; PCF soft exposes radius only for point lights, as implemented in r163. VSM exposes radius and, for directional/spot lights, blur samples. Point shadows use PCF sampling even in VSM mode. Standard maps do not produce physically accurate area-light softness.

Automatic directional fitting uses casting-subject bounds, the relevant receiving floor region, padded/quantized extents, and texel alignment. Ground extent limits the receiving region used by fitting. Point/spot fitting follows subject distance; the spotlight cone remains the user's chosen cone. Fitting is throttled to 10 Hz during continuing pose changes, with forced updates after lighting edits, manual refresh, restoration, and capture.

Object Properties includes cast/receive switches for both mannequins and GLB roots. Each switch intentionally overrides that property on all descendant meshes. Until a property is overridden, the original reconstructed GLB flags are preserved. Mixed mesh flags appear as an indeterminate checkbox. Overrides persist in full projects, object files, history, and sessions.

Ground controls set visibility, shadow receiving, color, opacity, and diameter/extent. Its existing texture and transparency are retained when converting the receiver to MeshStandardMaterial for area-light compatibility. Transparent output still follows the existing **Include Background & Floor** capture option. Transparent materials do not guarantee accurate partially transparent shadows.

## Presets and interchange

Default, three-point studio, soft portrait approximation, dramatic side, rim, and outdoor daylight presets replace the light list as a single undoable operation. They retain ground and object shadow settings. Soft portrait is a shadow-map approximation.

**Export lighting JSON** produces a `scene-lighting` envelope (format version 1), containing version 2 lighting data: global shadows, ground, and the light array. It contains no scene assets, object overrides, editor selection, or helpers. Import validates the entire setup before applying it, replaces the lighting/ground settings, and is undoable. Unsupported format/schema versions and files larger than 1 MiB are rejected explicitly. Missing lighting in older full projects restores original defaults; milestone-one version 1 migrates without losing edits.

Advanced code export generates enabled lights only, for vanilla Three.js or React Three Fiber. Vanilla output exports `installLighting(scene, renderer)` returning lights, `updateShadows()`, `updateHelpers()`, and `dispose()`. It includes standalone fitting; refresh after object movement and configure a receiving floor at Y=0 or adjust the exported fitting call. R3F output requires a Three.js-compatible R3F release, configures renderer shadows, wires target objects, and fits on mount; moving subjects need a fitting refresh in the consuming application. Helpers are optional in vanilla output and off by default. Both outputs safely escape user light names and include explicit shadow/type properties and area-light initialization.

## Limits and validation

The initial supported ceilings are 16 total lights, four enabled shadow-casting lights, and 128 MiB estimated shadow-map allocation. The estimate includes color/depth storage, the r163 point-light 4×2 atlas (six rendered faces plus two unused tiles), and VSM's additional pass. Requests over budget fail before changing the scene. Lower map resolution or disable shadows on other lights before retrying. A point light at 1024 already uses 64 MiB; high global quality may exceed the budget unless that light has a lower explicit resolution. Actual resolutions are additionally capped by renderer texture limits, accounting for point-atlas dimensions. These budgets concern shadow resources, not total scene/model memory.

Removed lights and changed resolution/filter resources are disposed. One gizmo is shared across selections; helper objects are reused while the selected light remains the same. No second renderer or editor is embedded.

## Verification and reference

`npm test`, `npm run typecheck`, and `npm run build` run from `frontend`. Tests cover legacy migration, validation/budgets, six-type and JSON round trips, presets/history, fitting, mesh overrides, resource replacement, and execution/syntax of standalone exports.

`tests/lighting-runtime-checks.mjs` is a development-only harness for the actual host iframe/bridge. In an isolated test session, import it from the host page and call `runLightingRuntimeChecks()`. It temporarily restores test projects, exercises failed-GLB recovery and suspension, collects clean renders/timing/allocation measurements, then restores the starting snapshot. It compares snapshot numbers with a 1e-6 tolerance because mannequin-js posture getters reorder Euler rotations and introduce sub-ulp quaternion drift.

Reference captures and measurements are in `tests/lighting-artifacts`. The recorded 37-case Chromium WebGL2 run includes all types, filters, tiers, auto/manual shadows, a 53k-triangle mannequin-plus-GLB scene, 16 lights, separated subjects, pose changes, and eight resource-removal cycles. Studio tiers allocated 2/8/32 MiB; the 16-light test allocated 22 MiB. Frame samples were approximately 15–16 ms in this environment. Render CPU timing excludes GPU completion and is not a promise for other hardware. Native app webview verification remains a separate acceptance check; the recorded run used the Codex in-app Chromium browser and the app's actual scene iframe.

Light application, helper construction, and enabled-light code-generation patterns are adapted from the repository's `threejs-lighting-generator/main.js` reference. Its standalone scene, renderer, lil-gui, and animation loop remain in the reference/demo and are not embedded into this editor.
