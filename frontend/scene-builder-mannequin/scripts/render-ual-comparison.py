"""Render original UAL and fitted MakeHuman, front/side, all exported frames."""
import bpy,sys,json,math
import numpy as np
from pathlib import Path
from mathutils import Vector,Matrix
out=Path(sys.argv[sys.argv.index('--')+1]);out.mkdir(parents=True,exist_ok=True)
scene=bpy.context.scene;C=Matrix.Rotation(-math.pi/2,4,'X');Ci=C.inverted()
body=bpy.data.objects['MakeHuman'];rig=bpy.data.objects['MakeHuman UAL skeleton'];original=bpy.data.objects['Mannequin'];source=bpy.data.objects['Armature']
# The source action selected when the comparison file was saved is the requested
# original action, not a retargeted or browser-generated reference.
report=json.loads((Path(bpy.data.filepath).parent/'fit-report.json').read_text())
source.animation_data.action=bpy.data.actions[report['action']]
# Ignore viewport-only hiding in the saved review scene.
for obj in [body,rig,original,source]:obj.hide_set(False)
for o in scene.objects:o.hide_render=True
rig.hide_render=False;source.hide_render=False
crawl=report['action']=='Crawl_Bwd_Loop'
scene.render.engine='BLENDER_WORKBENCH';scene.render.resolution_x=512 if crawl else 256;scene.render.resolution_y=512 if crawl else 256;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.display.shading.light='STUDIO';scene.display.shading.color_type='TEXTURE';scene.display.shading.show_shadows=False;scene.display.shading.show_cavity=False
scene.display.shading.background_type='WORLD';scene.world.color=(.10,.10,.10)
camera_data=bpy.data.cameras.new('Comparison orthographic');camera=bpy.data.objects.new('Comparison orthographic',camera_data);scene.collection.objects.link(camera);scene.camera=camera;camera_data.type='ORTHO';camera_data.ortho_scale=3.8 if crawl else 3.0
# Fixed camera, identical canonical world coordinates and framing in both apps.
center=Vector((0,.4,-.5) if crawl else (0,.8,.7))
views=[('front',Vector((0,.4,3.5) if crawl else (0,.8,4.7))),('side',Vector((4,.4,-.5) if crawl else (4,.8,.7)))]
if '--auto-frame' in sys.argv:
 visible=np.unique([v for poly in body.data.polygons for v in poly.vertices])
 fitted=np.fromfile(Path(bpy.data.filepath).parent/'blender-vertices.f32',dtype='<f4').reshape(-1,len(body.data.vertices),3)[:,visible,:]
 lower=fitted.min(axis=(0,1));upper=fitted.max(axis=(0,1))
 for f in range(scene.frame_start,scene.frame_end+1):
  scene.frame_set(f);bpy.context.view_layer.update();evaluated=original.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh()
  points=np.empty(len(mesh.vertices)*3);mesh.vertices.foreach_get('co',points);points=points.reshape(-1,3);transform=np.asarray(C@evaluated.matrix_world);points=points@transform[:3,:3].T+transform[:3,3]
  lower=np.minimum(lower,points.min(axis=0));upper=np.maximum(upper,points.max(axis=0));evaluated.to_mesh_clear()
 center=Vector(((lower+upper)/2).tolist());camera_data.ortho_scale=float(max(upper-lower)*1.15);distance=max(4.,camera_data.ortho_scale*2)
 views=[('front',center+Vector((0,0,distance))),('side',center+Vector((distance,0,0)))]
 (out/'framing.json').write_text(json.dumps({'center':list(center),'orthoScale':camera_data.ortho_scale,'distance':distance,'resolution':256}))
 # A thin reference grid shows y=0 without hiding source penetration.
 for axis in [0,2]:
  for value in np.linspace(float(lower[2-axis])-.2,float(upper[2-axis])+.2,7):
   curve=bpy.data.curves.new('Floor reference','CURVE');curve.dimensions='3D';curve.bevel_depth=.0008;spline=curve.splines.new('POLY');spline.points.add(1)
   for point,extent in zip(spline.points,[float(lower[axis])-.2,float(upper[axis])+.2]):
    canonical=Vector((0,0,0));canonical[axis]=extent;canonical[2-axis]=value;point.co=(*(Ci@canonical),1)
   line=bpy.data.objects.new('Floor reference',curve);scene.collection.objects.link(line);line.color=(.15,.65,.65,1)
for view,location in ([] if '--fit-only' in sys.argv else views):
 camera.location=Ci@location;camera.rotation_euler=((Ci@center)-camera.location).to_track_quat('-Z','Y').to_euler()
 for kind,obj in [('blender',body),('source',original)]:
  body.hide_render=True;original.hide_render=True;obj.hide_render=False
  directory=out/kind/view;directory.mkdir(parents=True,exist_ok=True)
  for frame in range(scene.frame_start,scene.frame_end+1):
   scene.frame_set(frame);bpy.context.view_layer.update();scene.render.filepath=str(directory/f'{frame:03}.png');bpy.ops.render.render(write_still=True)
if '--animation-only' in sys.argv:sys.exit(0)
# Render the neutral mesh and fitted skeleton overlay from both directions.
body.hide_render=False;original.hide_render=True;arm=rig.data;arm.pose_position='REST'
lines=[]
for bone in arm.bones:
 curve=bpy.data.curves.new('Fit '+bone.name,'CURVE');curve.dimensions='3D';curve.bevel_depth=.004;curve.bevel_resolution=0
 spline=curve.splines.new('POLY');spline.points.add(1)
 for p,v in zip(spline.points,[bone.head_local,bone.tail_local]):p.co=(*v,1)
 obj=bpy.data.objects.new(curve.name,curve);scene.collection.objects.link(obj);obj.color=(1,.1,.05,1);lines.append(obj)
scene.display.shading.color_type='OBJECT';body.color=(.6,.65,.7,1)
scene.render.resolution_x=768;scene.render.resolution_y=768;camera_data.ortho_scale=2.0
center=Vector((0,.85,0))
# X-ray fit overlays: mesh rendered separately; bone-only images are composited.
for view,location in [('front',Vector((0,.85,4))),('side',Vector((4,.85,0)))]:
 camera.location=Ci@location;camera.rotation_euler=((Ci@center)-camera.location).to_track_quat('-Z','Y').to_euler()
 for o in lines:o.hide_render=True
 scene.render.filepath=str(out/f'neutral-{view}.png');bpy.ops.render.render(write_still=True)
 body.hide_render=True
 for o in lines:o.hide_render=False
 scene.render.filepath=str(out/f'skeleton-{view}.png');bpy.ops.render.render(write_still=True)
 body.hide_render=False
print('COMPARISON_RENDERED',out)
