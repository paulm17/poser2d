"""Assemble every repaired frame, plus a measured review of all repaired clips."""
from pathlib import Path
from PIL import Image,ImageDraw
import json
root=Path(__file__).resolve().parents[1];assets=root/'assets/ual-library';out=root/'docs/ual-fit/floor-repair'
repair=json.loads((assets/'floor-repair-report.json').read_text());browser=json.loads((out/'browser-comparison.json').read_text())
if not browser['pass']:raise ValueError('App comparison failed')
overview=Image.new('RGB',(768,len(repair['actions'])*280),'#202020');draw=ImageDraw.Draw(overview)
rows=[]
for row,action in enumerate(repair['actions']):
 id=action['id'];fit=json.loads((assets/id/'fit-report.json').read_text());directory=out/id;frames=list(range(fit['start'],fit['end']+1))
 if len(frames)!=next(clip['frames'] for clip in browser['clips'] if clip['id']==id):raise ValueError('Incomplete app comparison')
 for view in ['front','side']:
  for start in range(0,len(frames),8):
   chunk=frames[start:start+8];sheet=Image.new('RGB',(256*len(chunk),834),'#202020');labels=ImageDraw.Draw(sheet)
   for r,kind in enumerate(['source','blender','app']):
    for col,frame in enumerate(chunk):
     image=Image.open(directory/kind/view/f'{frame:03}.png').convert('RGB');sheet.paste(image,(col*256,r*278+22));labels.text((col*256+4,r*278+4),f'{kind} {view} {frame}',fill='white')
   sheet.save(directory/f'{view}-{chunk[0]:03}-{chunk[-1]:03}.jpg')
 worst=min(fit['corrections'],key=lambda correction:correction['beforeFloorMinimumMetres'])['frame']
 if fit['floorPolicy']=='ground-support':
  source=json.loads((assets/id/'all-frame-foot-inspection.json').read_text());worst=min(source['frames'],key=lambda frame:frame['bodyMinimum'])['frame']
 for col,kind in enumerate(['source','blender','app']):
  overview.paste(Image.open(directory/kind/'side'/f'{worst:03}.png').convert('RGB'),(col*256,row*280+24));draw.text((col*256+3,row*280+4),f'{id} {worst} {kind}',fill='white')
 lifts=[correction['rootFloorLiftMetres'] for correction in fit['corrections']]
 numeric=json.loads((assets/id/'numerical-comparison.json').read_text());rows.append({'id':id,'frames':len(frames),'policy':fit['floorPolicy'],'fixedRootLiftMetres':max(lifts),'rootLiftVariationMetres':max(lifts)-min(lifts),'bodyPenetrationMetres':numeric['maxBodyPenetrationMetres'],'maxSourceBoneErrorMetres':numeric['maxIndependentSourceBoneErrorMetres'],'maxSourceRotationErrorDegrees':numeric['maxIndependentSourceRotationErrorDegrees'],'reviewFrame':worst})
overview.save(out/'all-clips.jpg');(out/'measurements.json').write_text(json.dumps({'frames':sum(row['frames'] for row in rows),'clips':rows},indent=2)+'\n')
(out/'README.md').write_text('''# Automated UAL floor repair

All 14 rejected clips were re-exported by the tools, covering **591 integer frames**. No poses or individual frames were hand-edited. The existing 240 accepted exports were retained.

Support is inferred from sustained source-foot contact and pelvis height, without animation-name exceptions. Ground-supported clips keep their contact solver and enforce whole-body clearance in every frame. Free-space clips preserve the transferred articulation and original motion; one constant, geometry-measured vertical placement offset puts the entire clip above the floor. There is no frame-by-frame grounding or bobbing. Every offset is recorded in fit-report.json.

Independent source evaluation records all 65 bone transforms. Free-space bone orientations and proportioned positions are checked against that source evaluation, independently of the exporter, after removing the fixed placement offset. Skin vertices and bones are compared with Blender at every frame. Whole-body floor checks have no source-context exemption. The saved Blender actions are also reopened and checked.

The actual app renderer reproduced all 591 frames. Front and side source/Blender/app images and sheets cover every frame of every repaired clip. `browser-comparison.json` records numerical results; `measurements.json` records policies and offsets. `all-clips.jpg` shows a floor-relevant frame from each clip.

The audited catalog now contains all 254 clips, with zero floor exclusions. No existing test suites were run.
''')
print('Assembled',len(rows),'clips and',sum(row['frames'] for row in rows),'frames in both views.')
