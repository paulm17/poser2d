"""Move bulky generated MakeHuman outputs out of app assets; never delete files.
Run from any directory. Runtime URL references and small regeneration metadata stay put.
"""
from pathlib import Path
import re,json,shutil
from datetime import datetime,timezone
root=Path(__file__).resolve().parents[3]
app=root/'frontend/scene-builder-mannequin'
destination=root/'regenerable-makehuman-output'
keep=set()
for source in (app/'src').rglob('*.js'):
    for relative in re.findall(r'''new URL\(\s*['"]([^'"]+)['"]''',source.read_text()):
        candidate=(source.parent/relative).resolve()
        if candidate.is_relative_to(app/'assets'):keep.add(candidate)
# Keep small fitting recipes, provenance and audit summaries beside the runtime assets.
recipes={'fit-report.json','binding.json','limb-clearance.json','limb-seed.json','manifest.json','motion-continuity.json','numerical-comparison.json','baked-action-comparison.json','limb-intersections.json'}
files=[]
for f in (app/'assets').rglob('*'):
    if not f.is_file() or f.resolve() in keep:continue
    parts=f.relative_to(app/'assets').parts
    temporary=any(p.startswith('.export-') or p=='rejected-last' for p in parts)
    if not temporary and (f.name in recipes or len(parts)==2 and f.suffix=='.json'):continue
    files.append(f)
for f in (app/'docs').rglob('*'):
    if f.is_file() and f.suffix.lower() in {'.png','.jpg','.jpeg','.webp','.mp4','.webm','.f32','.f64','.log','.blend','.blend1'}:files.append(f)
# Preflight the whole move before modifying anything.
for f in files:
    target=destination/f.relative_to(root)
    if target.exists():raise SystemExit(f'Refusing to overwrite {target}')
entries=[]
for f in files:
    relative=f.relative_to(root);target=destination/relative
    size=f.stat().st_size;target.parent.mkdir(parents=True,exist_ok=True)
    shutil.move(str(f),str(target));entries.append({'path':str(relative),'bytes':size})
# Remove empty generated subdirectories only.
for base in [app/'assets',app/'docs']:
    for d in sorted((p for p in base.rglob('*') if p.is_dir()),key=lambda p:len(p.parts),reverse=True):
        if not any(d.iterdir()):d.rmdir()
destination.mkdir(exist_ok=True)
record=destination/'moved-files.json'
previous=json.loads(record.read_text())['files'] if record.exists() else []
record.write_text(json.dumps({'updated':datetime.now(timezone.utc).isoformat(),'files':previous+entries},indent=2))
(destination/'README.md').write_text('''# Regenerable MakeHuman outputs — safe to delete\n\nEverything in this directory can be deleted without affecting app playback. It contains generated Blender scenes and backups, GLBs, numerical reference data, duplicate models, temporary attempts, and audit images/logs. Original relative paths are preserved; `moved-files.json` records the moves.\n\nScripts remain in `frontend/scene-builder-mannequin/scripts/`. Original UAL Blender source files and MakeHuman source geometry remain outside this directory. Runtime animations, thumbnails, the shared model and small regeneration recipes remain in their original locations.\n\nTo regenerate, use `export-ual-libraries.mjs` for the library or `export-ual-fit.mjs` for an individual action; use `reexport-motion-clips.mjs` for the fourteen motion repairs. Existing reports are historical evidence; comparisons and image links require regeneration or restoring the corresponding files from this directory. Regeneration requires the original UAL source files, Blender and the script dependencies.\n\nTo restore a file, move it back to the repository-relative path shown here. No symlinks depend on this directory.\n''')
missing=[str(p) for p in keep if not p.is_file()]
# Some optional videos were already absent; only moved existing runtime files would be a failure.
assert not any(str(p.relative_to(root)) in {e['path'] for e in entries} for p in keep)
print(json.dumps({'movedFiles':len(entries),'movedGiB':round(sum(e['bytes'] for e in entries)/1024**3,2),'destination':str(destination),'runtimeReferencesPreserved':len(keep)}))
