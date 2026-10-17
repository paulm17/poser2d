"""Constrained leg clearance followed by complete arm-pair clearance.
No named clips or frame exceptions. Changes remain on the original skeleton.
"""
import math,numpy as np
from mathutils import Vector,Quaternion,Matrix

def clear_limbs(worlds,names,parent,skin_points,model,collision,contacts=None):
 groups=collision.limb_faces(model);all_ids=np.arange(len(model['vertices'])//3)
 original=[{n:m.copy() for n,m in w.items()} for w in worlds]
 corrected=[{n:m.copy() for n,m in w.items()} for w in worlds]
 before=[collision.intersections(skin_points(w,all_ids),groups) for w in worlds];leg_specs=[]
 def audit(w):return collision.intersections(skin_points(w,all_ids),groups)
 visible=np.unique(model['indices']);foot_ids={}
 si=np.asarray(model['skinIndices']).reshape(-1,4);sw=np.asarray(model['skinWeights']).reshape(-1,4)
 for s in ['l','r']:
  ids=[names.index(n) for n in ['foot_'+s,'ball_'+s,'ball_leaf_'+s]];foot_ids[s]=np.intersect1d(visible,np.flatnonzero(np.where(np.isin(si,ids),sw,0).sum(1)>.5))
 def sole_tolerance(side,sole,frame):
  return .00008 if sole<=.002 or (contacts and contacts[side][frame]) else .02
 def rotate_knee(w,side,degrees):
  out={n:m.copy() for n,m in w.items()};a,b,e=[w[n+'_'+side].translation.copy() for n in ['thigh','calf','foot']];axis=(e-a).normalized();q=Quaternion(axis,math.radians(degrees))
  for n in ['thigh_'+side,'calf_'+side]:
   p,r,s=w[n].decompose();out[n]=Matrix.LocRotScale(a+q@(p-a),q@r,s)
  return out
 def rotate_clavicle(w,side,degrees,axis):
  out={n:m.copy() for n,m in w.items()};bone='clavicle_'+side;pivot=w[bone].translation;q=Quaternion(axis.normalized(),math.radians(degrees))
  for n in names:
   a=n
   while a and a!=bone:a=parent[a]
   if a==bone:
    p,r,s=w[n].decompose();out[n]=Matrix.LocRotScale(pivot+q@(p-pivot),q@r,s)
  return out
 def rotate_foot(w,side,degrees):
  out={n:m.copy() for n,m in w.items()};pivot=w['foot_'+side].translation;q=Quaternion(Vector((0,1,0)),math.radians(degrees))
  for n in ['foot_'+side,'ball_'+side,'ball_leaf_'+side]:
   p,r,scale=w[n].decompose();out[n]=Matrix.LocRotScale(pivot+q@(p-pivot),q@r,scale)
  return out
 def move_foot(w,side,offset):
  out={n:m.copy() for n,m in w.items()};tn,cn,fn=[n+'_'+side for n in ['thigh','calf','foot']];a,b,e=[w[n].translation.copy() for n in [tn,cn,fn]];target=e+offset;l1=(b-a).length;l2=(e-b).length;axis=target-a;dist=axis.length
  if not abs(l1-l2)+1e-6<dist<l1+l2-1e-6:return None
  axis/=dist;along=(l1*l1-l2*l2+dist*dist)/(2*dist);pole=(b-a)-axis*(b-a).dot(axis)
  if pole.length<1e-8:return None
  knee=a+axis*along+pole.normalized()*math.sqrt(max(0,l1*l1-along*along))
  for n,old_dir,new_dir,pos in [(tn,b-a,knee-a,a),(cn,e-b,target-knee,knee)]:
   p,r,s=w[n].decompose();q=old_dir.rotation_difference(new_dir);out[n]=Matrix.LocRotScale(pos,q@r,s)
  for n in [fn,'ball_'+side,'ball_leaf_'+side]:out[n].translation+=offset
  return out
 for f,w in enumerate(corrected):
  if 'leg_l / leg_r' not in before[f]:leg_specs.append(None);continue
  sole={s:float(skin_points(w,foot_ids[s])[:,1].min()) for s in ['l','r']}
  def acceptable(t):
   if t is None:return False
   pts=skin_points(t,visible)
   if pts[:,1].min()<-.00009:return False
   if any(abs(float(skin_points(t,foot_ids[s])[:,1].min())-sole[s])>sole_tolerance(s,sole[s],f) for s in ['l','r']):return False
   return 'leg_l / leg_r' not in audit(t)
  best=None
  for angle in [2,4,6,8,10,14,18]:
   for left,right in [(angle,0),(-angle,0),(0,angle),(0,-angle),(angle,-angle),(-angle,angle),(angle,angle),(-angle,-angle)]:
    t=rotate_knee(rotate_knee(w,'l',left),'r',right)
    if acceptable(t):best=(t,{'leftKneePoleDegrees':left,'rightKneePoleDegrees':right});break
   if best:break
  if best is None:
   for angle in [2,4,6,8,10,14,18]:
    for left,right in [(angle,0),(-angle,0),(0,angle),(0,-angle),(angle,-angle),(-angle,angle),(angle,angle),(-angle,-angle)]:
     t=rotate_foot(rotate_foot(w,'l',left),'r',right)
     if acceptable(t):best=(t,{'leftFootYawDegrees':left,'rightFootYawDegrees':right});break
    if best:break
  if best is None:
   for angle in [4,8,12,18]:
    for side in ['l','r']:
     for sign in [1,-1]:
      knee=rotate_knee(w,side,sign*angle)
      for foot_side in ['l','r']:
       for foot_sign in [1,-1]:
        t=rotate_foot(knee,foot_side,foot_sign*angle)
        if acceptable(t):best=(t,{('left' if side=='l' else 'right')+'KneePoleDegrees':sign*angle,('left' if foot_side=='l' else 'right')+'FootYawDegrees':foot_sign*angle});break
       if best:break
      if best:break
     if best:break
    if best:break
  if best is None:
   lateral=(w['thigh_l'].translation-w['thigh_r'].translation);lateral.y=0;lateral.normalize()
   for mm in [2,4,6,8,10,15,20,25,30,40,60,80,100,120]:
    for sl,sr in [(1,-1),(-1,1),(1,0),(0,-1),(-1,0),(0,1)]:
     if contacts and ((sl and contacts['l'][f]) or (sr and contacts['r'][f])):continue
     t=move_foot(w,'l',lateral*(mm*.001*sl))
     if t is not None:t=move_foot(t,'r',lateral*(mm*.001*sr))
     if acceptable(t):best=(t,{'leftFootOffsetMetres':list(lateral*(mm*.001*sl)),'rightFootOffsetMetres':list(lateral*(mm*.001*sr))});break
    if best:break
  if best is None:
   for left in [10,-10,20,-20]:
    for right in [10,-10,20,-20]:
     t=rotate_knee(rotate_knee(w,'l',left),'r',right)
     if acceptable(t):best=(t,{'leftKneePoleDegrees':left,'rightKneePoleDegrees':right});break
    if best:break
  if best is None and not (contacts and (contacts['l'][f] or contacts['r'][f])):
   lateral=(w['thigh_l'].translation-w['thigh_r'].translation);lateral.y=0;lateral.normalize()
   for mm in [10,20,40,60,80,100,120]:
    t=move_foot(w,'l',lateral*(mm*.001))
    if t is not None:t=move_foot(t,'r',-lateral*(mm*.001))
    if t is None:continue
    for left,right in [(10,-10),(-10,10),(20,-20),(-20,20),(30,-30),(-30,30),(40,0),(0,-40),(40,-40),(-40,40)]:
     candidate=rotate_knee(rotate_knee(t,'l',left),'r',right)
     if acceptable(candidate):best=(candidate,{'leftKneePoleDegrees':left,'rightKneePoleDegrees':right,'leftFootOffsetMetres':list(lateral*(mm*.001)),'rightFootOffsetMetres':list(-lateral*(mm*.001))});break
    if best:break
  if best is None:
   for angle in [22,26,30,40,50,60,70,80]:
    for left,right in [(angle,0),(-angle,0),(0,angle),(0,-angle),(angle,-angle),(-angle,angle),(angle,angle),(-angle,-angle)]:
     t=rotate_knee(rotate_knee(w,'l',left),'r',right)
     if acceptable(t):best=(t,{'leftKneePoleDegrees':left,'rightKneePoleDegrees':right});break
    if best:break
  if best is None:raise ValueError('Leg clearance unresolved at frame '+str(f)+' within bounded knee/foot adjustments')
  corrected[f]=best[0];leg_specs.append(best[1]);print('LEG CLEARANCE',f,best[1],flush=True)
 def smooth_leg_poles(current,specs):
  # Build a conservative bounded-slope envelope over each correction event.
  # A consistent direction avoids opposite knee swivels on adjacent frames.
  values={side:np.array([float((spec or {}).get(side+'KneePoleDegrees',0)) for spec in specs]) for side in ['left','right']}
  envelopes={}
  for side,raw in values.items():
   envelope=np.zeros(len(raw));active=np.flatnonzero(np.abs(raw)>.01)
   events=[]
   for index in active:
    if not events or index-events[-1][-1]>12:events.append([index])
    else:events[-1].append(index)
   for event in events:
    sign=1 if sum(raw[j] for j in event)>=0 else -1
    for i in range(len(raw)):
     value=max(max(0.,abs(raw[j])-3.*abs(i-j)) for j in event)
     if value>abs(envelope[i]):envelope[i]=sign*value
   envelopes[side]=envelope
  yaw={}
  for side,label in [('l','left'),('r','right')]:
   raw=np.array([float((spec or {}).get(label+'FootYawDegrees',0)) for spec in specs]);values=raw.copy()
   if contacts:
    index=0
    while index<len(raw):
     if not contacts[side][index]:index+=1;continue
     end=index+1
     while end<len(raw) and contacts[side][end]:end+=1
     samples=raw[index:end]
     if np.abs(samples).max()>0:
      sign=1 if samples.sum()>=0 else -1;values[index:end]=sign*np.abs(samples).max()
     index=end
   yaw[side]=values
  result=[]
  for i,w in enumerate(original):
   # Foot offsets, when needed, are allowed only during unplanted frames.
   trial=rotate_knee(rotate_knee(w,'l',envelopes['left'][i]),'r',envelopes['right'][i])
   for n in names:
    a=n
    while a and not a.startswith('clavicle_'):a=parent[a]
    if a:trial[n]=current[i][n].copy()
   spec=specs[i] or {}
   for side,label in [('l','left'),('r','right')]:
    if abs(yaw[side][i])>0:trial=rotate_foot(trial,side,float(yaw[side][i]))
   for side,label in [('l','left'),('r','right')]:
    if label+'FootOffsetMetres' in spec and trial is not None:trial=move_foot(trial,side,Vector(spec[label+'FootOffsetMetres']))
   sole={side:float(skin_points(w,foot_ids[side])[:,1].min()) for side in ['l','r']}
   valid=trial is not None and float(skin_points(trial,visible)[:,1].min())>=-.00009 and all(abs(float(skin_points(trial,foot_ids[side])[:,1].min())-sole[side])<sole_tolerance(side,sole[side],i) for side in ['l','r'])
   if valid and 'leg_l / leg_r' not in audit(trial) and sum(v for pair,v in audit(trial).items() if 'arm_' in pair and 'leg_' in pair)<=sum(v for pair,v in audit(current[i]).items() if 'arm_' in pair and 'leg_' in pair):result.append(trial)
   else:result.append(current[i])
  return result
 corrected=smooth_leg_poles(corrected,leg_specs)
 try:
  corrected,arm_report=collision.clear_arms(corrected,names,parent,skin_points,model,max_frame_degrees=12.)
 except ValueError as arm_error:
  # In folded poses the thigh can reach the shoulder itself. Rotating around
  # that shoulder cannot remove the overlap; change the knee pole instead.
  changed_any=False
  for f,w in enumerate(corrected):
   hits=audit(w);wanted=[pair for pair in hits if 'arm_' in pair and 'leg_' in pair]
   if not wanted:continue
   sole={side:float(skin_points(w,foot_ids[side])[:,1].min()) for side in ['l','r']}
   def valid(t):
    return t is not None and float(skin_points(t,visible)[:,1].min())>=-.00009 and all(abs(float(skin_points(t,foot_ids[side])[:,1].min())-sole[side])<sole_tolerance(side,sole[side],f) for side in ['l','r'])
   best=None;initial=sum(hits[p] for p in wanted);lowest=initial
   up=(w['neck_01'].translation-w['pelvis'].translation).normalized();lateral=(w['upperarm_l'].translation-w['upperarm_r'].translation).normalized();forward=lateral.cross(up).normalized()
   shoulder=w
   for side in ['l','r']:
    pair_score=lambda h:sum(count for pair,count in h.items() if 'arm_'+side in pair and 'leg_' in pair)
    score0=pair_score(audit(shoulder));choice=None
    if not score0:continue
    for degrees in [2,4,6,8,10,12,16,20,24,28,32,36,40]:
     for axis_index,axis in enumerate([forward,up,lateral]):
      for sign in [1,-1]:
       t=rotate_clavicle(shoulder,side,sign*degrees,axis)
       if not valid(t):continue
       score=pair_score(audit(t))
       if score<score0:score0=score;choice=t
       if score==0:break
      if score0==0:break
     if score0==0:break
    if choice is not None:shoulder=choice
   shoulder_score=sum(count for pair,count in audit(shoulder).items() if 'arm_' in pair and 'leg_' in pair)
   if shoulder_score<lowest:lowest=shoulder_score;best=(shoulder,{'reason':'anatomical clavicle clearance'})
   if shoulder_score==0:
    corrected[f]=shoulder;changed_any=True;print('CLAVICLE CLEARANCE',f,flush=True);continue

   for angle in [2,4,6,8,10,14,18,22,26,30,35,40]:
    for left,right in [(angle,0),(-angle,0),(0,angle),(0,-angle),(angle,-angle),(-angle,angle)]:
     t=rotate_knee(rotate_knee(w,'l',left),'r',right)
     if not valid(t):continue
     remaining=audit(t)
     if 'leg_l / leg_r' in remaining:continue
     score=sum(count for pair,count in remaining.items() if 'arm_' in pair and 'leg_' in pair)
     if score<lowest:lowest=score;best=(t,{'leftKneePoleDegrees':left,'rightKneePoleDegrees':right,'reason':'folded-pose arm/leg clearance'})
     if score==0:break
    if lowest==0:break
   if best:
    corrected[f]=best[0];leg_specs[f]=best[1];changed_any=True;print('FOLDED LEG CLEARANCE',f,best[1],lowest,flush=True)
  if not changed_any:raise arm_error
  # Smooth the scapular/shoulder correction in torso coordinates, with a
  # bounded amplitude envelope so isolated shoulder lifts do not pop.
  for side in ['l','r']:
   bone='clavicle_'+side;vectors=[]
   for old,new in zip(original,corrected):
    torso=old['spine_03'].to_quaternion();q=torso.inverted()@(new[bone].to_quaternion()@old[bone].to_quaternion().inverted())@torso
    if q.w<0:q.negate()
    vectors.append(np.array(q.axis)*q.angle)
   for i in range(len(corrected)):
    average=np.mean(vectors[max(0,i-3):min(len(vectors),i+4)],axis=0);length=np.linalg.norm(average)
    if length<1e-7:continue
    amplitude=max(max(0.,float(np.linalg.norm(v))-math.radians(3)*abs(i-j)) for j,v in enumerate(vectors));local_q=Quaternion(Vector(average/length),amplitude);torso=original[i]['spine_03'].to_quaternion();q=torso@local_q@torso.inverted();pivot=original[i][bone].translation
    trial={n:m.copy() for n,m in corrected[i].items()}
    for n in names:
     a=n
     while a and a!=bone:a=parent[a]
     if a==bone:
      p,r,scale=original[i][n].decompose();trial[n]=Matrix.LocRotScale(pivot+q@(p-pivot),q@r,scale)
    if float(skin_points(trial,visible)[:,1].min())>=-.00009 and sum(v for pair,v in audit(trial).items() if 'arm_'+side in pair and 'leg_' in pair)<=sum(v for pair,v in audit(corrected[i]).items() if 'arm_'+side in pair and 'leg_' in pair):corrected[i]=trial
  corrected=smooth_leg_poles(corrected,leg_specs)
  corrected,arm_report=collision.clear_arms(corrected,names,parent,skin_points,model)
 arm_report['temporalLegSmoothing']='Consistent knee direction with a three-degree-per-frame pole envelope, constrained by floor and leg clearance'
 arm_report['before']=before;arm_report['legAdjustments']=leg_specs;arm_report['version']=4
 frames=[]
 for i,(old,new) in enumerate(zip(original,corrected)):
  qs={};offsets={}
  for n in names:
   q=new[n].to_quaternion()@old[n].to_quaternion().inverted();qs[n]=[q.x,q.y,q.z,q.w];offsets[n]=list(new[n].translation-old[n].translation)
  frames.append({'frame':i,'worldBoneCorrections':qs,'worldPositionOffsets':offsets,'worldShoulderCorrections':{s:qs['upperarm_'+s] for s in ['l','r']}})
 arm_report['frames']=frames
 return corrected,arm_report
