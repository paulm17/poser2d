"""Independent triangle audit of geometry captured from actual editor controls."""
import sys,json,importlib.util,gzip
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('c',Path(__file__).with_name('limb-collision.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
root=Path(sys.argv[sys.argv.index('--')+1]);model=json.loads((Path(__file__).parents[1]/'assets/ual-library/ual1-Crouch_Fwd_L_Loop/model.json').read_text());reports={}
for editor in ['makehuman','legacy','legacy2']:
 rows=[]
 for frame in range(61):
  p=root/editor/(str(frame)+'.json');d=json.loads(p.read_text() if p.exists() else gzip.open(str(p)+'.gz','rt').read());hits=c.intersections(np.asarray(d['vertices']),d.get('groups') or c.limb_faces(model));rows.append({'frame':frame,'intersections':hits})
 report={'frames':61,'intersectingFrames':sum(bool(r['intersections']) for r in rows),'records':rows};(root/editor/'limb-intersections.json').write_text(json.dumps(report,indent=2));reports[editor]={k:v for k,v in report.items() if k!='records'}
(root/'app-limb-summary.json').write_text(json.dumps(reports,indent=2));print(json.dumps(reports))
