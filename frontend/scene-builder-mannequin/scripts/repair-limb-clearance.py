"""Repeatable postprocess of a bound export; preserves its accepted leg/floor solve.
Blender: comparison.blend --python this.py -- export-directory
"""
import bpy,sys,json,math,importlib.util,hashlib,os
from pathlib import Path
import numpy as np
from mathutils import Matrix,Vector,Quaternion
out=Path(sys.argv[sys.argv.index('--')+1]);model=json.loads((out/'model.json').read_text());names=[b['name'] for b in model['bones']];parents={b['name']:b['parent'] for b in model['bones']}
entry=json.loads((out/'manifest.json').read_text())[0];id=entry['id'];clip=json.loads((out/(id+'-frames.json')).read_text())
previous=json.loads((out/'limb-clearance.json').read_text()) if (out/'limb-clearance.json').exists() else None
if previous and previous.get('clipSHA256')!=hashlib.sha256((out/(id+'-frames.json')).read_bytes()).hexdigest():previous=None
spec=importlib.util.spec_from_file_location('collision',Path(__file__).with_name('limb-collision.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
C=Matrix.Rotation(-math.pi/2,4,'X');Ci=C.inverted()
rig=next(o for o in bpy.data.objects if o.type=='ARMATURE' and o.name!='Armature' and all(n in o.data.bones for n in names))
body=next(o for o in bpy.data.objects if o.type=='MESH' and o.parent==rig)
rest={}
for b in model['bones']:
 q=b['quaternion'];local=Matrix.LocRotScale(Vector(b['position']),Quaternion((q[3],*q[:3])),Vector(b['scale']));rest[b['name']]=rest[b['parent']]@local if b['parent'] else local
neutral=np.column_stack([np.asarray(model['vertices']).reshape(-1,3),np.ones(len(model['vertices'])//3)]);si=np.array(model['skinIndices']).reshape(-1,4);sw=np.array(model['skinWeights']).reshape(-1,4)
def skin(world,ids):
 matrices=np.array([world[n]@rest[n].inverted() for n in names]);return sum(np.einsum('nij,nj->ni',matrices[si[ids,i]],neutral[ids])*sw[ids,i,None] for i in range(4))[:,:3]
original=[]
for f in clip['frames']:
 world={}
 for n in names:
  b=f['bones'][n];q=b['quaternion'];local=Matrix.LocRotScale(Vector(b['position']),Quaternion((q[3],*q[:3])),Vector(b['scale']));world[n]=world[parents[n]]@local if parents[n] else local
 original.append(world)
if os.environ.get('UAL_REBASE_LIMBS')=='1' and previous:
 for i,world in enumerate(original):
  sample=previous['frames'][i];current={n:m.copy() for n,m in world.items()};qmap=sample.get('worldBoneCorrections',{});offsets=sample.get('worldPositionOffsets',{})
  for n in names:
   p,q,s=current[n].decompose();old=qmap.get(n,[0,0,0,1]);q=Quaternion((old[3],*old[:3])).inverted()@q;p-=Vector(offsets.get(n,[0,0,0]));world[n]=Matrix.LocRotScale(p,q,s)
  for side in ['l','r']:
   bone='upperarm_'+side;chain=[]
   for n in names:
    ancestor=n
    while ancestor and ancestor!=bone:ancestor=parents[ancestor]
    if ancestor:chain.append(n)
   missing_offsets=all(Vector(offsets.get(n,[0,0,0])).length<1e-8 for n in chain)
   old=qmap.get(bone,sample['worldShoulderCorrections'][side]);delta=Quaternion((old[3],*old[:3]))
   if not qmap or (missing_offsets and abs(delta.angle)>.0001):
    pivot=current[bone].translation;inverse=delta.inverted()
    for n in chain:
     p,q,s=current[n].decompose();world[n]=Matrix.LocRotScale(pivot+inverse@(p-pivot),inverse@q,s)
 previous=None
if os.environ.get('UAL_TRAJECTORY_REFINE')=='1':
 spec3=importlib.util.spec_from_file_location('trajectory',Path(__file__).with_name('limb-trajectory.py'));trajectory=importlib.util.module_from_spec(spec3);spec3.loader.exec_module(trajectory)
 fit_data=json.loads((out/'fit-report.json').read_text());contact_mask={s:[any(interval['start']<=f['frame']<=interval['end'] for interval in fit_data.get('contacts',{}).get(s,[])) for f in clip['frames']] for s in ['l','r']}
 # Evaluate the retained original source rig, including its constraints.
 source_rig=next(o for o in bpy.data.objects if o.type=='ARMATURE' and o!=rig and all(n in o.data.bones for n in names));source_hidden=source_rig.hide_get();source_rig.hide_set(False)
 source_rig.animation_data.action=bpy.data.actions['A_TPose'];bpy.context.scene.frame_set(0);bpy.context.view_layer.update();source_baseline={b.name:b.matrix_basis.copy() for b in source_rig.pose.bones};source_frames=[]
 for f in clip['frames']:
  source_rig.animation_data.action=None
  for n,m in source_baseline.items():source_rig.pose.bones[n].matrix_basis=m.copy()
  action=bpy.data.actions[fit_data['action']];source_rig.animation_data.action=action
  if action.slots:source_rig.animation_data.action_slot=action.slots[0]
  bpy.context.scene.frame_set(f['frame']);bpy.context.view_layer.update();ev=source_rig.evaluated_get(bpy.context.evaluated_depsgraph_get());source_frames.append({n:C@(ev.matrix_world@ev.pose.bones[n].matrix)@Ci for n in names})
 source_rig.hide_set(source_hidden)
 (out/'motion-source.json').write_text(json.dumps({'source':fit_data['source'],'sourceSHA256':fit_data['sourceSHA256'],'frames':[{'frame':f['frame'],'boneWorld':{n:[v for row in w[n] for v in row] for n in names}} for f,w in zip(clip['frames'],source_frames)]}))
 worlds,report=trajectory.refine(original,names,parents,skin,model,c,previous,contact_mask,source_frames)
elif os.environ.get('UAL_GENERAL_LIMBS','1')=='1':
 spec2=importlib.util.spec_from_file_location('general',Path(__file__).with_name('limb-general.py'));general=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(general)
 fit_data=json.loads((out/'fit-report.json').read_text());contact_mask={s:[any(interval['start']<=f['frame']<=interval['end'] for interval in fit_data.get('contacts',{}).get(s,[])) for f in clip['frames']] for s in ['l','r']}
 worlds,report=general.clear_limbs(original,names,parents,skin,model,c,contact_mask)
else:worlds,report=c.clear_arms(original,names,parents,skin,model)
solver_frames=report.get('frames',[]);report['frames']=[];vertices=[];matrices=[]
def tr(m):
 p,q,s=m.decompose();return {'position':list(p),'quaternion':[q.x,q.y,q.z,q.w],'scale':list(s)}
rig.animation_data_clear();rig.animation_data_create()
for index,(f,world) in enumerate(zip(clip['frames'],worlds)):
 bpy.context.scene.frame_set(f['frame']);adjustments={}
 for side in ['l','r']:
  n='upperarm_'+side;q=world[n].to_quaternion()@original[index][n].to_quaternion().inverted()
  if previous:
   old=previous['frames'][index]['worldShoulderCorrections'][side];q=q@Quaternion((old[3],*old[:3]))
  adjustments[side]=[q.x,q.y,q.z,q.w]
 for n in names:
  p=parents[n];local=world[p].inverted()@world[n] if p else world[n];rest_local=rig.data.bones[p].matrix_local.inverted()@rig.data.bones[n].matrix_local if p else rig.data.bones[n].matrix_local
  b=rig.pose.bones[n];b.rotation_mode='QUATERNION';b.matrix_basis=rest_local.inverted()@(Ci@local@C)
  for prop in ['location','rotation_quaternion','scale']:b.keyframe_insert(prop,frame=f['frame'],group=n)
 bpy.context.view_layer.update();ev=rig.evaluated_get(bpy.context.evaluated_depsgraph_get());actual={n:C@(ev.matrix_world@ev.pose.bones[n].matrix)@Ci for n in names}
 f['bones']={n:tr(actual[parents[n]].inverted()@actual[n] if parents[n] else actual[n]) for n in names}
 mesh=body.evaluated_get(bpy.context.evaluated_depsgraph_get());em=mesh.to_mesh();points=[C@(mesh.matrix_world@v.co) for v in em.vertices];vertices.extend(x for v in points for x in v);mesh.to_mesh_clear()
 minimum=min(points[i].y for i in set(model['indices']))
 if minimum<-.0001:raise ValueError('Limb correction penetrates floor')
 for n in names:matrices.extend(x for row in actual[n] for x in row)
 sample={'frame':f['frame'],'worldShoulderCorrections':adjustments,'minimumVisibleY':minimum}
 qs={};offsets={}
 for n in names:
  q=world[n].to_quaternion()@original[index][n].to_quaternion().inverted();delta=world[n].translation-original[index][n].translation
  if previous:
   prior=previous['frames'][index];old_q=prior.get('worldBoneCorrections',{}).get(n)
   if old_q is None:
    for side in ['l','r']:
     ancestor=n
     while ancestor and ancestor!='upperarm_'+side:ancestor=parents[ancestor]
     if ancestor:old_q=prior['worldShoulderCorrections'][side]
   if old_q:q=q@Quaternion((old_q[3],*old_q[:3]))
   delta+=Vector(prior.get('worldPositionOffsets',{}).get(n,[0,0,0]))
  qs[n]=[q.x,q.y,q.z,q.w];offsets[n]=list(delta)
 sample['worldBoneCorrections']=qs;sample['worldPositionOffsets']=offsets
 report['frames'].append(sample)
(out/(id+'-frames.json')).write_text(json.dumps(clip,separators=(',',':')))
selected=json.loads((out/(id+'.json')).read_text());selected['bones']=clip['frames'][selected.get('frame',entry['frame'])-clip['start']]['bones'];(out/(id+'.json')).write_text(json.dumps(selected,separators=(',',':')))
(out/'blender-vertices.f32').write_bytes(np.asarray(vertices,dtype='<f4').tobytes());(out/'blender-world.f64').write_bytes(np.asarray(matrices,dtype='<f8').tobytes())
report['clipSHA256']=hashlib.sha256((out/(id+'-frames.json')).read_bytes()).hexdigest()
(out/'limb-clearance.json').write_text(json.dumps(report,indent=2));fit=json.loads((out/'fit-report.json').read_text());fit['limbClearance']=report;(out/'fit-report.json').write_text(json.dumps(fit,indent=2))
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);body.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(out/'makehuman-ual.glb'),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='ACTIVE_ACTIONS',export_frame_range=True,export_force_sampling=True,export_optimize_animation_size=False,export_skins=True,export_yup=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'comparison.blend'))
print(json.dumps({'angles':report['shoulderAdjustments'],'frames':len(worlds),'intersectionsAfter':sum(bool(h) for h in report['after'])}))
