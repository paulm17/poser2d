"""Visible skin triangle intersections between anatomically separate limbs.
Shared joints are deliberately not treated as collisions. No animation names.
"""
import numpy as np
from mathutils.bvhtree import BVHTree

def limb_faces(model):
 names=[b['name'] for b in model['bones']]
 si=np.asarray(model['skinIndices']).reshape(-1,4);sw=np.asarray(model['skinWeights']).reshape(-1,4)
 triangles=np.asarray(model['indices']).reshape(-1,3)
 groups={}
 for side in ['l','r']:
  for part,prefixes in [('arm',('upperarm_','lowerarm_','hand_','thumb_','index_','middle_','ring_','pinky_')),('leg',('thigh_','calf_','foot_','ball_'))]:
   ids=[i for i,n in enumerate(names) if n.endswith('_'+side) and n.startswith(prefixes)]
   weights=np.where(np.isin(si,ids),sw,0).sum(axis=1)
   groups[part+'_'+side]=triangles[(weights[triangles]>.5).all(axis=1)].tolist()
 return groups

_group_index_cache={}
def intersections(points,groups,details=None):
 # Exact broad-phase rejection, then lazy BVHs. Reuse one point conversion.
 cached=_group_index_cache.get(id(groups))
 if cached is None or cached[0] is not groups:
  cached=(groups,{n:np.unique(f) for n,f in groups.items()});_group_index_cache[id(groups)]=cached
 points_array=np.asarray(points);bounds={n:(points_array[v].min(0),points_array[v].max(0)) for n,v in cached[1].items()}
 trees={};pointlist=None
 def tree(n):
  nonlocal pointlist
  if n not in trees:
   if pointlist is None:pointlist=points_array.tolist()
   trees[n]=BVHTree.FromPolygons(pointlist,groups[n],all_triangles=True,epsilon=0.)
  return trees[n]
 result={}
 keys=list(groups)
 for i,a in enumerate(keys):
  for b in keys[i+1:]:
   if np.any(bounds[a][1]<bounds[b][0]-1e-8) or np.any(bounds[b][1]<bounds[a][0]-1e-8):continue
   hits=tree(a).overlap(tree(b))
   if hits:
    # BVH overlap is broad phase. Confirm with triangle separating axes.
    points_array=np.asarray(points);ia,ib=np.asarray(hits).T
    ta=points_array[np.asarray(groups[a])[ia]];tb=points_array[np.asarray(groups[b])[ib]]
    ea=np.roll(ta,-1,axis=1)-ta;eb=np.roll(tb,-1,axis=1)-tb
    na=np.cross(ea[:,0],ea[:,1]);nb=np.cross(eb[:,0],eb[:,1])
    axes=[na,nb]+[np.cross(ea[:,u],eb[:,v]) for u in range(3) for v in range(3)]
    axes += [np.cross(n,e[:,u]) for n,e in [(na,ea),(nb,eb)] for u in range(3)]
    keep=np.ones(len(hits),dtype=bool)
    for axis in axes:
     length=np.linalg.norm(axis,axis=1);axis=axis/np.maximum(length[:,None],1e-30)
     pa=np.einsum('nij,nj->ni',ta,axis);pb=np.einsum('nij,nj->ni',tb,axis)
     separated=(pa.max(1)<pb.min(1)-1e-8)|(pb.max(1)<pa.min(1)-1e-8)
     keep &= ~((length>1e-12)&separated)
    count=int(keep.sum())
    if count:
     result[a+' / '+b]=count
     if details is not None:details[a+' / '+b]={'a':ia[keep].tolist(),'b':ib[keep].tolist()}
 return result

def clear_arms(worlds,names,parent,skin_points,model,max_degrees=6.,max_frame_degrees=30.):
 """Small shoulder clearance corrections, preserving elbow/wrist local motion.
 Uses final solved leg poses, never animation names or hand-selected frames.
 """
 import math
 from mathutils import Vector,Quaternion,Matrix
 groups=limb_faces(model)
 def rotate(world,side,degrees,bias=0.,basis="hand"):
  result={n:m.copy() for n,m in world.items()};bone='upperarm_'+side;origin=world[bone].translation
  lateral=(world['upperarm_'+side].translation-world['upperarm_'+('r' if side=='l' else 'l')].translation).normalized()
  up=(world['neck_01'].translation-world['pelvis'].translation).normalized()
  forward=lateral.cross(up).normalized()*(1 if side=='l' else -1)
  lateral=(lateral+forward*bias).normalized()
  direction=world[('lowerarm_' if basis=='upperarm' else 'hand_')+side].translation-origin;axis=direction.cross(lateral)
  if axis.length<1e-8:return result
  q=Quaternion(axis.normalized(),math.radians(degrees))
  for n in names:
   a=n
   while a and a!=bone:a=parent[a]
   if a==bone:
    p,r,s=world[n].decompose();result[n]=Matrix.LocRotScale(origin+q@(p-origin),q@r,s)
  return result
 def audit(world):return intersections(skin_points(world,np.arange(len(model['vertices'])//3)),groups)
 before=[audit(w) for w in worlds];angles={};corrected=worlds
 for side in ['l','r']:
  relevant=lambda hits:any(('arm_'+side) in pair for pair in hits)
  if not any(relevant(audit(w)) for w in corrected):angles[side]=0.;continue
  def attempt(angle,bias):
   trial=[rotate(w,side,angle,bias) for w in corrected]
   return trial,not any(relevant(audit(w)) for w in trial)
  best=None
  for bias in [0.,-1.,1.,-3.,3.]:
   high=2.
   while high<=min(max_degrees,best[0] if best else max_degrees):
    trial,ok=attempt(high,bias)
    print('ARM CLEARANCE',side,high,'direction',bias,'clear',ok,flush=True)
    if ok:
     low=max(0.,high-2.)
     while high-low>.1:
      mid=(high+low)/2;candidate,ok=attempt(mid,bias)
      if ok:high=mid;trial=candidate
      else:low=mid
     if best is None or high<best[0]:best=(high,bias)
     break
    high+=2.
  if best is None:
   # A fixed direction can pass through a moving knee. Find small per-frame
   # clearance corrections rather than forcing a large constant spread.
   specs=[];changed=[];previous=(1.,0.,'hand')
   for frame_index,w in enumerate(corrected):
    if not relevant(audit(w)):specs.append({'degrees':0.,'direction':previous});changed.append(w);continue
    candidates=[]
    directions=list(dict.fromkeys([previous]+[(sign,bias,basis) for basis in ['hand','upperarm'] for sign,bias in [(1.,0.),(1.,-1.),(1.,1.),(-1.,0.),(-1.,-1.),(-1.,1.),(1.,-100.),(1.,100.)]]))
    for sign,bias,basis in directions:
     high=2.
     while high<=min(max_frame_degrees,min((v[0] for v in candidates),default=max_frame_degrees)):
      trial=rotate(w,side,sign*high,bias,basis)
      if not relevant(audit(trial)):
       low=max(0.,high-2.)
       while high-low>.15:
        mid=(high+low)/2
        if relevant(audit(rotate(w,side,sign*mid,bias,basis))):low=mid
        else:high=mid
       candidates.append((high+.2,sign,bias,basis));break
      high+=2.
    if not candidates:raise ValueError('Small arm correction cannot clear frame '+str(frame_index)+'; export rejected')
    angle,sign,bias,basis=min(candidates,key=lambda v:v[0]);previous=(sign,bias,basis)
    specs.append({'degrees':angle,'direction':previous});changed.append(rotate(w,side,sign*angle,bias,basis))
    print('SMALL ARM CLEARANCE',side,frame_index,angle,sign,bias,flush=True)
   angles[side]={'perFrame':specs,'maximumDegrees':max(s['degrees'] for s in specs)};corrected=changed
  else:
   angle,bias=best;angles[side]={'degrees':angle+.15,'sagittalBias':bias};corrected=[rotate(w,side,angle+.15,bias) for w in corrected]
 # Smooth corrections in the torso frame, then project each smoothed sample
 # back onto the collision-free set. Never smooth the source animation itself.
 for side in ['l','r']:
  if not isinstance(angles[side],dict) or 'perFrame' not in angles[side]:continue
  bone='upperarm_'+side
  def apply_q(world,q):
   result={n:m.copy() for n,m in world.items()};origin=world[bone].translation
   for n in names:
    a=n
    while a and a!=bone:a=parent[a]
    if a==bone:
     p,r,scale=world[n].decompose();result[n]=Matrix.LocRotScale(origin+q@(p-origin),q@r,scale)
   return result
  raw=[];torso=[]
  for old,new in zip(worlds,corrected):
   t=old['spine_03'].to_quaternion();q=new[bone].to_quaternion()@old[bone].to_quaternion().inverted();torso.append(t);raw.append(t.inverted()@q@t)
  smoothed=[]
  for i,w in enumerate(worlds):
   samples=[raw[min(len(raw)-1,max(0,i+j))] for j in range(-3,4)]
   anchor=raw[i];values=np.array([list(q) if q.dot(anchor)>=0 else [-v for v in q] for q in samples]);values=values.mean(axis=0);values/=np.linalg.norm(values);average=Quaternion(values.tolist())
   chosen=raw[i]
   base={n:m.copy() for n,m in corrected[i].items()}
   for n in names:
    a=n
    while a and a!=bone:a=parent[a]
    if a==bone:base[n]=w[n].copy()
   for step in range(11):
    q=average.slerp(raw[i],step/10);trial=apply_q(base,torso[i]@q@torso[i].inverted())
    if not audit(trial):chosen=q;break
   smoothed.append(apply_q(base,torso[i]@chosen@torso[i].inverted()))
  for i in range(len(corrected)):
   for n in names:
    a=n
    while a and a!=bone:a=parent[a]
    if a==bone:corrected[i][n]=smoothed[i][n]
  angles[side]['smoothing']='Seven-frame torso-space quaternion mean, constrained by actual skin intersections'
 after=[audit(w) for w in corrected]
 if any(after):raise ValueError('Unresolved distinct-limb skin intersections; export rejected')
 frames=[]
 for i,(old,new) in enumerate(zip(worlds,corrected)):
  qs={}
  for side in ['l','r']:
   n='upperarm_'+side;q=new[n].to_quaternion()@old[n].to_quaternion().inverted();qs[side]=[q.x,q.y,q.z,q.w]
  frames.append({'frame':i,'worldShoulderCorrections':qs})
 return corrected,{'frames':frames,'version':1,'method':'Visible skin triangle BVH; all six distinct limb pairs, every frame','shoulderAdjustments':angles,'before':before,'after':after,'checkedFrames':len(worlds)}
