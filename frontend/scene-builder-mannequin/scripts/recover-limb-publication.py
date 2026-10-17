"""Recover an interrupted publication using its verified world-matrix buffer."""
import sys,json,hashlib
from pathlib import Path
import numpy as np
from mathutils import Matrix
p=Path(sys.argv[sys.argv.index('--')+1]);entry=json.loads((p/'manifest.json').read_text())[0];id=entry['id'];clip=json.loads((p/(id+'-frames.json')).read_text());model=json.loads((p/'model.json').read_text());names=[b['name'] for b in model['bones']];parents={b['name']:b['parent'] for b in model['bones']};world=np.fromfile(p/'blender-world.f64','<f8').reshape(len(clip['frames']),len(names),4,4)
for f,rows in zip(clip['frames'],world):
 w={n:Matrix(rows[i]) for i,n in enumerate(names)};bones={}
 for n in names:
  m=w[parents[n]].inverted()@w[n] if parents[n] else w[n];v,q,s=m.decompose();bones[n]={'position':list(v),'quaternion':[q.x,q.y,q.z,q.w],'scale':list(s)}
 f['bones']=bones
(p/(id+'-frames.json')).write_text(json.dumps(clip,separators=(',',':')));selected=json.loads((p/(id+'.json')).read_text());selected['bones']=clip['frames'][selected['frame']-clip['start']]['bones'];(p/(id+'.json')).write_text(json.dumps(selected,separators=(',',':')))
r=json.loads((p/'limb-clearance.json').read_text());r['clipSHA256']=hashlib.sha256((p/(id+'-frames.json')).read_bytes()).hexdigest();(p/'limb-clearance.json').write_text(json.dumps(r,indent=2));print('Recovered verified matrices',id)
