"""Blender exporter: anatomical fit, complete deform skeleton, evaluated action.
Invoke through export-ual-fit.mjs. Coordinates in runtime files: X right, Y up,
Z forward, metres. Blender files use the equivalent Z-up coordinates.
"""
import bpy, json, sys, math, hashlib, struct, os
from urllib.parse import quote
from pathlib import Path
from mathutils import Vector, Matrix, Quaternion
import numpy as np
import importlib.util
exporter_sha=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
_collision_spec=importlib.util.spec_from_file_location("limb_collision",Path(__file__).with_name("limb-collision.py"))
_collision=importlib.util.module_from_spec(_collision_spec);_collision_spec.loader.exec_module(_collision)
input_path, action_name, output=sys.argv[sys.argv.index('--')+1:]
out=Path(output);out.mkdir(parents=True,exist_ok=True)
d=json.loads(Path(input_path).read_text());scene=bpy.context.scene
source=next(o for o in scene.objects if o.type=='ARMATURE')
source_mesh=bpy.data.objects['Mannequin'];action=bpy.data.actions.get(action_name)
if action is None:raise ValueError('Source action not found: '+action_name)
source_path=bpy.data.filepath
C=Matrix.Rotation(-math.pi/2,4,'X');Ci=C.inverted()
names=[b.name for b in source.data.bones if b.use_deform]
if len(names)!=65:raise ValueError('Expected full 65-bone UAL deform skeleton')
V=np.asarray(d['vertices'],dtype=np.float64).reshape(-1,3)
rendered_ids=np.unique(np.asarray(d['indices'],dtype=np.int64))
height=float(np.ptp(V[rendered_ids,1]));unit=1.7/height
origin=float(V[rendered_ids,1].min());V=V*unit;V[:,1]-=origin*unit
# Quantize once to the exact vertex buffer used by the browser and Blender.
quantized=V.astype(np.float32).astype(np.float64)
neutral_quantization=float(np.linalg.norm(quantized-V,axis=1).max())
V=quantized
old={b['name']:b for b in d['bones']}
def norm(p):
 p=Vector(p)*unit;p.y-=origin*unit;return p
alias=lambda n:'Root' if n=='root' else 'head' if n=='Head' else n
heads={};tails={};fit_rows=[]
for n in names:
 key=alias(n)
 if key in old:
  heads[n]=norm(old[key]['headPos']);tails[n]=norm(old[key]['tailPos'])
 elif '_04_leaf_' in n or n.startswith('ball_leaf_'):
  parent=source.data.bones[n].parent.name
  heads[n]=tails[parent].copy()
  direction=(tails[parent]-heads[parent]).normalized()
  # Terminal joints end at the weighted skin's distal extent, not an arbitrary
  # fixed source leaf length. Parent weights identify the anatomical region.
  idx=list(old).index(alias(parent));si=np.asarray(d['skinIndices']).reshape(-1,4);sw=np.asarray(d['skinWeights']).reshape(-1,4)
  mask=((si==idx)&(sw>.1)).any(axis=1)
  projections=[(Vector(v)-heads[n]).dot(direction) for v in V[mask]]
  extent=max(projections,default=.001)
  tails[n]=heads[n]+direction*max(.001,min(extent,source.data.bones[n].length*unit*height/1.8))
 else:raise ValueError('No anatomical correspondence: '+n)
# The UAL root defines world travel, not a body segment. Preserve its source
# frame rather than copying MakeHuman's arbitrary, reversed root marker.
heads['root']=Vector((0,0,0))
root_direction=(C.to_3x3()@(source.data.bones['root'].tail_local-source.data.bones['root'].head_local)).normalized()
tails['root']=heads['root']+root_direction*.1
# Exact neutral symmetry; existing landmarks already have bilateral symmetry.
for n in names:
 if n.endswith('_l'):
  r=n[:-2]+'_r'
  if r in heads:
   for points in (heads,tails):
    a,b=points[n],points[r];p=Vector(((abs(a.x)+abs(b.x))/2,(a.y+b.y)/2,(a.z+b.z)/2));points[n]=p;points[r]=Vector((-p.x,p.y,p.z))
# Shared anatomical joints use a single position. Disconnected clavicles/finger
# roots retain the measured offsets, as in the UAL hierarchy.
for n in names:
 children=[b.name for b in source.data.bones[n].children if b.name in heads]
 connected=[c for c in children if (source.data.bones[n].tail_local-source.data.bones[c].head_local).length<1e-5]
 if len(connected)==1:tails[n]=heads[connected[0]].copy()
# Cross-sections are measured in each joint's skin-weighted anatomical region.
# Refine a landmark only when it lies outside that region's measured bounds.
si=np.asarray(d['skinIndices']).reshape(-1,4);sw=np.asarray(d['skinWeights']).reshape(-1,4)
for n in names:
 key=alias(n);section=None;shift=0.
 if key in old and n!='root':
  idx=list(old).index(key);mask=((si==idx)&(sw>.05)).any(axis=1);region=V[mask]
  if len(region):
   axis=(tails[n]-heads[n]).normalized();dist=(region-np.array(heads[n]))@np.array(axis)
   slab=region[np.abs(dist)<max(.008,(tails[n]-heads[n]).length*.12)]
   if len(slab):
    lo=slab.min(axis=0);hi=slab.max(axis=0)
    section={'vertices':len(slab),'min':lo.tolist(),'max':hi.tolist()}
 # Existing volume-derived joint landmarks are kept rather than surface-centred:
 # elbow/knee pivots intentionally do not coincide with skin centroids.
 fit_rows.append({'bone':n,'landmark':key if key in old else 'distal skin extent','head':list(heads[n]),'tail':list(tails[n]),'crossSection':section,'refinementMetres':shift})
binding_path=out/'binding.json'
input_hash=hashlib.sha256(Path(input_path).read_bytes()).hexdigest()
rest_hash=hashlib.sha256(json.dumps({n:[list(source.data.bones[n].head_local),list(source.data.bones[n].tail_local),source.data.bones[n].parent.name if source.data.bones[n].parent else None] for n in names},sort_keys=True).encode()).hexdigest()
if binding_path.exists() and json.loads(binding_path.read_text()).get('version')==2:
 binding=json.loads(binding_path.read_text())
 if binding['inputSHA256']!=input_hash or binding['sourceRestSHA256']!=rest_hash:raise ValueError('Existing binding has different body or source anatomy; choose a new output directory to refit.')
 heads={n:Vector(binding['heads'][n]) for n in names};tails={n:Vector(binding['tails'][n]) for n in names};fit_rows=binding['landmarks']
else:
 binding={'version':2,'normalization':'rendered skin, height 1.7 m, visible soles at y=0','inputSHA256':input_hash,'sourceRestSHA256':rest_hash,'heads':{n:list(heads[n]) for n in names},'tails':{n:list(tails[n]) for n in names},'landmarks':fit_rows}
 binding_path.write_text(json.dumps(binding,indent=2))
# Construct true rest frames, preserving source roll by projecting source Z onto
# each fitted bone's perpendicular plane. Identity mesh/object transforms.
arm=bpy.data.armatures.new('MakeHuman_UAL65');rig=bpy.data.objects.new('MakeHuman UAL skeleton',arm);scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
for n in names:
 b=arm.edit_bones.new(n);b.head=Ci@heads[n];b.tail=Ci@tails[n]
 b.align_roll(source.data.bones[n].matrix_local.to_3x3().col[2])
for n in names:
 p=source.data.bones[n].parent
 if p:
  if p.name not in names:raise ValueError('Non-deform parent requires explicit baking: '+n)
  arm.edit_bones[n].parent=arm.edit_bones[p.name]
  arm.edit_bones[n].use_connect=(arm.edit_bones[n].head-arm.edit_bones[p.name].tail).length<1e-6
bpy.ops.object.mode_set(mode='OBJECT')
for b in rig.pose.bones:b.rotation_mode='QUATERNION'
# Keep source triangulation and UV coordinates exactly, including seam vertices.
mesh=bpy.data.meshes.new('MakeHuman unchanged mesh');mesh.from_pydata([Ci@Vector(v) for v in V],[],np.asarray(d['indices']).reshape(-1,3).tolist());mesh.update()
body=bpy.data.objects.new('MakeHuman',mesh);scene.collection.objects.link(body)
uv=mesh.uv_layers.new(name='UVMap');uvs=np.asarray(d['uvs']).reshape(-1,2)
for loop in mesh.loops:uv.data[loop.index].uv=uvs[loop.vertex_index]
for p in mesh.polygons:p.use_smooth=True
weight_map={b['name']:('root' if b['name']=='Root' else 'Head' if b['name']=='head' else b['name']) for b in d['bones']}
for n in names:body.vertex_groups.new(name=n)
normalized=0;weight_error=0.;unweighted=[]
for i,(indices,weights) in enumerate(zip(si,sw)):
 total=float(sum(weights));weight_error=max(weight_error,abs(total-1))
 if total<=0:unweighted.append(i);continue
 if abs(total-1)>1e-7:normalized+=1
 for j,w in zip(indices,weights):
  if w>0:
   n=weight_map[d['bones'][int(j)]['name']]
   if n not in names:raise ValueError('Unmapped skin influence: '+n)
   body.vertex_groups[n].add([i],float(w/total),'REPLACE')
if unweighted:raise ValueError('Unweighted vertices: '+str(unweighted[:10]))
mod=body.modifiers.new('UAL skin','ARMATURE');mod.object=rig;mod.use_deform_preserve_volume=False
body.parent=rig
mat=bpy.data.materials.new('MakeHuman original skin');mat.use_nodes=True
texture=Path(__file__).resolve().parents[1]/'src/rig/vendor/textures/skin_dummy.png'
tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(texture));tex.image.pack()
mat.node_tree.links.new(tex.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.85
body.data.materials.append(mat)
# Neutral rest model. Rest-local matrices include the actual fitted bone axes.
def tr(m):
 p,q,s=m.decompose();return {'position':list(p),'quaternion':[q.x,q.y,q.z,q.w],'scale':list(s)}
def canon(m):return C@m@Ci
model={'rig':'makehuman-ual65-v2','vertices':V.reshape(-1).tolist(),'indices':d['indices'],'uvs':d['uvs'],'skinIndices':[],'skinWeights':[],'bones':[]}
for n in names:
 b=arm.bones[n];world=canon(b.matrix_local);parent=b.parent
 local=canon(parent.matrix_local).inverted()@world if parent else world
 model['bones'].append({'name':n,'parent':parent.name if parent else None,'headPos':list(heads[n]),'tailPos':list(tails[n]),**tr(local)})
for indices,weights in zip(si,sw):
 model['skinIndices'].extend(names.index(weight_map[d['bones'][int(j)]['name']]) for j in indices)
 model['skinWeights'].extend(float(w/sum(weights)) for w in weights)
(out/'model.json').write_text(json.dumps(model,separators=(',',':')))
# Height and per-segment movement scales, independent of clip choice.
source_height=max(v.co.z for v in source_mesh.data.vertices)-min(v.co.z for v in source_mesh.data.vertices)
root_scale=1.7/source_height
ratios={n:(tails[n]-heads[n]).length/source.data.bones[n].length for n in names}
# Hip lowering is governed by leg length, not the short pelvis bone.
leg_ratio=sum((tails['thigh_'+s]-heads['thigh_'+s]).length+(tails['calf_'+s]-heads['calf_'+s]).length for s in ['l','r'])/sum(source.data.bones['thigh_'+s].length+source.data.bones['calf_'+s].length for s in ['l','r'])
ratios['pelvis']=leg_ratio
# Source motion is evaluated on the original constrained rig, not extracted from
# selected controller curves. A TPose reset prevents stale unkeyed transforms.
source.animation_data_create();source.animation_data.action=bpy.data.actions['A_TPose'];scene.frame_set(0);bpy.context.view_layer.update()
baseline={b.name:b.matrix_basis.copy() for b in source.pose.bones}
source_groups={g.index:g.name for g in source_mesh.vertex_groups}
source_foot_ids={s:[v.index for v in source_mesh.data.vertices if sum(g.weight for g in v.groups if source_groups[g.group] in ['foot_'+s,'ball_'+s,'ball_leaf_'+s])>.5] for s in ['l','r']}
source_soles=[];source_body_min=[];source_toes=[]
source_toe_ids={s:[v.index for v in source_mesh.data.vertices if sum(g.weight for g in v.groups if source_groups[g.group] in ['ball_'+s,'ball_leaf_'+s])>.5] for s in ['l','r']}
source_visible=sorted({i for p in source_mesh.data.polygons for i in p.vertices})
def evaluate(frame):
 source.animation_data.action=None
 for n,m in baseline.items():source.pose.bones[n].matrix_basis=m.copy()
 source.animation_data.action=action
 if action.slots:source.animation_data.action_slot=action.slots[0]
 scene.frame_set(frame);bpy.context.view_layer.update()
 ev=source.evaluated_get(bpy.context.evaluated_depsgraph_get())
 skin=source_mesh.evaluated_get(bpy.context.evaluated_depsgraph_get());em=skin.to_mesh()
 source_soles.append({s:min((C@(skin.matrix_world@em.vertices[j].co)).y for j in ids) for s,ids in source_foot_ids.items()})
 source_toes.append({s:min((C@(skin.matrix_world@em.vertices[j].co)).y for j in ids) for s,ids in source_toe_ids.items()})
 source_body_min.append(min((C@(skin.matrix_world@em.vertices[j].co)).y for j in source_visible))
 skin.to_mesh_clear()
 return {n:canon(ev.matrix_world@ev.pose.bones[n].matrix) for n in names}
start,end=map(int,action.frame_range);source_frames=[evaluate(f) for f in range(start,end+1)]
# Infer support from source data, without action-name exceptions. A sustained
# foot patch near the plane and above-ground pelvis identify floor support.
fps=scene.render.fps/scene.render.fps_base
minimum_source_pelvis=min(frame['pelvis'].translation.y for frame in source_frames)
support_lower=-.10 if minimum_source_pelvis<source_height*.2 else -.03
support_runs={}
for side in ['l','r']:
 values=[v[side] for v in source_soles];run=best=0
 for i,height in enumerate(values):
  lo=max(0,i-1);hi=min(len(values)-1,i+1)
  speed=abs(values[hi]-values[lo])*fps/max(1,hi-lo)
  stable=support_lower<=height<=.002 and speed<=.1
  run=run+1 if stable else 0;best=max(best,run)
 support_runs[side]=best
minimum_source_pelvis=min(frame['pelvis'].translation.y for frame in source_frames)
ground_supported=minimum_source_pelvis>=-.00001 and max(support_runs.values())>=max(3,math.ceil(.08*fps))
floor_policy='ground-support' if ground_supported else 'root-clearance'
support_evidence={'stableFootRuns':support_runs,'lowerContactEnvelope':support_lower,'minimumPelvisHeight':minimum_source_pelvis,'maximumStableVerticalSpeed':.1,'minimumStableSeconds':.08}

# Match source anatomical world directions. The reference for playback is the
# source TPose, distinct from MakeHuman's A-pose skin bind. This avoids doubling
# the arm-lowering angle when transferring between different neutral poses.
rest_source={n:canon(source.matrix_world@source.data.bones[n].matrix_local) for n in names}
rest_target={n:canon(arm.bones[n].matrix_local) for n in names}
local_rest={b['name']:Matrix.LocRotScale(Vector(b['position']),Quaternion((b['quaternion'][3],*b['quaternion'][:3])),Vector(b['scale'])) for b in model['bones']}
# Detect contact from the evaluated source skin against its authored ground plane.
contact={};contacts={s:[] for s in ['l','r']}
fps=scene.render.fps/scene.render.fps_base
source_cycle=len(source_frames)>2 and max(source_frames[0][n].to_quaternion().rotation_difference(source_frames[-1][n].to_quaternion()).angle for n in names)<math.radians(1) and abs(source_frames[0]['pelvis'].translation.y-source_frames[-1]['pelvis'].translation.y)<.002
period=len(source_frames)-1 if source_cycle else len(source_frames)
contact_ceilings={}
for side in contacts:
 values=[sole[side] for sole in source_soles];raw=[]
 stable=[]
 for i in range(period):
  neighbours=[j for j in ([((i-1)%period),((i+1)%period)] if source_cycle else [i-1,i+1]) if 0<=j<period and j!=i]
  speed=min((abs(values[j]-values[i])*fps for j in neighbours),default=0.)
  if support_lower<=values[i]<=.02 and speed<=.1:stable.append(values[i])
 contact_ceilings[side]=max(.002,min(stable,default=0.)+.002)
 for i in range(period):
  neighbours=[j for j in ([((i-1)%period),((i+1)%period)] if source_cycle else [i-1,i+1]) if 0<=j<period and j!=i]
  speed=min((abs(values[j]-values[i])*fps for j in neighbours),default=0.)
  raw.append(ground_supported and support_lower<=values[i]<=contact_ceilings[side] and speed<=.1)
 # Merge brief near-plane gaps inside an otherwise stable contact run.
 for i in range(period):
  if raw[i]:continue
  left=i-1;right=i+1
  if source_cycle:left%=period;right%=period
  for unused in range(2):
   if 0<=right<period and not raw[right]:right=(right+1)%period if source_cycle else right+1
  gap=(right-left-1)%period if source_cycle else right-left-1
  if 0<=left<period and 0<=right<period and raw[left] and raw[right] and gap<=2:
   indices=[(left+offset)%period if source_cycle else left+offset for offset in range(1,gap+1)]
   if all(support_lower<=values[j]<=.01 for j in indices):
    for j in indices:raw[j]=True
 mask=raw[:]
 for i,value in enumerate(raw):
  if not value:continue
  if source_cycle:
   count=1
   for direction in [-1,1]:
    for offset in range(1,period):
     if not raw[(i+direction*offset)%period]:break
     count+=1
   count=min(period,count)
  else:
   lo=i;hi=i
   while lo>0 and raw[lo-1]:lo-=1
   while hi+1<period and raw[hi+1]:hi+=1
   count=hi-lo+1
  if count<max(3,math.ceil(.08*fps)):mask[i]=False
 if source_cycle:mask.append(mask[0])
 for i,is_contact in enumerate(mask):
  if is_contact and (i==0 or not mask[i-1]):contacts[side].append({'start':start+i,'end':start+i})
  elif is_contact:contacts[side][-1]['end']=start+i
 contact[side]=mask
contact_influence={}
for side in ['l','r']:
 indices=[i for i,v in enumerate(contact[side]) if v];values=[]
 for i in range(len(source_frames)):
  values.append(1. if contact[side][i] else 0.)
 contact_influence[side]=values
# Sole contact is measured on the actual bound skin, not merely the ankle or
# forefoot joint. Different foot thicknesses otherwise leave the skin floating.
neutral4=np.column_stack([V,np.ones(len(V))])
skin_index=np.asarray(model['skinIndices']).reshape(-1,4)
skin_weight=np.asarray(model['skinWeights']).reshape(-1,4)
visible_vertices=np.unique(np.asarray(d['indices'],dtype=np.int64))
sole_vertices={};toe_vertices={}
for side in ['l','r']:
 indices=[names.index(n) for n in ['foot_'+side,'ball_'+side,'ball_leaf_'+side]]
 sole_vertices[side]=np.intersect1d(visible_vertices,np.flatnonzero(np.where(np.isin(skin_index,indices),skin_weight,0).sum(axis=1)>.5))
 toe_vertices[side]=np.intersect1d(visible_vertices,np.flatnonzero(np.where(np.isin(skin_index,[names.index('ball_'+side),names.index('ball_leaf_'+side)]),skin_weight,0).sum(axis=1)>.5))
body_vertices=np.setdiff1d(visible_vertices,np.union1d(sole_vertices['l'],sole_vertices['r']))
def skin_points(world,ids):
 skin=np.asarray([world[n]@rest_target[n].inverted() for n in names])
 positions=np.zeros((len(ids),4))
 for influence in range(4):
  positions+=np.einsum('nij,nj->ni',skin[skin_index[ids,influence]],neutral4[ids])*skin_weight[ids,influence,None]
 return positions[:,:3]
def sole_height(world,side):return float(skin_points(world,sole_vertices[side])[:,1].min())
frames=[];corrections=[];vertex_buffer=[];world_buffer=[];source_metrics=[];solved_worlds=[]
# Analytic two-bone position correction: retains knee pole and foot orientation.
def solve_leg(world,side,target):
 a,b,c=['thigh_'+side,'calf_'+side,'foot_'+side]
 A,B,E=[world[n].translation.copy() for n in [a,b,c]]
 if (target-E).length<1e-7:return 0.
 l1=(B-A).length;l2=(E-B).length;delta=target-A;distance=delta.length
 if distance<1e-8:return 0.
 if distance>l1+l2+.0001 or distance<abs(l1-l2)-.0001:raise ValueError('Unreachable foot correction at frame '+str(scene.frame_current)+' side '+side+'; distance='+str(distance)+' lengths='+str((l1,l2))+' hip='+str(tuple(A))+' target='+str(tuple(target))+'; requires anatomical retarget review')
 axis=delta.normalized();distance=max(abs(l1-l2)+1e-6,min(distance,l1+l2-1e-6))
 pole=axis.cross(world[b].to_quaternion()@knee_hinges[side])
 if pole.length<1e-6:pole=Vector((0,0,1))-axis*axis.z
 pole.normalize();along=(l1*l1+distance*distance-l2*l2)/(2*distance);knee=A+axis*along+pole*math.sqrt(max(0,l1*l1-along*along))
 q1=(B-A).rotation_difference(knee-A);q2=(E-B).rotation_difference(target-knee)
 for n,q,pos in [(a,q1,A),(b,q2,knee)]:
  _,oldq,scale=world[n].decompose();world[n]=Matrix.LocRotScale(pos,q@oldq,scale)
 shift=target-E
 for n in [c,'ball_'+side,'ball_leaf_'+side]:world[n].translation+=shift
 return shift.length
def rotate_toes(world,side,angle):rotate_contact_joint(world,side,'ball',angle)
def rotate_contact_joint(world,side,joint,angle):
 # Derive flexion from the posed anatomical segment, independent of bone roll.
 # Projecting against the ground normal supplies the contact-correction axis.
 bone=joint+'_'+side;child=('ball_leaf' if joint=='ball' else 'ball')+'_'+side
 origin=world[bone].translation.copy();forward=world[child].translation-origin
 axis=Vector((0,1,0)).cross(forward)
 if axis.length<1e-8:raise ValueError('Vertical foot segment has no stable contact flexion axis')
 axis.normalize()
 q=Quaternion(axis,angle)
 chain=['ball_'+side,'ball_leaf_'+side]
 if joint=='foot':chain.insert(0,bone)
 for n in chain:
  p,r,scale=world[n].decompose();world[n]=Matrix.LocRotScale(origin+q@(p-origin),q@r,scale)
def contact_angles(world,side):
 # Search bounded anatomical hinges against the actual skin, rather than taking
 # an unbounded Newton step when the lowest toe vertex reaches a hinge pivot.
 def candidate(td,ad):
  trial={n:m.copy() for n,m in world.items()}
  rotate_contact_joint(trial,side,'foot',math.radians(ad))
  rotate_contact_joint(trial,side,'ball',math.radians(td))
  gap=float(skin_points(trial,toe_vertices[side])[:,1].min())-sole_height(trial,side)
  return gap,trial
 for joint in ['ball','foot']:
  for degrees in sorted(range(-20,21),key=abs):
   td,ad=(degrees,0) if joint=='ball' else (0,degrees)
   gap,trial=candidate(td,ad)
   if gap<=.000003:return td,ad,trial
 choices=[]
 for td in range(-20,21,2):
  for ad in range(-20,21,2):
   gap,trial=candidate(td,ad)
   if gap<=.000003:choices.append((td*td+ad*ad,td,ad,trial))
 if not choices:raise ValueError('No bounded ankle/forefoot contact solution at frame '+str(scene.frame_current)+' side '+side)
 _,td,ad,trial=min(choices,key=lambda x:x[0]);return td,ad,trial
def pelvis_for_feet(base,goals):
 # The pelvis shift must lie inside BOTH leg-reach spheres. Find the closest
 # point to zero in their intersection, rather than stretching either leg or
 # independently moving the body for each foot. Closed form, no solver ordering.
 centers=[];radii=[]
 for side in goals:
  hip,knee,ankle=[base[n+'_'+side].translation for n in ['thigh','calf','foot']]
  centers.append(goals[side]-hip)
  radii.append((knee-hip).length+(ankle-knee).length-1e-6)
 def inside(point):return all((point-c).length<=r+1e-7 for c,r in zip(centers,radii))
 zero=Vector((0,0,0))
 if inside(zero):return zero
 if len(centers)==1:
  center=centers[0]
  return center-center.normalized()*radii[0]
 candidates=[]
 for center,radius in zip(centers,radii):
  point=center-center.normalized()*radius if center.length>radius else zero.copy()
  if inside(point):candidates.append(point)
 if candidates:return min(candidates,key=lambda p:p.length_squared)
 a,b=centers;r1,r2=radii;delta=b-a;distance=delta.length
 if distance>r1+r2+1e-6:raise ValueError('Foot targets have disjoint leg-reach spheres at frame '+str(scene.frame_current))
 if distance<1e-8:raise ValueError('Degenerate pelvis reach intersection')
 axis=delta/distance;along=(r1*r1-r2*r2+distance*distance)/(2*distance)
 center=a+axis*along;radius=math.sqrt(max(0.,r1*r1-along*along))
 radial=center-axis*center.dot(axis)
 if radial.length<1e-8:radial=Vector((0,1,0))-axis*axis.y
 radial.normalize()
 return center-radial*radius
def preferred_pelvis_for_feet(base,goals):
 # Preserve the authored knee bend: hip-to-ankle distances come from the
 # anatomically proportioned source pose, rather than maximum leg extension.
 if not goals:return Vector((0,0,0))
 wanted=sum((goals[s]-base['foot_'+s].translation for s in goals),Vector((0,0,0)))/len(goals)
 centers=[goals[s]-base['thigh_'+s].translation-wanted for s in goals]
 radii=[(base['foot_'+s].translation-base['thigh_'+s].translation).length for s in goals]
 if len(goals)==1:
  center=centers[0]
  return wanted+center-center.normalized()*radii[0] if center.length>1e-8 else wanted+Vector((0,radii[0],0))
 a,b=centers;r1,r2=radii;delta=b-a;distance=delta.length
 if distance<1e-7 or distance>r1+r2 or distance<abs(r1-r2):return pelvis_for_feet(base,goals)
 axis=delta/distance;along=(r1*r1-r2*r2+distance*distance)/(2*distance);center=a+axis*along;radius=math.sqrt(max(0.,r1*r1-along*along));radial=center-axis*center.dot(axis)
 if radial.length<1e-8:radial=Vector((0,1,0))-axis*axis.y
 radial.normalize();return wanted+center-radial*radius
def retarget_pose(src):
 world={}
 for n in names:
  p=source.data.bones[n].parent;p=p.name if p else None
  src_local=src[p].inverted()@src[n] if p else src[n]
  src_rest_local=rest_source[p].inverted()@rest_source[n] if p else rest_source[n]
  delta=src_local.translation-src_rest_local.translation
  if p:
   # Local translation axes differ between fitted A-pose and source TPose.
   # Express offsets in source rest-parent coordinates, then in fitted rest.
   shift=rest_source[p].to_quaternion()@delta*ratios[n]
   shift=rest_target[p].to_quaternion().inverted()@shift
   position=world[p]@(local_rest[n].translation+shift)
  else:position=rest_target[n].translation+delta*root_scale
  # Preserve source world orientation/scale; the bound mesh supplies the fitted
  # resting frame, with full 65-joint articulation and no Euler conversion.
  _,rotation,scale=src[n].decompose();world[n]=Matrix.LocRotScale(position,rotation,scale)
 return world
base_frames=[retarget_pose(src) for src in source_frames]
raw_base_frames=[{n:m.copy() for n,m in w.items()} for w in base_frames]
anatomical_hips={}
leg_groups=_collision.limb_faces(model);all_vertex_ids=np.arange(len(V))
def crossed_legs(world):return 'leg_l / leg_r' in _collision.intersections(skin_points(world,all_vertex_ids),leg_groups)
if any(crossed_legs(w) for w in base_frames) or os.environ.get('UAL_FORCE_HIP_TRACK')=='1':
 first=base_frames[0];lateral=first['thigh_l'].translation-first['thigh_r'].translation;up=first['spine_03'].translation-first['pelvis'].translation
 forward=lateral.cross(up).normalized();lateral.normalize();parent_inverse=first['pelvis'].to_quaternion().inverted()
 hip_axes=[parent_inverse@axis.normalized() for axis in [forward,lateral,forward+lateral,forward-lateral]]
 hip_axis=hip_axes[0]
 def widen_tracks(base,degrees,sign):
  w={n:m.copy() for n,m in base.items()}
  for side,direction in [('l',sign),('r',-sign)]:
   root='thigh_'+side;delta=Quaternion(hip_axis,math.radians(degrees*direction))
   for n in names:
    ancestor=n
    while ancestor and ancestor!=root:
     parent=source.data.bones[ancestor].parent;ancestor=parent.name if parent else None
    if ancestor!=root:continue
    p=source.data.bones[n].parent.name;local=base[p].inverted()@base[n];pos,q,scale=local.decompose()
    if n==root:q=delta@q
    w[n]=w[p]@Matrix.LocRotScale(pos,q,scale)
    if n=='foot_'+side:
     pos=w[n].translation;_,q,scale=base[n].decompose();w[n]=Matrix.LocRotScale(pos,q,scale)
  return w
 for degrees in range(int(os.environ.get('UAL_MIN_HIP_ANGLE','1')),16):
  candidates=[]
  for hip_axis in hip_axes:
   for sign in [1,-1]:
    trial=[]
    for w in raw_base_frames:
     candidate=widen_tracks(w,degrees,sign)
     if crossed_legs(candidate):break
     trial.append(candidate)
    if len(trial)==len(base_frames):
     height_error=max(abs(trial[i]['foot_'+s].translation.y-raw_base_frames[i]['foot_'+s].translation.y) for i in range(len(trial)) for s in ['l','r'])
     candidates.append((height_error,trial,sign,hip_axis.copy()))
  if candidates:
   _,base_frames,sign,hip_axis=min(candidates,key=lambda row:row[0]);anatomical_hips={'leftDegrees':degrees*sign,'rightDegrees':-degrees*sign,'axis':list(hip_axis),'reason':'Minimum anatomical hip correction clearing the fitted skin across all frames; ties minimize foot-height changes'}
  if anatomical_hips:break
 if anatomical_hips:print('ANATOMICAL HIP TRACKS',anatomical_hips,flush=True)
knee_hinges={}
for side in ['l','r']:
 def hinge_sample(world):
  a,b,e=[world[n+'_'+side].translation for n in ['thigh','calf','foot']]
  return (b-a).cross(e-b)
 reference=max(base_frames,key=lambda world:hinge_sample(world).length_squared)
 hinge=hinge_sample(reference)
 if hinge.length<1e-8:hinge=reference['calf_'+side].to_quaternion()@Vector((1,0,0))
 knee_hinges[side]=reference['calf_'+side].to_quaternion().inverted()@hinge.normalized()
clip_floor_min=min(float(skin_points(world,visible_vertices)[:,1].min()) for world in base_frames) if not ground_supported else 0.
clip_floor_lift=-clip_floor_min+.000002 if clip_floor_min<-.00001 else 0.
contact_anchor={}
for side in ['l','r']:
 spans=contacts[side];values=[]
 for i in range(len(source_frames)):
  frame=start+i;span=min(spans,key=lambda r:min(min(abs(frame-v),period-abs(frame-v)) if source_cycle else abs(frame-v) for v in [r['start'],r['end']])) if spans else None
  if span is None:values.append(None);continue
  anchor=(spans[-1]['start'] if source_cycle and len(spans)>1 and span is spans[0] and spans[0]['start']==start and spans[-1]['end']==end else span['start'])-start
  root_delta=source_frames[i]['root'].translation-source_frames[anchor]['root'].translation;relative_delta=(source_frames[i]['foot_'+side].translation-source_frames[i]['root'].translation)-(source_frames[anchor]['foot_'+side].translation-source_frames[anchor]['root'].translation)
  values.append(base_frames[anchor]['foot_'+side].translation+root_delta*root_scale+relative_delta*leg_ratio)
 contact_anchor[side]=values
def knee_bend(world,side):
 a,b,e=[world[n+'_'+side].translation for n in ['thigh','calf','foot']]
 return (b-a).angle(e-b)
def solve_support_frame(i,minimum_lift=0.,airborne_lifts=None,knee_bias=None):
 base=base_frames[i];active=[side for side in ['l','r'] if contact[side][i]];influenced=[side for side in ['l','r'] if contact_influence[side][i]>0.]
 if not ground_supported:
  world={n:m.copy() for n,m in base.items()}
  for n in names:world[n].translation.y+=clip_floor_lift
  return world,{'pelvisCorrection':[0,0,0],'pelvisCorrectionMetres':0.,'pelvisLift':0.,'rootFloorLiftMetres':clip_floor_lift,'constraintIterations':0}, {s:False for s in ['l','r']}, {s:0. for s in ['l','r']},{s:None for s in ['l','r']}
 goals={}
 for side in influenced:
  foot='foot_'+side;ball='ball_'+side;goals[side]=contact_anchor[side][i].copy()
  preview={n:m.copy() for n,m in base.items()};offset=goals[side]-base[foot].translation
  for n in [foot,ball,'ball_leaf_'+side]:preview[n].translation+=offset
  goals[side].y+=(0. if side in active else max(0.,source_soles[i][side]*leg_ratio))-sole_height(preview,side)
 lift=minimum_lift;airborne_clearance={s:(airborne_lifts or {}).get(s,0.) if s not in active else 0. for s in ['l','r']};toe_angles={s:0. for s in ['l','r']};fallback={s:None for s in ['l','r']};toe_contacts={s:s in active and source_toes[i][s]-source_soles[i][s]<=.002 for s in ['l','r']}
 for iteration in range(80):
  preferred=preferred_pelvis_for_feet(base,{s:goals[s] for s in active} if active else goals)*max([0.]+[contact_influence[s][i] for s in influenced]);offset=preferred+Vector((0,lift,0))
  lifted={n:m.copy() for n,m in base.items()}
  for n in names:
   if n!='root':lifted[n].translation+=offset
  shift=offset.copy()
  for reach_iteration in range(128):
   shifted={n:m.copy() for n,m in base.items()}
   for n in names:
    if n!='root':shifted[n].translation+=shift
   # Blend in the fixed anatomical frame. Including preferred pelvis motion
   # here a second time straightens the knee as contact fades out.
   blend_goals={s:base['foot_'+s].translation.lerp(goals[s],contact_influence[s][i])+(shift-preferred)*(1.-contact_influence[s][i]) for s in influenced}
   adjustment=pelvis_for_feet(shifted,blend_goals)
   if adjustment.length<1e-7:break
   shift+=adjustment
  world={n:m.copy() for n,m in base.items()}
  for n in names:
   if n!='root':world[n].translation+=shift
  for side in influenced:
   solve_leg(world,side,blend_goals[side]);uncorrected={n:m.copy() for n,m in world.items()}
   if fallback[side] is not None:
    td,ad=fallback[side];rotate_contact_joint(world,side,'foot',math.radians(ad));rotate_contact_joint(world,side,'ball',math.radians(td))
   else:rotate_toes(world,side,toe_angles[side])
   if toe_contacts[side]:
    toe_min=float(skin_points(world,toe_vertices[side])[:,1].min());trial={n:m.copy() for n,m in world.items()};rotate_toes(trial,side,.001);derivative=(float(skin_points(trial,toe_vertices[side])[:,1].min())-toe_min)/.001
    step=max(-.05,min(.05,-toe_min/derivative)) if abs(derivative)>1e-5 else 0.
    if fallback[side] is not None or abs(derivative)<=1e-5 or abs(toe_angles[side]+step)>math.radians(20):
     if toe_min-sole_height(world,side)>.000003:
      td,ad,world=contact_angles(uncorrected,side);fallback[side]=(td,ad);toe_angles[side]=0.
    else:toe_angles[side]+=step;rotate_toes(world,side,step)
  before_airborne_bend={s:knee_bend(world,s) for s in ['l','r']}
  for side in ['l','r']:
   if side not in active:
    if (knee_bias or {}).get(side,0.)>0:
     a,b,e=[world[n+'_'+side].translation.copy() for n in ['thigh','calf','foot']];l1=(b-a).length;l2=(e-b).length
     angle=min(math.pi-1e-4,knee_bend(world,side)+knee_bias[side]);distance=math.sqrt(max(0.,l1*l1+l2*l2+2*l1*l2*math.cos(angle)))
     solve_leg(world,side,a+(e-a).normalized()*distance)
    if airborne_clearance[side]>0:solve_leg(world,side,world['foot_'+side].translation+Vector((0,airborne_clearance[side],0)))
  errors={s:-sole_height(world,s) for s in active};toe_errors={s:float(skin_points(world,toe_vertices[s])[:,1].min()) for s in active if toe_contacts[s]};minimum=float(skin_points(world,visible_vertices)[:,1].min())
  if max([0.]+[abs(v) for v in errors.values()]+[abs(v) for v in toe_errors.values()])<.000005 and minimum>=-.000005:break
  # Planted soles have their own ankle-height constraint. Raising the pelvis
  # for the same sole error double-corrects it and can snap a straight knee.
  body_minimum=float(skin_points(world,body_vertices)[:,1].min())
  if body_minimum<-.000005:lift+=min(.03,-body_minimum*1.5)
  for side in ['l','r']:
   if side not in active:airborne_clearance[side]+=max(0.,-sole_height(world,side)+.000002)
  for side,error in errors.items():goals[side].y+=error
 else:raise ValueError('Anatomical foot/support constraints did not converge at frame '+str(start+i))
 return world,{'pelvisCorrection':list(shift),'preferredPelvisCorrection':list(preferred),'airborneFloorLifts':airborne_clearance,'airborneKneeBias':{s:max(0.,knee_bend(world,s)-before_airborne_bend[s]) if s not in active else 0. for s in ['l','r']},'pelvisCorrectionMetres':shift.length,'pelvisLift':lift,'rootFloorLiftMetres':0.,'constraintIterations':iteration+1},toe_contacts,toe_angles,fallback
# Solve natural airborne anatomy first, then a bounded root-clearance envelope.
first=[solve_support_frame(i) for i in range(len(source_frames))]
required=[row[1]['pelvisLift'] for row in first]
envelope=[max(0.,max(value-.005*(min(abs(i-j),period-abs(i-j)) if source_cycle else abs(i-j)) for j,value in enumerate(required))) for i in range(len(required))]
knee_envelope={s:[max(0.,max(row[1].get('airborneKneeBias',{}).get(s,0.)-math.radians(3)*(min(abs(i-j),period-abs(i-j)) if source_cycle else abs(i-j)) for j,row in enumerate(first))) for i in range(len(first))] for s in ['l','r']}
floor_transforms=[]
for i,src in enumerate(source_frames):
 scene.frame_set(start+i);world,meta,toe_contacts,toe_angles,fallback=solve_support_frame(i,envelope[i],knee_bias={s:knee_envelope[s][i] for s in ['l','r']});base=base_frames[i]
 row={'frame':start+i,**meta,'groundPolicy':'plane' if ground_supported else 'root-clearance','sourceBodyMinimum':source_body_min[i],'visibleBodyMinimum':float(skin_points(world,visible_vertices)[:,1].min()),'floorPolicy':floor_policy,'feet':{}}
 for side in ['l','r']:
  planted=contact[side][i];weight=contact_influence[side][i];natural=sole_height(base,side)+meta['pelvisCorrection'][1]-(meta.get('preferredPelvisCorrection',[0,0,0])[1] if weight>0 else 0.);expected=(1.-weight)*natural+weight*(0. if planted else max(0.,source_soles[i][side]*leg_ratio))+meta['rootFloorLiftMetres']
  if ground_supported:expected=max(0.,expected)
  if max(abs((world[a+'_'+side].translation-world[b+'_'+side].translation).length-(base[a+'_'+side].translation-base[b+'_'+side].translation).length) for a,b in [('thigh','calf'),('calf','foot')])>.00001:raise ValueError('Leg segment length changed at frame '+str(start+i)+' side '+side)
  row['feet'][side]={'blend':1. if planted else 0.,'contactInfluence':weight,'sourceSole':source_soles[i][side],'expectedClearance':expected,'targetMode':'planted-source-patch' if planted else 'anatomical-airborne-chain','soleAfter':sole_height(world,side),'soleBefore':sole_height(base,side),'toeContact':toe_contacts[side],'sourceToeMinimum':source_toes[i][side],'toeMinimum':float(skin_points(world,toe_vertices[side])[:,1].min()),'toeCorrectionDegrees':math.degrees(toe_angles[side]),'ankleCorrectionDegrees':0. if fallback[side] is None else fallback[side][1],'legLengthErrorMetres':max(abs((world[a+'_'+side].translation-world[b+'_'+side].translation).length-(base[a+'_'+side].translation-base[b+'_'+side].translation).length) for a,b in [('thigh','calf'),('calf','foot')])}
 qs={};offsets={}
 for n in names:
  reference=raw_base_frames[i][n];q=world[n].to_quaternion()@reference.to_quaternion().inverted();qs[n]=[q.x,q.y,q.z,q.w];offsets[n]=list(world[n].translation-reference.translation-Vector((0,meta['rootFloorLiftMetres'],0)))
 floor_transforms.append({'frame':start+i,'worldBoneCorrections':qs,'worldPositionOffsets':offsets});corrections.append(row);solved_worlds.append(world)
parents={n:source.data.bones[n].parent.name if source.data.bones[n].parent else None for n in names}
track_intersections=[start+i for i,w in enumerate(solved_worlds) if crossed_legs(w)]
track_motion={'degrees':0.}
previous_delta={}
for i,world in enumerate(solved_worlds):
 for n in names:
  if not n.startswith(('thigh_','calf_','foot_','ball_')):continue
  p=parents[n];actual=world[p].inverted()@world[n];reference=source_frames[i][p].inverted()@source_frames[i][n]
  delta=(actual.to_quaternion()@reference.to_quaternion().inverted()).normalized()
  if n in previous_delta:
   degrees=math.degrees(2*math.acos(min(1.,abs(delta.dot(previous_delta[n])))))
   if degrees>track_motion['degrees']:track_motion={'degrees':degrees,'frame':start+i,'bone':n}
  previous_delta[n]=delta
next_track_angle=max(int(os.environ.get('UAL_MIN_HIP_ANGLE','0')),abs(anatomical_hips.get('leftDegrees',0)))+1
if (track_intersections or track_motion['degrees']>7.9) and next_track_angle<=15:
 (out/'support-track-retry.json').write_text(json.dumps({'minimumHipDegrees':next_track_angle,'intersectingFrames':track_intersections,'motion':track_motion,'reason':'Fit stance tracks against completed contact, skin clearance and source-relative motion constraints'}))
 raise SystemExit(17)
limb_baseline=[{n:m.copy() for n,m in w.items()} for w in solved_worlds]
(out/'support-solve.json').write_text(json.dumps({'names':names,'parents':parents,'contacts':contact,'frames':[{'boneWorld':{n:[list(row) for row in w[n]] for n in names},'sourceWorld':{n:[list(row) for row in source_frames[i][n]] for n in names},'support':corrections[i]} for i,w in enumerate(solved_worlds)]}))
seed_report={'frames':[],'shoulderAdjustments':{}}
seed=None
if (out/'limb-seed.json').exists():seed=json.loads((out/'limb-seed.json').read_text())
seed_worlds=[]
for i,w in enumerate(solved_worlds):
 world={n:m.copy() for n,m in w.items()};qs={};offsets={}
 for n in names:
  selected=n.startswith(('clavicle_','upperarm_','lowerarm_','hand_','thumb_','index_','middle_','ring_','pinky_'))
  row=seed['frames'][i] if seed and len(seed['frames'])==len(solved_worlds) and selected else None
  value=row.get('worldBoneCorrections',{}).get(n,[0,0,0,1]) if row else [0,0,0,1];offset=row.get('worldPositionOffsets',{}).get(n,[0,0,0]) if row else [0,0,0]
  p,q,scale=w[n].decompose();world[n]=Matrix.LocRotScale(p+Vector(offset),Quaternion((value[3],*value[:3]))@q,scale);qs[n]=value;offsets[n]=offset
 seed_worlds.append(world);seed_report['frames'].append({'worldBoneCorrections':qs,'worldPositionOffsets':offsets,'worldShoulderCorrections':{side:qs['upperarm_'+side] for side in ['l','r']}})
spec=importlib.util.spec_from_file_location('limb_trajectory',Path(__file__).with_name('limb-trajectory.py'));trajectory=importlib.util.module_from_spec(spec);spec.loader.exec_module(trajectory)
solved_worlds,limb_report=trajectory.refine(seed_worlds,names,parents,skin_points,model,_collision,seed_report,contact,source_frames)
limb_report['frames']=[]
for i,(base,world) in enumerate(zip(limb_baseline,solved_worlds)):
 qs={};offsets={}
 for n in names:
  q=world[n].to_quaternion()@base[n].to_quaternion().inverted();qs[n]=[q.x,q.y,q.z,q.w];offsets[n]=list(world[n].translation-base[n].translation)
 limb_report['frames'].append({'frame':i,'worldBoneCorrections':qs,'worldPositionOffsets':offsets,'worldShoulderCorrections':{side:qs['upperarm_'+side] for side in ['l','r']}})
for sample in limb_report['frames']:sample['frame']+=start
(out/'limb-clearance.json').write_text(json.dumps(limb_report,indent=2))
for i,(src,world) in enumerate(zip(source_frames,solved_worlds)):
 scene.frame_set(start+i)
 minimum=float(skin_points(world,visible_vertices)[:,1].min())
 if minimum<-.0001:raise ValueError('Arm clearance introduced floor penetration at frame '+str(start+i))
 corrections[i]['visibleBodyMinimum']=minimum
 bones={}
 for n in names:
  p=arm.bones[n].parent;p=p.name if p else None
  local=world[p].inverted()@world[n] if p else world[n]
  bones[n]=tr(local)
  rest_local=arm.bones[n].parent.matrix_local.inverted()@arm.bones[n].matrix_local if arm.bones[n].parent else arm.bones[n].matrix_local
  rig.pose.bones[n].matrix_basis=rest_local.inverted()@(Ci@local@C)
 bpy.context.view_layer.update()
 actual=rig.evaluated_get(bpy.context.evaluated_depsgraph_get())
 actual_world={n:canon(actual.matrix_world@actual.pose.bones[n].matrix) for n in names}
 # Export the final Blender evaluation, never a separate approximation.
 bones={n:tr(actual_world[arm.bones[n].parent.name].inverted()@actual_world[n] if arm.bones[n].parent else actual_world[n]) for n in names}
 frames.append({'frame':start+i,'bones':bones})
 evaluated=body.evaluated_get(bpy.context.evaluated_depsgraph_get());em=evaluated.to_mesh()
 vertex_buffer.extend(x for v in em.vertices for x in (C@(evaluated.matrix_world@v.co)))
 evaluated.to_mesh_clear()
 for n in names:world_buffer.extend(x for row in actual_world[n] for x in row)
 source_metrics.append({'frame':start+i,'sourcePelvis':list(src['pelvis'].translation),'targetPelvis':list(actual_world['pelvis'].translation),'sourceFeet':{s:list(src['ball_'+s].translation) for s in ['l','r']},'targetFeet':{s:list(actual_world['ball_'+s].translation) for s in ['l','r']}})
 # Bake every fitted bone, including translation and scale.
 for n in names:
  b=rig.pose.bones[n];b.rotation_mode='QUATERNION'
  for prop in ['location','rotation_quaternion','scale']:b.keyframe_insert(prop,frame=start+i,group=n)
clip={'version':1,'rig':model['rig'],'library':1 if 'UAL1' in Path(source_path).name else 2,'action':action_name,'start':start,'end':end,'fps':fps,'frames':frames}
id=f"ual{clip['library']}-{quote(action_name, safe='')}"
(out/f'{id}-frames.json').write_text(json.dumps(clip,separators=(',',':')))
limb_report['clipSHA256']=hashlib.sha256((out/f'{id}-frames.json').read_bytes()).hexdigest()
(out/'motion-source.json').write_text(json.dumps({'source':source_path,'sourceSHA256':hashlib.sha256(Path(source_path).read_bytes()).hexdigest(),'frames':[{'frame':start+i,'boneWorld':{n:[v for row in w[n] for v in row] for n in names}} for i,w in enumerate(source_frames)]}))
(out/'limb-clearance.json').write_text(json.dumps(limb_report,indent=2))
(out/'blender-vertices.f32').write_bytes(np.asarray(vertex_buffer,dtype='<f4').tobytes())
(out/'blender-world.f64').write_bytes(np.asarray(world_buffer,dtype='<f8').tobytes())
report={'sourceContactCeilings':contact_ceilings,'anatomicalHipCorrections':anatomical_hips,'limbClearance':limb_report,'floorSafetyVersion':11,'footStrideScale':leg_ratio,'nearContactSoleScale':leg_ratio,'exporterSHA256':exporter_sha,'fittingVersion':'anatomical-airborne-v11-continuous-v8','cyclicContacts':source_cycle,'floorTransforms':floor_transforms,'airborneFootPolicy':'anatomical-segment-chains','contactBlendFrames':0,'contactPolicy':'surface height, one-sided stable vertical speed, 0.08-second runs, cyclic endpoint continuity','floorReference':{'mode':'fixed-clip-clearance' if not ground_supported else 'planted-support','unshiftedMinimumMetres':clip_floor_min,'rootLiftMetres':clip_floor_lift},'supportEvidence':support_evidence,'floorPolicy':floor_policy,'version':1,'rig':model['rig'],'source':source_path,'sourceSHA256':hashlib.sha256(Path(source_path).read_bytes()).hexdigest(),'inputSHA256':hashlib.sha256(Path(input_path).read_bytes()).hexdigest(),'action':action_name,'start':start,'end':end,'fps':fps,'coordinates':'metres, X right, Y up, Z forward','bones':len(names),'vertices':len(V),'triangles':len(d['indices'])//3,'neutralShapeEdits':0,'maximumNeutralFloat32RoundingMetres':neutral_quantization,'normalization':'rendered skin, height 1.7 m, visible soles at y=0','bindingVersion':2,'originalHeight':height,'targetHeight':1.7,'sourceHeight':source_height,'heightRatio':root_scale,'sourceShoulderWidth':(rest_source['upperarm_l'].translation-rest_source['upperarm_r'].translation).length,'targetShoulderWidth':(heads['upperarm_l']-heads['upperarm_r']).length,'sourceHipWidth':(rest_source['thigh_l'].translation-rest_source['thigh_r'].translation).length,'targetHipWidth':(heads['thigh_l']-heads['thigh_r']).length,'landmarks':fit_rows,'segmentRatios':ratios,'weights':{'correspondence':weight_map,'normalizedVertices':normalized,'maximumOriginalSumError':weight_error,'unweighted':len(unweighted),'redistributedVertices':0,'reason':'Existing anatomical influence correspondence retained; fitted pivots use the original volume-derived landmarks.'},'contacts':contacts,'corrections':corrections,'motion':source_metrics}
(out/'fit-report.json').write_text(json.dumps(report,indent=2))
# Save portable Blender oracle and a standard interchange asset.
scene.frame_start=start;scene.frame_end=end
for o in bpy.context.selected_objects:o.select_set(False)
rig.select_set(True);body.select_set(True);bpy.context.view_layer.objects.active=rig
if rig.animation_data and rig.animation_data.action:rig.animation_data.action.name=action_name+' fitted'
scene.frame_set(start)
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=str(out/'makehuman-ual.glb'),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='ACTIVE_ACTIONS',export_nla_strips_merged_animation_name=action_name,export_frame_range=True,export_force_sampling=True,export_optimize_animation_size=False,export_skins=True,export_yup=True)
# Source and fitted remain at the same origin for exact camera comparisons.
source_mesh.hide_render=True;source.hide_render=True
for obj in bpy.context.view_layer.objects:obj.hide_set(obj not in [rig,body])
scene.frame_set(30 if start<=30<=end else start)
for screen in bpy.data.screens:
 for area in screen.areas:
  if area.type=='VIEW_3D':
   view=area.spaces.active.region_3d;view.view_location=Ci@Vector((0,.75,.7));view.view_distance=2.8;view.view_rotation=Quaternion((1,0,0),math.pi/2);view.view_perspective='ORTHO'
rig.show_in_front=True
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(out/'comparison.blend'))
manifest=[{'fittingVersion':'anatomical-airborne-v11-continuous-v8','rig':model['rig'],'source':source_path,'sourceSHA256':report['sourceSHA256'],'fps':fps,'coordinates':report['coordinates'],'id':id,'library':clip['library'],'name':action_name,'frame':30 if start<=30<=end else start,'range':[start,end],'thumbnail':f'ual-fit/{id}.png','data':f'ual-fit/{id}.json'}]
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
(out/f'{id}.json').write_text(json.dumps({'version':1,'rig':model['rig'],'action':action_name,'frame':manifest[0]['frame'],'bones':frames[manifest[0]['frame']-start]['bones']},separators=(',',':')))
print('UAL_FIT_EXPORTED',json.dumps({'bones':len(names),'frames':len(frames),'vertices':len(V),'contacts':contacts}))
