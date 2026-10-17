"""Assemble complete frame sheets, preserve compressed app geometry evidence."""
from pathlib import Path
import json,math,gzip
from PIL import Image,ImageDraw
root=Path(__file__).resolve().parents[1];docs=root/'docs/ual-fit/limb-clearance';assets=root/'assets/ual-library';id='ual1-Crouch_Fwd_L_Loop';clip=assets/id
for start in range(0,61,8):
 end=min(60,start+7);sheet=Image.new('RGB',(1024,4*280),(35,35,40));draw=ImageDraw.Draw(sheet)
 for index,frame in enumerate(range(start,end+1)):
  col=index%4;row=index//4
  for e,editor in enumerate(['makehuman','legacy']):
   y=(row*2+e)*280;sheet.paste(Image.open(docs/editor/f'{frame:03}.png').resize((256,256)),(col*256,y+24));draw.text((col*256+6,y+6),f'{editor} · frame {frame}',fill='white')
 sheet.save(docs/f'frames-{start:02}-{end:02}.jpg',quality=90)
audit=json.loads((assets/'limb-intersection-audit.json').read_text());current=json.loads((clip/'limb-intersections.json').read_text());before=audit.get('actionsWithIntersections')
for row in audit['actions']:
 if row['action']=='Crouch_Fwd_L_Loop':row['intersectingFrames']=current['intersectingFrames']
audit['actionsWithIntersections']=sum(row['intersectingFrames']>0 for row in audit['actions']);audit['initialActionsWithIntersections']=83;(assets/'limb-intersection-audit.json').write_text(json.dumps(audit,indent=2))
remaining=[r for r in audit['actions'] if r['intersectingFrames']];(docs/'remaining-library-findings.json').write_text(json.dumps(remaining,indent=2))
r=json.loads((clip/'limb-clearance.json').read_text());angles=[math.degrees(2*math.acos(min(1,abs(f['worldShoulderCorrections']['l'][3])))) for f in r['frames']]
summary={'action':'Crouch_Fwd_L_Loop','frames':61,'actualEditors':json.loads((docs/'app-limb-summary.json').read_text()),'angleDegrees':{'minimum':min(angles),'average':sum(angles)/61,'maximum':max(angles),'frame19':angles[19]},'unchangedBody':json.loads((clip/'unchanged-body-comparison.json').read_text()),'runtimeBlender':json.loads((clip/'numerical-comparison.json').read_text())|{'records':None},'libraryAudit':{k:v for k,v in audit.items() if k!='actions'},'manualFrameEdits':0,'existingTestSuitesRun':False}
(docs/'summary.json').write_text(json.dumps(summary,indent=2))
for editor in ['makehuman','legacy','legacy2']:
 for p in (docs/editor).glob('*.json'):
  if not p.stem.isdigit():continue
  with gzip.open(str(p)+'.gz','wb',compresslevel=6) as out:out.write(p.read_bytes())
  p.unlink()
(docs/'README.md').write_text('''# Crouch Fwd L Loop: arm clearance

The left arm no longer intersects either leg in any of the 61 integer frames. Verified using actual editor gallery/frame controls in MakeHuman, Stage scene, and Stage scene 2 (183 captured poses). Every distinct limb pair was checked, not only the reported left arm/leg pair.

This is a code-generated shoulder correction. The elbow, wrist and finger **local** articulation is retained, while the complete arm moves with the shoulder. The right arm, torso, placement, legs and feet remain unchanged within floating-point rounding. The original UAL Blender sources are unchanged.

The overlap was deeper in some frames than the screenshot suggested. The final shoulder correction ranges from **4.96° to 19.38°**, with **5.12° at frame 19**. It includes a backward component where the knee travels outside the forearm. A tiny uniform outward spread could not clear the complete loop. Seven-frame torso-space smoothing reduces the largest change between adjacent correction samples to 1.78°; every smoothed pose is rechecked against skin triangles.

## Automated process

- `scripts/limb-collision.py`: visible skin anatomical regions, BVH broad phase, triangle separating-axis confirmation, small shoulder search, collision-constrained temporal smoothing. All six pairs among left/right arms and legs are checked. No animation-name exceptions or manual frame edits.
- `scripts/fit-ual.py` and `scripts/export-ual-fit.mjs`: run clearance on final solved poses; independently re-audit the exported skin before publication. Unresolved collisions reject the export.
- `scripts/repair-limb-clearance.mjs`: transactional repair of existing accepted exports, retaining their leg/floor solve. Blender, runtime, saved-action and independent mesh comparisons must pass before publication.
- `scripts/sync-legacy-limb-clearance.mjs`: shares measured shoulder rotations through metadata with both original mannequin editors. Raw source bone samples remain intact.
- `scripts/limb-review.html`, `limb-review-server.mjs`, `audit-app-limbs.py`: drive the actual gallery and every frame control, capture rendered geometry, independently audit it, and compare MakeHuman vertices against Blender.

```sh
node frontend/scene-builder-mannequin/scripts/repair-limb-clearance.mjs \\
  frontend/scene-builder-mannequin/assets/ual-library/ual1-Crouch_Fwd_L_Loop

/Applications/Blender.app/Contents/MacOS/Blender --background \\
  --python frontend/scene-builder-mannequin/scripts/audit-limb-intersections.py -- \\
  frontend/scene-builder-mannequin/assets/ual-library
```

## Results and limits

- All 61 frames pass in all three editor variants: **zero distinct-limb triangle intersections**.
- MakeHuman app versus Blender maximum vertex error: **0.00134 mm**.
- Maximum visible floor penetration: **0.00460 mm**, below the existing 0.1 mm acceptance threshold.
- Existing test suites were not run. The checks here are targeted geometry, animation, and app comparisons.
- The library audit covers **254 clips / 11,852 frames**. Initially 83 clips had intersections; after this repair **82 other clips remain flagged for review**. Some may be deliberate limb contact. They have not been silently corrected or claimed anatomically correct. See [remaining findings](remaining-library-findings.json).
- This audit checks intersections among the four limbs. It does not certify torso/head contact, joint limits, physical balance, or continuous in-between-frame collision freedom. Triangle regions use dominant anatomical skin weights; skin near shared attachment seams is omitted.

[Machine-readable results](summary.json) · [actual-editor geometry audit](app-limb-summary.json) · [frame 19 in the app](app-frame-19.png)

All 61 frames are shown in `frames-00-07.jpg` through `frames-56-60.jpg`. The per-editor PNG captures and compressed JSON geometry are retained for every frame.
''')
print(json.dumps({'remainingLibraryFindings':len(remaining),'angleDegrees':summary['angleDegrees']}))
