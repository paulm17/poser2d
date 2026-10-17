"""Replay a recorded support solve without reloading or refitting source assets.
Blender --background --python this.py -- model.json support-solve.json output.json
Diagnostic output only; export-ual-fit.mjs remains the publishing gate.
"""
import sys,json,importlib.util
from pathlib import Path
import numpy as np
from mathutils import Matrix,Quaternion,Vector
model_path,support_path,output=sys.argv[sys.argv.index('--')+1:]
model=json.loads(Path(model_path).read_text());record=json.loads(Path(support_path).read_text())
names=record['names'];parents=record['parents'];rest={}
for b in model['bones']:
 q=b['quaternion'];local=Matrix.LocRotScale(Vector(b['position']),Quaternion((q[3],*q[:3])),Vector(b['scale']))
 rest[b['name']]=rest[b['parent']]@local if b['parent'] else local
inverse={n:m.inverted() for n,m in rest.items()}
si=np.asarray(model['skinIndices']).reshape(-1,4);sw=np.asarray(model['skinWeights']).reshape(-1,4)
vertices=np.asarray(model['vertices']).reshape(-1,3);neutral=np.c_[vertices,np.ones(len(vertices))]
def skin(world,ids):
 matrices=np.asarray([world[n]@inverse[n] for n in names]);result=np.zeros((len(ids),4))
 for k in range(4):result+=np.einsum('nij,nj->ni',matrices[si[ids,k]],neutral[ids])*sw[ids,k,None]
 return result[:,:3]
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
worlds=[{n:Matrix(f['boneWorld'][n]) for n in names} for f in record['frames']]
source=[{n:Matrix(f['sourceWorld'][n]) for n in names} for f in record['frames']]
previous={'frames':[{'worldBoneCorrections':{n:[0,0,0,1] for n in names}} for f in worlds]}
worlds,report=module('trajectory','limb-trajectory.py').refine(worlds,names,parents,skin,model,module('collision','limb-collision.py'),previous,record['contacts'],source)
Path(output).write_text(json.dumps({'report':report,'frames':[{n:[list(r) for r in w[n]] for n in names} for w in worlds]}))
