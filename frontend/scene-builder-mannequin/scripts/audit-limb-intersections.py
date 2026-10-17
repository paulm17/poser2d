"""Blender background audit of every exported visible-skin frame, no suites."""
import sys,json,importlib.util
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('collision',Path(__file__).with_name('limb-collision.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
args=sys.argv[sys.argv.index('--')+1:]
results=[]
paths=[]
for arg in args:
 p=Path(arg)
 paths.extend(sorted(q for q in p.glob('ual[12]-*') if q.is_dir() and (q/'model.json').exists()) if (p/'catalog.json').exists() else [p])
for p in paths:
 m=json.loads((p/'model.json').read_text());clip=next(p.glob('*-frames.json'));d=json.loads(clip.read_text());groups=c.limb_faces(m)
 vertices=np.fromfile(p/'blender-vertices.f32',dtype='<f4').reshape(len(d['frames']),-1,3)
 frames=[{'frame':f['frame'],'intersections':c.intersections(v,groups)} for f,v in zip(d['frames'],vertices)]
 report={'method':'BVH intersection of visible skin triangles assigned by anatomical skin weights; all six distinct limb pairs','action':d['action'],'frames':frames,'intersectingFrames':sum(bool(f['intersections']) for f in frames),'checkedFrames':len(frames)}
 print('AUDITED',d['action'],report['intersectingFrames'],flush=True)
 (p/'limb-intersections.json').write_text(json.dumps(report,indent=2));results.append({k:v for k,v in report.items() if k!='frames'})
summary={'actions':results,'checkedActions':len(results),'checkedFrames':sum(r['checkedFrames'] for r in results),'actionsWithIntersections':sum(r['intersectingFrames']>0 for r in results)}
if len(paths)>1:(paths[0].parent/'limb-intersection-audit.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary))
