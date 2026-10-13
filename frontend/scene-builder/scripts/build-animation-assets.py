"""Generate/resume every animation's fixed-camera preview and per-frame data.
Run in Blender with -- <library number> <public/poses2 output directory>.
Requires ffmpeg and ffprobe on PATH. Source blend files are never saved.
"""
import bpy, json, sys, math, subprocess, tempfile, shutil
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


# Resume completed clips, including the existing Crawl_Fwd_Loop preview.
base_action=bpy.data.actions['A_TPose']
evaluate(base_action,0)
baseline_basis={bone.name:bone.matrix_basis.copy() for bone in rig.pose.bones}
for action in sorted(bpy.data.actions,key=lambda a:a.name):
 id=f'ual{library}-{action.name}'
 data_path=out/f'{id}-frames.json';video_path=out/f'{id}.mp4'
 start,end=int(action.frame_range[0]),int(action.frame_range[1]);fps=scene.render.fps/scene.render.fps_base
 if data_path.exists() and video_path.exists():
  try:
   saved=json.loads(data_path.read_text())
   probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=nb_frames','-of','json',str(video_path)]))
   if len(saved['frames'])==end-start+1 and int(probe['streams'][0]['nb_frames'])==end-start+1:
    print('SKIPPED',id,flush=True);continue
  except Exception:pass
 frames=[];all_vertices=[]
 for frame in range(start,end+1):
  bones=evaluate(action,frame)
  # Keep sub-micrometre precision in source world units, without redundant float digits.
  bones={name:{key:[round(value,7) for value in values] for key,values in bone.items()} for name,bone in bones.items()}
  frames.append({'frame':frame,'bones':bones})
  obj=mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
  all_vertices.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
 lo=Vector(tuple(min(v[i] for v in all_vertices) for i in range(3)));hi=Vector(tuple(max(v[i] for v in all_vertices) for i in range(3)));center=(lo+hi)/2
 camera.location=center+Vector((.35,-1,.18)).normalized()*8
 camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
 inv=camera.rotation_euler.to_matrix().transposed();projected=[inv @ (v-center) for v in all_vertices]
 camera_data.ortho_scale=max(max(v.x for v in projected)-min(v.x for v in projected),max(v.y for v in projected)-min(v.y for v in projected))*1.18
 temp=Path(tempfile.mkdtemp(prefix=id+'-'))
 try:
  for index,frame in enumerate(range(start,end+1)):
   evaluate(action,frame);scene.render.filepath=str(temp/f'frame-{index:03}.png');bpy.ops.render.render(write_still=True)
  pending_video=out/f'{id}.pending.mp4'
  subprocess.run(['ffmpeg','-y','-loglevel','error','-framerate',str(fps),'-i',str(temp/'frame-%03d.png'),'-an','-c:v','libx264','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',str(pending_video)],check=True)
  pending_data=out/f'{id}-frames.pending.json';pending_data.write_text(json.dumps({'version':1,'library':library,'action':action.name,'start':start,'end':end,'fps':fps,'frames':frames},separators=(',',':')))
  pending_data.replace(data_path);pending_video.replace(video_path)
 finally:shutil.rmtree(temp)
 print('CLIP_COMPLETE',id,len(frames),flush=True)
