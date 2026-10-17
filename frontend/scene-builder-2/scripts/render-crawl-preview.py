"""Render only UAL1 Crawl_Fwd_Loop (0–65) with a fixed camera.
Blender --background --disable-autoexec UAL1.blend --python scripts/render-crawl-preview.py -- 1 /tmp/crawl-preview
Encode at 30 fps with ffmpeg into public/poses2/ual1-Crawl_Fwd_Loop.mp4.
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

for o in scene.objects:o.hide_render=o!=mesh
rig.hide_render=False
scene.render.engine='BLENDER_WORKBENCH';scene.render.resolution_x=256;scene.render.resolution_y=256;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.display.shading.light='STUDIO';scene.display.shading.color_type='SINGLE';scene.display.shading.single_color=(.62,.66,.72)
scene.display.shading.show_shadows=True;scene.display.shading.show_cavity=True;scene.display.shading.background_type='WORLD';scene.world.color=(.055,.06,.075)
camera_data=bpy.data.cameras.new('PoseGalleryCamera');camera=bpy.data.objects.new('PoseGalleryCamera',camera_data);scene.collection.objects.link(camera);scene.camera=camera;camera_data.type='ORTHO'

action=bpy.data.actions['Crawl_Fwd_Loop']
all_vertices=[]
for frame in range(66):
 evaluate(action,frame)
 obj=mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
 all_vertices.extend(obj.matrix_world @ v.co for v in obj.data.vertices)
lo=Vector(tuple(min(v[i] for v in all_vertices) for i in range(3)))
hi=Vector(tuple(max(v[i] for v in all_vertices) for i in range(3)))
center=(lo+hi)/2
camera.location=center+Vector((.35,-1,.18)).normalized()*8
camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
inv=camera.rotation_euler.to_matrix().transposed()
projected=[inv @ (v-center) for v in all_vertices]
camera_data.ortho_scale=max(max(v.x for v in projected)-min(v.x for v in projected),max(v.y for v in projected)-min(v.y for v in projected))*1.18
for frame in range(66):
 evaluate(action,frame)
 scene.render.filepath=str(out/f'crawl-{frame:03}.png')
 bpy.ops.render.render(write_still=True)
