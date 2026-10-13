# pose-toolkit

pose-toolkit is a local-first browser app for posing 3D mannequins, importing models, and exporting reference images.

This app uses mannequin-js as its articulated human figure foundation: https://github.com/boytchev/mannequin.js/

## Requirements

- Node.js 18+
- npm
- A modern browser

## Quick Start

### Windows

```powershell
cd pose-toolkit
start.bat
```

### macOS / Linux

```bash
cd pose-toolkit
chmod +x start.sh
./start.sh
```

Both scripts:

- install dependencies
- build the app
- start the Vite dev server
- open the browser at `http://localhost:5173`

## Manual Local Run

### Windows PowerShell

```powershell
cd pose-toolkit
npm install
npm run build
npm run dev
```

### macOS / Linux

```bash
cd pose-toolkit
npm install
npm run build
npm run dev
```

Then open:

```text
http://localhost:5173
```

## Local Deployment Build

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview -- --host
```

## How To Use

- Click **Add Mannequin** to add a default mannequin or load one from a JSON file
- Select a mannequin to move or rotate it with the gizmo
- Use the right panel to pose joints, enable IK, and switch camera angles
- Use **Import GLB** to bring in external 3D assets
- Use **Save** and **Load** for local project JSON files
- Use **Export** to capture the framed render

## GenAI Examples

These examples show how a pose exported from pose-toolkit can be used as a reference image for image-to-image generation.

### Example 1

| pose-toolkit reference | generated image |
| --- | --- |
| ![Example 1 pose reference](examples/1-reference.jpg) | ![Example 1 generated image](examples/1-i2i.jpg) |

### Example 2

| pose-toolkit reference | generated image |
| --- | --- |
| <img src="examples/2-reference.jpg" alt="Example 2 pose reference" width="320"> | <img src="examples/2-i2i.jpg" alt="Example 2 generated image" width="320"> |

## OS Notes

- **Windows:** use `start.bat` for one-click local startup
- **macOS:** use `chmod +x start.sh` once, then run `./start.sh`
- **Linux:** use `chmod +x start.sh` once, then run `./start.sh`

## Output

- Development server: `http://localhost:5173`
- Production files: `dist/`

### Blender pose gallery

**Select Pose** opens 254 static poses from Quaternius Universal Animation Libraries 1 and 2. Search by action name or filter by library, then select a thumbnail to apply the matching Blender frame to the active mannequin. The gallery uses extracted 3D bone orientations, including hands, feet, and fingers. Scene position, rotation, and scale remain unchanged; poses support undo/redo and exact save/load. Different mannequin proportions can affect contact points and silhouettes.

The runtime assets are bundled in `public/poses2`. Blender is needed only to regenerate them:

```sh
node scripts/build-pose2-library.mjs /path/to/animations/source /path/to/blender
```

Reviewed frame choices are recorded in `scripts/pose2-frames.json`. The extractor renders five candidates per animation and uses those choices for the final image and bone data. It reads the source files without saving them. Candidate renders are moved to `/tmp/pose2-review/candidates`.

For a full source/target visual comparison, run `node scripts/pose2-review-server.mjs`, open `http://127.0.0.1:3002/scripts/pose2-review.html`, and press **Render and validate all 254 poses**. Comparison sheets and the validation report are written to `/tmp/pose2-review`. Run mathematical and asset tests with `node --test tests/*.test.mjs`.

Every **Select Pose** thumbnail previews its animation on hover or keyboard focus. Selecting it opens a manual frame pane above Layers, with one integer slider step per source frame and an exact frame-number field. Each animation uses its own bounds, including negative frame numbers. Scrubbing updates the mannequin immediately without automatic playback. Frame selection supports undo/redo and is stored in saved projects and mannequin objects. Frame data loads on demand with an eight-animation cache.

Generate or resume animation previews and full frame data for each library with:

```sh
/path/to/blender --background --disable-autoexec /path/to/UAL1.blend --python scripts/build-animation-assets.py -- 1 "$PWD/public/poses2"
/path/to/blender --background --disable-autoexec /path/to/UAL2.blend --python scripts/build-animation-assets.py -- 2 "$PWD/public/poses2"
node scripts/validate-animation-assets.mjs
```

Generation requires FFmpeg and FFprobe on PATH. Complete clips are validated and skipped on subsequent runs. Preview rendering uses a fixed camera throughout each animation, at the source frame rate; only the thumbnail plays automatically.
