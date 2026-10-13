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

action=bpy.data.actions['Crawl_Fwd_Loop']
frames=[{'frame':frame,'bones':evaluate(action,frame)} for frame in range(66)]
(out/'ual1-Crawl_Fwd_Loop-frames.json').write_text(json.dumps({'version':1,'library':1,'action':action.name,'start':0,'end':65,'fps':30,'frames':frames}))
