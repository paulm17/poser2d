"""Choose collision-free correction trajectories with an explicit time cost.
Candidates are measured against visible skin; selection is deterministic Viterbi.
"""
import math,numpy as np
from mathutils import Matrix,Quaternion,Vector

def refine(worlds,names,parents,skin,model,collision,previous,contacts,source_frames=None):
 original=[]
 for i,current in enumerate(worlds):
  row=previous['frames'][i];w={}
  for n in names:
   p,q,s=current[n].decompose();a=row['worldBoneCorrections'][n];w[n]=Matrix.LocRotScale(p-Vector(row.get('worldPositionOffsets',{}).get(n,[0,0,0])),Quaternion((a[3],*a[:3])).inverted()@q,s)
  original.append(w)
 result=[{n:m.copy() for n,m in w.items()} for w in original];groups=collision.limb_faces(model);visible=np.unique(model['indices']);ids=np.arange(len(model['vertices'])//3);choices={}
 def valid(w,part=None):
  points=skin(w,ids)
  if float(points[visible,1].min())<-.00009:return False
  hits=collision.intersections(points,groups)
  return not hits if part is None else not any(part in pair for pair in hits)
 def branch(n,root):
  while n and n!=root:n=parents[n]
  return n==root
 def delta_local(old,new,n):
  p=parents[n];a=old[p].inverted()@old[n] if p else old[n];b=new[p].inverted()@new[n] if p else new[n]
  return b.to_quaternion()@a.to_quaternion().inverted()
 def arm_pose(frame,side,qs):
  roots=['clavicle_'+side,'upperarm_'+side];base=original[frame];w={n:m.copy() for n,m in result[frame].items()}
  for n in names:
   if not branch(n,roots[0]):continue
   p=parents[n];local=base[p].inverted()@base[n];pos,q,s=local.decompose()
   if n in roots:q=qs[roots.index(n)]@q
   w[n]=w[p]@Matrix.LocRotScale(pos,q,s)
  return w
 def yaw_pose(frame,side,angles):
  base=original[frame];qs=[]
  for root,angle in zip(['clavicle_'+side,'upperarm_'+side],angles):
   parent_q=base[parents[root]].to_quaternion();qs.append(parent_q.inverted()@Quaternion(Vector((0,1,0)),math.radians(angle))@parent_q)
  return arm_pose(frame,side,qs)
 def knee(w,side,angle):
  w={n:m.copy() for n,m in w.items()};a=w['thigh_'+side].translation;axis=w['foot_'+side].translation-a
  if axis.length<1e-8:return w
  q=Quaternion(axis.normalized(),math.radians(angle))
  for n in ['thigh_'+side,'calf_'+side]:
   p,r,s=w[n].decompose();w[n]=Matrix.LocRotScale(a+q@(p-a),q@r,s)
  return w
 def move(w,side,offset):
  if offset.length<1e-7:return {n:m.copy() for n,m in w.items()}
  w={n:m.copy() for n,m in w.items()};a,b,e=[w[n+'_'+side].translation.copy() for n in ['thigh','calf','foot']];target=e+offset;axis=target-a;distance=axis.length;l1=(b-a).length;l2=(e-b).length
  if not abs(l1-l2)+1e-6<distance<l1+l2-1e-6:return None
  axis/=distance;along=(l1*l1-l2*l2+distance*distance)/(2*distance);pole=axis.cross(w['calf_'+side].to_quaternion()@knee_hinges[side])
  if pole.length<1e-8:return None
  B=a+axis*along+pole.normalized()*math.sqrt(max(0,l1*l1-along*along))
  for n,old,new,pos in [('thigh_'+side,b-a,B-a,a),('calf_'+side,e-b,target-B,B)]:
   _,r,s=w[n].decompose();w[n]=Matrix.LocRotScale(pos,old.rotation_difference(new)@r,s)
  for n in ['foot_'+side,'ball_'+side,'ball_leaf_'+side]:w[n].translation+=offset
  return w
 knee_hinges={}
 for side in ['l','r']:
  def sample(w):
   a,b,e=[w[n+'_'+side].translation for n in ['thigh','calf','foot']]
   return (b-a).cross(e-b)
  reference=max(original,key=lambda w:sample(w).length_squared);hinge=sample(reference)
  if hinge.length<1e-8:hinge=reference['calf_'+side].to_quaternion()@Vector((1,0,0))
  knee_hinges[side]=reference['calf_'+side].to_quaternion().inverted()@hinge.normalized()
 si=np.asarray(model['skinIndices']).reshape(-1,4);sw=np.asarray(model['skinWeights']).reshape(-1,4);neutral=np.asarray(model['vertices']).reshape(-1,3);toe_ids={};heel_ids={}
 for side in ['l','r']:
  foot=names.index('foot_'+side);toe=[names.index('ball_'+side),names.index('ball_leaf_'+side)]
  toe_ids[side]=np.intersect1d(visible,np.flatnonzero(np.where(np.isin(si,toe),sw,0).sum(1)>.5))
  rest_ankle=next(b['headPos'][1] for b in model['bones'] if b['name']=='foot_'+side)
  heel_ids[side]=np.setdiff1d(np.intersect1d(visible,np.flatnonzero((np.where(si==foot,sw,0).sum(1)>.05)&(neutral[:,1]<rest_ankle+.04))),toe_ids[side])
 def pitch(w,side,joint,angle):
  w={n:m.copy() for n,m in w.items()};bone=joint+'_'+side;child=('ball' if joint=='foot' else 'ball_leaf')+'_'+side;pivot=w[bone].translation;forward=w[child].translation-pivot;axis=Vector((0,1,0)).cross(forward)
  if axis.length<1e-8:return w
  q=Quaternion(axis.normalized(),angle);chain=['ball_'+side,'ball_leaf_'+side]
  if joint=='foot':chain.insert(0,bone)
  for n in chain:
   p,r,scale=w[n].decompose();w[n]=Matrix.LocRotScale(pivot+q@(p-pivot),q@r,scale)
  return w
 def project_contacts(frame,w):
  for side in ['l','r']:
   targets=np.array([float(skin(original[frame],heel_ids[side])[:,1].min()),float(skin(original[frame],toe_ids[side])[:,1].min())]);targets=np.maximum(0,targets)
   # A foot minimally raised out of the floor also needs its skin clearance
   # preserved while the knee swivels, even outside a source planted run.
   angles=np.zeros(2)
   for iteration in range(8):
    heights=np.array([float(skin(w,heel_ids[side])[:,1].min()),float(skin(w,toe_ids[side])[:,1].min())]);error=np.where(targets<.002,heights-targets,np.minimum(0,heights))
    if np.abs(error).max()<.00001:break
    columns=[]
    for joint in ['foot','ball']:
     trial=pitch(w,side,joint,.001);changed=np.array([float(skin(trial,heel_ids[side])[:,1].min()),float(skin(trial,toe_ids[side])[:,1].min())]);columns.append((changed-heights)/.001)
    step=np.linalg.lstsq(np.asarray(columns).T,-error,rcond=None)[0];step=np.clip(step,-.03,.03);angles+=step
    if np.abs(angles).max()>math.radians(8):return None
    w=pitch(pitch(w,side,'foot',float(step[0])),side,'ball',float(step[1]))
  return w
 def legs_pose(frame,parameters):
  base=original[frame];w={n:m.copy() for n,m in result[frame].items()}
  for n in names:
   if n.startswith(('thigh_','calf_','foot_','ball_')):w[n]=base[n].copy()
  left,right,mm,*extra=parameters;lift=extra[0] if extra else 0.;reach=extra[1:3] if len(extra)>=3 else [0.,0.]
  body=Vector((extra[3]*.001,0,extra[4]*.001)) if len(extra)>=5 else Vector((0,0,0))
  if body.length:
   for n in names:
    if n!='root':w[n].translation+=body
   for side in ['l','r']:
    w=move(w,side,-body)
    if w is None:return None
  if lift:
   for n in names:
    if n!='root':w[n].translation.y+=lift
   for side in ['l','r']:
    w=move(w,side,Vector((0,-lift,0)))
    if w is None:return None
  if mm:
   if contacts['l'][frame] or contacts['r'][frame]:return None
   lateral=base['thigh_l'].translation-base['thigh_r'].translation;lateral.y=0;lateral.normalize()
   w=move(w,'l',lateral*mm*.001)
   if w is None:return None
   w=move(w,'r',-lateral*mm*.001)
   if w is None:return None
  for side,amount in zip(['l','r'],reach):
   if abs(amount)<1e-7:continue
   if contacts[side][frame]:return None
   direction=w['foot_'+side].translation-w['thigh_'+side].translation;direction.y=0
   if direction.length<1e-8:return None
   w=move(w,side,direction.normalized()*(amount*.001))
   if w is None:return None
  lateral=base['thigh_l'].translation-base['thigh_r'].translation;lateral.y=0;lateral.normalize()
  for side,amount,sign in zip(['l','r'],extra[5:7] if len(extra)>=7 else [0.,0.],[1,-1]):
   if abs(amount)<1e-7:continue
   if contacts[side][frame]:return None
   w=move(w,side,lateral*(sign*amount*.001))
   if w is None:return None
  return project_contacts(frame,knee(knee(w,'l',left),'r',right))
 feature_cache={}
 def feature(frame,w,group):
  key=(frame,id(w),tuple(group))
  if key in feature_cache:return feature_cache[key]
  arm_group=all(n.startswith(('clavicle_','upperarm_')) for n in group);body=Quaternion() if arm_group else original[frame]['spine_03'].to_quaternion();pivot=original[frame]['pelvis'].translation;values=[]
  for n in group:
   reference=source_frames[frame][n] if source_frames is not None and n.startswith(('thigh_','calf_','foot_','ball_')) else original[frame][n]
   q=body.inverted()@(w[n].to_quaternion()@reference.to_quaternion().inverted())@body
   if q.w<0:q.negate()
   values.extend(np.asarray(q.axis)*q.angle*180/math.pi)
   values.extend(np.asarray(body.inverted()@(w[n].translation-original[frame][n].translation))*200)
   if source_frames is not None and not arm_group:
    parent=parents[n];actual=w[parent].inverted()@w[n] if parent else w[n];reference=source_frames[frame][parent].inverted()@source_frames[frame][n] if parent else source_frames[frame][n]
    local_q=actual.to_quaternion()@reference.to_quaternion().inverted()
    if local_q.w<0:local_q.negate()
    values.extend(np.asarray(local_q.axis)*local_q.angle*180/math.pi);values.extend([0,0,0])
  answer=np.asarray(values);feature_cache[key]=answer;return answer
 def choose(group,label,candidates,write_group=None,limit=None):
  features=[np.asarray([feature(f,w,group) for w,_ in rows]) for f,rows in enumerate(candidates)]
  def distance(a,b):
   costs=[]
   for start in range(0,len(b),32):
    chunk=b[start:start+32];difference=chunk[:,None,:]-a[None,:,:];jumps=np.max(np.abs(difference),axis=2)
    cost=(difference*difference).sum(2)+np.where(jumps>4,(jumps-4)**2*100,0)
    if limit is not None:
     blocks=difference.reshape(len(chunk),len(a),-1,6)
     bad=np.linalg.norm(blocks[:,:,:,:3],axis=3).max(2)>limit
     cost[bad]=np.inf
    costs.append(cost)
   return np.concatenate(costs)
  transitions=[distance(features[f-1],features[f]) for f in range(1,len(features))]
  if label=='legs':
   # Continuity constrains the actual fitting parameters. Comparing target
   # rotations directly with source rotations rejects legitimate fast source
   # movement and different knee bends on bodies with different proportions.
   parameter_rows=[]
   for f,rows in enumerate(candidates):
    values=[]
    for w,param in rows:
     if isinstance(param,str):
      value=list(measured[f])
     else:value=list(param)+[0.]*(10-len(param))
     values.append(value)
    parameter_rows.append(np.asarray(values))
   for f in range(1,len(features)):
    delta=parameter_rows[f][:,None,:]-parameter_rows[f-1][None,:,:]
    bounds=np.array([4.,4.,4.,.005,6.,6.,6.,6.,4.,4.])
    bad=(np.abs(delta)>bounds).any(axis=2)
    # Parameter continuity alone misses changes caused by the floor solve.
    # Bound the actual source-relative joint correction as well, matching the
    # independent export gate rather than selecting a path it must reject.
    for start in range(0,len(features[f]),32):
     difference=features[f][start:start+32,None,:]-features[f-1][None,:,:]
     blocks=difference.reshape(len(difference),len(features[f-1]),-1,6)
     local_steps=np.linalg.norm(blocks[:,:,1::2,:3],axis=3).max(2)
     bad[start:start+32] |= local_steps>7.5
    transitions[f-1][bad]=np.inf

  closed=max(original[0][n].to_quaternion().rotation_difference(original[-1][n].to_quaternion()).angle for n in names)<math.radians(1)
  best=None
  for start in (range(len(features[0])) if closed else [None]):
   cost=np.sum(features[0]*features[0],axis=1)*.1;backs=[]
   if start is not None:cost[np.arange(len(cost))!=start]=np.inf
   for f,transition in enumerate(transitions,1):
    totals=transition+cost[None,:];back=totals.argmin(axis=1);cost=totals[np.arange(len(features[f])),back]+np.sum(features[f]*features[f],axis=1)*.1;backs.append(back)
    if not np.isfinite(cost).any():
     print('TRAJECTORY DISCONNECTED',label,'frame',f,'candidate edges',int(np.isfinite(transition).sum()),flush=True)
     break
   if not np.isfinite(cost).any():continue
   if start is not None:cost+=distance(features[0][start:start+1],features[-1])[:,0]*100
   index=int(cost.argmin());score=cost[index]
   if best is None or score<best[0]:best=(score,index,backs)
  if best is None or not math.isfinite(best[0]):raise ValueError('No continuous collision-free trajectory for '+label)
  _,index,backs=best;path=[index]
  for back in reversed(backs):index=int(back[index]);path.append(index)
  path.reverse();selected=[]
  for f,index in enumerate(path):
   w,parameters=candidates[f][index]
   for n in (write_group or group):result[f][n]=w[n].copy()
   selected.append(parameter_rows[f][index].tolist() if label=='legs' else parameters)
  choices[label]=selected
 # Refine arms independently. All six limb pairs are still checked for every
 # candidate, including against the already accepted opposite arm and legs.
 for side in ['l','r']:
  root='clavicle_'+side;group=[n for n in names if branch(n,root)];templates=[]
  for f in range(len(worlds)):templates.append([delta_local(original[f],worlds[f],n) for n in [root,'upperarm_'+side]])
  # Prefer a fixed anatomical correction when it clears the complete action.
  # It preserves all source joint motion and cannot switch correction branches.
  constant=None
  for degrees in [0,2,4,6,8,10,12,15,18,22,26,30,36,42,48,54,60,70,80,90]:
   for clavicle,upper in [(0,degrees),(0,-degrees),(degrees,0),(-degrees,0),(degrees,-degrees),(-degrees,degrees)]:
    trial=[]
    for f in range(len(worlds)):
     w=yaw_pose(f,side,[clavicle,upper])
     if not valid(w,'arm_'+side):break
     trial.append(w)
    if len(trial)==len(worlds):constant=(trial,{'groundYawDegrees':[clavicle,upper]});break
   if constant:break
  if constant:
   for f,w in enumerate(constant[0]):
    for n in group:result[f][n]=w[n].copy()
   choices['arm_'+side]=[constant[1] for w in worlds];print('CONTINUOUS GROUND-YAW ARM',side,constant[1],flush=True);continue
  for degrees in [0,2,4,6,8,10,12,15,18,22,26,30,36,42]:
   for joint in [1,0]:
    for axis in [Vector((1,0,0)),Vector((0,0,1)),Vector((0,1,0)),Vector((1,0,1)).normalized(),Vector((1,0,-1)).normalized()]:
     for sign in [1,-1]:
      qs=[Quaternion(),Quaternion()];qs[joint]=Quaternion(axis,math.radians(degrees*sign));trial=[]
      for f in range(len(worlds)):
       w=arm_pose(f,side,qs)
       if not valid(w,'arm_'+side):break
       trial.append(w)
      if len(trial)==len(worlds):constant=(trial,{'constantJoint':joint,'axis':list(axis),'degrees':degrees*sign});break
     if constant:break
    if constant:break
   if constant:break
  if constant:
   for f,w in enumerate(constant[0]):
    for n in group:result[f][n]=w[n].copy()
   choices['arm_'+side]=[constant[1] for w in worlds];print('CONTINUOUS CONSTANT ARM',side,constant[1],flush=True);continue
  candidates=[]
  for f in range(len(worlds)):
   rows=[({n:m.copy() for n,m in result[f].items()},'accepted')] if valid(result[f],'arm_'+side) else [];seen=set()
   pool=[([Quaternion(),Quaternion()],'zero')]
   for j in range(max(0,f-12),min(len(worlds),f+13)):
    for scale in [.1,.2,.3,.4,.5,.6,.7,.8,.9,1.,1.1,1.25,1.5]:pool.append(([Quaternion(q.axis,q.angle*scale) for q in templates[j]],{'template':j,'scale':scale}))
   for j in range(max(0,f-12),min(len(worlds)-1,f+12)):
    for blend in [.25,.5,.75]:pool.append(([a.slerp(b,blend) for a,b in zip(templates[j],templates[j+1])],{'between':[j,j+1],'blend':blend}))
   if len(rows)<8:
    for angle in [2,4,6,8,10,12,15,18,22,26,30,36,42]:
     for joint in [1,0]:
      for axis in [Vector((1,0,0)),Vector((0,0,1)),Vector((0,1,0)),Vector((1,0,1)).normalized(),Vector((1,0,-1)).normalized()]:
       for sign in [1,-1]:
        qs=[Quaternion(),Quaternion()];qs[joint]=Quaternion(axis,math.radians(angle*sign));pool.append((qs,{'joint':joint,'axis':list(axis),'degrees':angle*sign}))
   for clavicle in [-18,-12,-6,0,6,12,18]:
    for upper in [-18,-12,-6,0,6,12,18]:
     w=yaw_pose(f,side,[clavicle,upper])
     if valid(w,'arm_'+side):rows.append((w,{'groundYawDegrees':[clavicle,upper]}))
   for angle in range(-24,25,2):
    for clavicle,upper in [(0,angle),(angle,0),(angle,-angle)]:
     w=yaw_pose(f,side,[clavicle,upper])
     if valid(w,'arm_'+side):rows.append((w,{'groundYawDegrees':[clavicle,upper]}))
   for qs,param in pool:
    if any(abs(q.angle)>math.radians(65) for q in qs):continue
    key=tuple(round(v,3) for q in qs for v in q)
    if key in seen:continue
    seen.add(key);w=arm_pose(f,side,qs)
    if valid(w,'arm_'+side):rows.append((w,param))
   if not rows:
    # A somersault can need coupled collarbone and shoulder movement. A
    # one-joint search cannot move the elbow around the knee while keeping
    # the hand clear of the plane.
    for axis_a in [Vector((1,0,0)),Vector((0,0,1)),Vector((0,1,0))]:
     for axis_b in [Vector((1,0,0)),Vector((0,0,1)),Vector((0,1,0))]:
      for a in [-45,-30,-15,0,15,30,45]:
       for b in [-60,-45,-30,-15,0,15,30,45,60]:
        w=arm_pose(f,side,[Quaternion(axis_a,math.radians(a)),Quaternion(axis_b,math.radians(b))])
        if valid(w,'arm_'+side):rows.append((w,{'coupledAxes':[list(axis_a),list(axis_b)],'degrees':[a,b]}))
   if not rows:raise ValueError('No collision-free arm candidates at frame '+str(f)+' side '+side)
   candidates.append(rows);print('TRAJECTORY ARM',side,f,len(rows),flush=True)
  choose([root,'upperarm_'+side],'arm_'+side,candidates,group,6.)
 group=[n for n in names if n.startswith(('thigh_','calf_','foot_','ball_'))];candidates=[]
 # Prefer one anatomical hip adjustment over changing IK branches. An
 # entirely unplanted leg can retain all its authored knee motion while its
 # track is widened to clear the other thigh. Keep the foot's world attitude.
 if source_frames is not None and any('leg_l / leg_r' in collision.intersections(skin(w,ids),groups) for w in result):
  for side in ['l','r']:
   if any(contacts[side]):continue
   first=original[0];lateral=first['thigh_l'].translation-first['thigh_r'].translation;up=first['spine_03'].translation-first['pelvis'].translation
   forward=lateral.cross(up).normalized();axis=first['pelvis'].to_quaternion().inverted()@forward
   root='thigh_'+side;branch_names=[n for n in names if branch(n,root)]
   for angle in range(1,21):
    accepted=None
    for sign in [1,-1]:
     trial=[];delta=Quaternion(axis,math.radians(angle*sign))
     for f in range(len(worlds)):
      w={n:m.copy() for n,m in result[f].items()}
      for n in branch_names:
       p=parents[n];local=original[f][p].inverted()@original[f][n];pos,q,scale=local.decompose()
       if n==root:q=delta@q
       w[n]=w[p]@Matrix.LocRotScale(pos,q,scale)
       if n=='foot_'+side:
        pos=w[n].translation;_,q,scale=original[f][n].decompose();w[n]=Matrix.LocRotScale(pos,q,scale)
      w=project_contacts(f,w)
      if w is None or not valid(w):break
      trial.append(w)
     if len(trial)!=len(worlds):continue
     values=[feature(f,w,group).reshape(-1,6) for f,w in enumerate(trial)]
     if any(np.linalg.norm((values[f]-values[f-1])[:,:3],axis=1).max()>7.5 for f in range(1,len(values))):continue
     accepted=trial;break
    if accepted:
     result=accepted;choices['constantHipAbduction']={'side':side,'degrees':angle*sign,'axis':list(axis),'footAttitude':'source world orientation'}
     choices['legs']=[[0.]*10 for w in worlds]
     print('CONTINUOUS CONSTANT HIP',choices['constantHipAbduction'],flush=True)
     return result,{'version':8,'method':'Constant anatomical hip correction; exact all-frame skin and continuity constraints','checkedFrames':len(worlds),'before':[{} for w in worlds],'after':[{} for w in worlds],'frames':[],'shoulderAdjustments':previous.get('shoulderAdjustments',{}),'trajectoryChoices':choices}
 measured=[]
 for f in range(len(worlds)):
  params=[]
  for side in ['l','r']:
   a,b,e=[original[f][n+'_'+side].translation for n in ['thigh','calf','foot']];axis=(e-a).normalized();u=b-a-axis*(b-a).dot(axis);v=result[f]['calf_'+side].translation-result[f]['thigh_'+side].translation;v-=axis*v.dot(axis)
   delta=result[f]['thigh_'+side].to_quaternion()@original[f]['thigh_'+side].to_quaternion().inverted()
   if delta.w<0:delta.negate()
   params.append(math.degrees(2*math.atan2(axis.dot(Vector((delta.x,delta.y,delta.z))),delta.w)))
  lateral=original[f]['thigh_l'].translation-original[f]['thigh_r'].translation;lateral.y=0;lateral.normalize()
  offsets=[result[f]['foot_'+side].translation-original[f]['foot_'+side].translation for side in ['l','r']]
  spread=.5*(offsets[0].dot(lateral)-offsets[1].dot(lateral))*1000;reaches=[]
  for side,offset,sign in zip(['l','r'],offsets,[1,-1]):
   axis=original[f]['foot_'+side].translation-original[f]['thigh_'+side].translation;axis.y=0
   reaches.append((offset-lateral*(spread*.001*sign)).dot(axis.normalized())*1000 if axis.length>1e-8 else 0.)
  pelvis_delta=result[f]['pelvis'].translation-original[f]['pelvis'].translation
  params.extend([spread,float(pelvis_delta.y),*reaches,pelvis_delta.x*1000,pelvis_delta.z*1000,0.,0.]);measured.append(np.array(params))
 leg_features=[feature(f,result[f],group).reshape(-1,6) for f in range(len(worlds))]
 if source_frames is not None:
  previous_local={};maximum_local_step=0.
  for f,w in enumerate(result):
   for n in group:
    p=parents[n];actual=w[p].inverted()@w[n];reference=source_frames[f][p].inverted()@source_frames[f][n];delta=(actual.to_quaternion()@reference.to_quaternion().inverted()).normalized()
    if n in previous_local:maximum_local_step=max(maximum_local_step,math.degrees(2*math.acos(min(1.,abs(delta.dot(previous_local[n]))))))
    previous_local[n]=delta
  needs_legs=maximum_local_step>7.95
 else:needs_legs=any(np.linalg.norm((leg_features[f]-leg_features[f-1])[:,:3],axis=1).max()>7 for f in range(1,len(worlds)))
 needs_legs=needs_legs or any('leg_l / leg_r' in collision.intersections(skin(w,ids),groups) for w in result)
 active=[needs_legs and any(feature(f,result[f],group)**2>.01) for f in range(len(worlds))]
 for f in range(len(worlds)):
  rows=[({n:m.copy() for n,m in result[f].items()},'accepted')] if valid(result[f]) else []
  if not any(active[max(0,f-12):min(len(active),f+13)]):candidates.append(rows);continue
  max_left=min(60,max(24,4*math.ceil((max(abs(p[0]) for p in measured)+12)/4)));max_right=min(60,max(24,4*math.ceil((max(abs(p[1]) for p in measured)+12)/4)))
  parameters=[(l,r,0) for l in range(-max_left,max_left+1,4) for r in range(-max_right,max_right+1,4)]
  parameters +=[(l,r,mm) for mm in [2,5,10,20,40] for l,r in [(0,0),(10,-10),(-10,10),(20,-20),(-20,20)]]
  # Independent swing-foot clearance survives the opposite foot's landing.
  # Symmetric spreading incorrectly forces both offsets back to zero there.
  for side in ['l','r']:
   if contacts[side][f]:continue
   for amount in range(4,101,4):
    for lift in [0.,-.002,-.005,-.01,-.02]:
     for l,r in [(0,0),(-8,8),(8,-8)]:parameters.append((l,r,0.,lift,0.,0.,0.,0.,amount if side=='l' else 0.,amount if side=='r' else 0.))
  lifted=set([(-30,0),(-20,0),(-10,0),(0,0),(0,-30),(0,-20),(0,20),(20,-20),(-20,20),(30,0)])
  for j in range(max(0,f-4),min(len(worlds),f+5)):
   previous_param=previous.get('trajectoryChoices',{}).get('legs',[])
   if previous_param and isinstance(previous_param[j],list):lifted.add(tuple(previous_param[j][:2]))
  parameters +=[(left,right,0,lift) for lift in [-.02,-.015,-.01,-.005,.005,.01,.015,.02,.025,.03] for left,right in lifted]
  # Add continuous, measured trajectories instead of only coarse pole grids.
  nearby=measured[max(0,f-12):min(len(worlds),f+13)]
  average=np.mean(nearby,axis=0)
  parameters += [tuple(p*scale) for p in nearby+[average] for scale in [.25,.5,.75,1.,1.25]]
  parameters += [(average[0]+left,average[1]+right,0.,average[3]) for left in [-6,-4,-2,0,2,4,6] for right in [-6,-4,-2,0,2,4,6]]
  if source_frames is not None:
   reaches=[];natural=[];body_targets=[]
   for side in ['l','r']:
    a,b,e=[original[f][n+'_'+side].translation for n in ['thigh','calf','foot']];A,B,E=[source_frames[f][n+'_'+side].translation for n in ['thigh','calf','foot']];l1=(b-a).length;l2=(e-b).length
    cosine=max(-1.,min(1.,(B-A).normalized().dot((E-B).normalized())));distance=math.sqrt(max(0.,l1*l1+l2*l2+2*l1*l2*cosine));delta=e-a;horizontal=Vector((delta.x,0,delta.z)).length
    reaches.append(0. if contacts[side][f] else max(-50.,min(50.,(math.sqrt(max(0.,distance*distance-delta.y*delta.y))-horizontal)*1000)))
    if horizontal>1e-6:
     amount=1.-math.sqrt(max(0.,distance*distance-delta.y*delta.y))/horizontal
     body_targets.append(np.array([delta.x,delta.z])*amount*1000)
    axis=delta.normalized();rotation=source_frames[f]['thigh_'+side].to_quaternion()@original[f]['thigh_'+side].to_quaternion().inverted()
    if rotation.w<0:rotation.negate()
    natural.append(math.degrees(2*math.atan2(axis.dot(Vector((rotation.x,rotation.y,rotation.z))),rotation.w)))
   for fraction in np.linspace(0.,1.,11):
    reach_l,reach_r=[v*fraction for v in reaches]
    for lift in [-.02,-.01,0.,.01,.02,.03]:
     for l,r in [(0.,0.),tuple(average[:2]),tuple(measured[f][:2]),tuple(natural),(-10.,10.),(10.,-10.)]:parameters.append((l,r,0.,lift,reach_l,reach_r))
   if body_targets:
    body_targets.append(np.mean(body_targets,axis=0))
    for target in body_targets:
     for fraction in np.linspace(0.,1.5,16):
      x,z=np.clip(target*fraction,-100,100)
      for l,r in [(0.,0.),tuple(average[:2])]:parameters.append((l,r,0.,0.,0.,0.,float(x),float(z)))
   for x in [-40,-20,0,20,40]:
    for z in [-40,-20,0,20,40]:parameters.append((0.,0.,0.,0.,0.,0.,x,z))
  seen_params=set()
  for param in parameters:
   key=tuple(round(v,3) for v in param)
   if key in seen_params:continue
   seen_params.add(key)
   w=legs_pose(f,param)
   if w is not None and valid(w):rows.append((w,param))
  # Retain the closest candidates plus those close to neighbouring accepted
  # correction states, keeping dynamic programming bounded.
  ranked=sorted([row for row in rows if not isinstance(row[1],str)],key=lambda row:float(np.dot(feature(f,row[0],group),feature(f,row[0],group))))
  # Keep the best candidate in each pole cell, plus low-cost reach/lift variants.
  retained=ranked[:120];cells=set()
  for item in ranked:
   key=tuple(round(v/4) for v in item[1][:2])
   if key not in cells:
    cells.add(key)
    if not any(item is old for old in retained):retained.append(item)
  for neighbour in range(max(0,f-4),min(len(worlds),f+5)):
   goal=feature(neighbour,worlds[neighbour],group)
   for item in sorted(ranked,key=lambda item:float(np.sum((feature(f,item[0],group)-goal)**2)))[:3]:
    if not any(item is old for old in retained):retained.append(item)
  rows=[row for row in rows if isinstance(row[1],str)]+retained
  if not rows:raise ValueError('No collision-free leg candidates at frame '+str(f))
  if len(rows)<15:print('TRAJECTORY LEG BOTTLENECK',f,[row[1] for row in rows],flush=True)
  candidates.append(rows);print('TRAJECTORY LEGS',f,len(rows),flush=True)
 choose(group+['pelvis'],'legs',candidates,[n for n in names if n!='root'])
 if any(not valid(w) for w in result):raise ValueError('Trajectory selection introduced an intersection or floor penetration')
 return result,{'version':8,'method':'Skin-constrained candidate trajectories; deterministic temporal dynamic programming','checkedFrames':len(worlds),'before':[{} for w in worlds],'after':[{} for w in worlds],'frames':[],'shoulderAdjustments':previous.get('shoulderAdjustments',{}),'trajectoryChoices':choices}
