"""Run with Blender --background UALn.blend --python this.py -- n output.
Evaluates original actions without saving or changing source blend files.
"""
import bpy, json, sys, math
from pathlib import Path
from mathutils import Vector, Matrix, Quaternion
args=sys.argv[sys.argv.index('--')+1:]; library=int(args[0]); out=Path(args[1]);out.mkdir(parents=True,exist_ok=True)
scene=bpy.context.scene
rig=next(o for o in scene.objects if o.type=='ARMATURE')
mesh=next(o for o in scene.objects if o.type=='MESH' and o.name=='Mannequin')
# Canonical coordinates: x right, y up, z toward the viewer.
C=Matrix.Rotation(-math.pi/2,4,'X')
names=[b.name for b in rig.data.bones if b.use_deform]
baseline_basis=None
def evaluate(action, frame):
 rig.animation_data_create();rig.animation_data.action=None
 if baseline_basis:
  for name,matrix in baseline_basis.items():rig.pose.bones[name].matrix_basis=matrix.copy()
 rig.animation_data.action=action
 if hasattr(action,'slots') and action.slots:rig.animation_data.action_slot=action.slots[0]
 scene.frame_set(int(frame),subframe=frame-int(frame));bpy.context.view_layer.update()
 evaluated=rig.evaluated_get(bpy.context.evaluated_depsgraph_get())
 records={}
 for name in names:
  bone=evaluated.pose.bones[name];m=C @ evaluated.matrix_world @ bone.matrix
  records[name]={'position':list(m.translation),'quaternion':list(m.to_quaternion())[1:]+[m.to_quaternion().w],'tail':list(C @ (evaluated.matrix_world @ bone.tail))}
 return records
rest={}
for name in names:
 m=C @ rig.matrix_world @ rig.data.bones[name].matrix_local;q=m.to_quaternion()
 rest[name]={'position':list(m.translation),'quaternion':[q.x,q.y,q.z,q.w]}
reference=evaluate(bpy.data.actions['A_TPose'],0)
baseline_basis={bone.name:bone.matrix_basis.copy() for bone in rig.pose.bones}
(out/f'ual{library}-reference.json').write_text(json.dumps({'rest':rest,'reference':reference}))
for o in scene.objects:o.hide_render=o!=mesh
rig.hide_render=False
scene.render.engine='BLENDER_WORKBENCH';scene.render.resolution_x=256;scene.render.resolution_y=256;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.display.shading.light='STUDIO';scene.display.shading.color_type='SINGLE';scene.display.shading.single_color=(.62,.66,.72)
scene.display.shading.show_shadows=True;scene.display.shading.show_cavity=True;scene.display.shading.background_type='WORLD';scene.world.color=(.055,.06,.075)
camera_data=bpy.data.cameras.new('PoseGalleryCamera');camera=bpy.data.objects.new('PoseGalleryCamera',camera_data);scene.collection.objects.link(camera);scene.camera=camera;camera_data.type='ORTHO'
def render(path):
 deps=bpy.context.evaluated_depsgraph_get();obj=mesh.evaluated_get(deps)
 vertices=[obj.matrix_world @ v.co for v in obj.data.vertices]
 lo=Vector(tuple(min(v[i] for v in vertices) for i in range(3)));hi=Vector(tuple(max(v[i] for v in vertices) for i in range(3)));center=(lo+hi)/2
 # Front, slightly above and to the side; fixed viewing direction across poses.
 direction=Vector((.35,-1,.18)).normalized();camera.location=center+direction*8
 camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
 inv=camera.matrix_world.inverted() if False else camera.rotation_euler.to_matrix().transposed()
 projected=[inv @ (v-center) for v in vertices]
 span=max(max(v.x for v in projected)-min(v.x for v in projected),max(v.y for v in projected)-min(v.y for v in projected))
 camera_data.ortho_scale=span*1.18
 scene.render.filepath=str(path);bpy.ops.render.render(write_still=True)
choices_path=Path(__file__).with_name("pose2-frames.json")
choices=json.loads(choices_path.read_text()) if choices_path.exists() else {}
entries=[]
for action in sorted(bpy.data.actions,key=lambda a:a.name):
 start,end=map(float,action.frame_range);id=f'ual{library}-{action.name}'
 fractions=[.15,.3,.5,.7,.85] if action.name!='A_TPose' else [0]
 candidates=[]
 for index,fraction in enumerate(fractions):
  frame=round(start+(end-start)*fraction);data=evaluate(action,frame)
  # Distinctiveness compared with T-pose, discounting roots and tiny finger bones.
  score=sum(Quaternion((data[n]['quaternion'][3],*data[n]['quaternion'][:3])).rotation_difference(Quaternion((reference[n]['quaternion'][3],*reference[n]['quaternion'][:3]))).angle for n in ['pelvis','spine_03','upperarm_l','upperarm_r','lowerarm_l','lowerarm_r','thigh_l','thigh_r','calf_l','calf_r','Head'])
  candidate={'frame':frame,'score':score,'bones':data};candidates.append(candidate)
  render(out/f'{id}-candidate-{index}.png')
 best=next((c for c in candidates if c['frame']==choices.get(id)),max(candidates,key=lambda c:c['score']))
 (out/f'{id}.json').write_text(json.dumps({'version':1,'library':library,'action':action.name,'frame':best['frame'],'range':[start,end],'bones':best['bones']}))
 selected=next(i for i,c in enumerate(candidates) if c is best)
 import shutil;shutil.copyfile(out/f'{id}-candidate-{selected}.png',out/f'{id}.png')
 entries.append({'id':id,'library':library,'name':action.name,'frame':best['frame'],'range':[start,end],'candidateFrames':[c['frame'] for c in candidates],'selectedCandidate':selected,'thumbnail':f'poses2/{id}.png','data':f'poses2/{id}.json'})
 print('POSE_EXPORTED',id,best['frame'],flush=True)
(out/f'ual{library}-manifest.json').write_text(json.dumps(entries,indent=2))
