"""Independently read the saved Blender action back at every frame."""
import bpy,json,sys,math
from pathlib import Path
from mathutils import Matrix,Vector,Quaternion
out=Path(sys.argv[sys.argv.index('--')+1]);entry=json.loads((out/'manifest.json').read_text())[0];clip=json.loads((out/(entry['id']+'-frames.json')).read_text());rig=bpy.data.objects['MakeHuman UAL skeleton'];C=Matrix.Rotation(-math.pi/2,4,'X');Ci=C.inverted()
max_position=0.;max_angle=0.
for frame in clip['frames']:
 bpy.context.scene.frame_set(frame['frame']);bpy.context.view_layer.update();ev=rig.evaluated_get(bpy.context.evaluated_depsgraph_get())
 for n,d in frame['bones'].items():
  b=ev.pose.bones[n];world=C@b.matrix@Ci;local=(C@b.parent.matrix@Ci).inverted()@world if b.parent else world
  p,q,s=local.decompose();expected=Quaternion((d['quaternion'][3],*d['quaternion'][:3]));max_position=max(max_position,(p-Vector(d['position'])).length)
  # atan2 avoids acos cancellation at extremely small angular differences.
  dq=q.rotation_difference(expected);angle=2*math.atan2(Vector((dq.x,dq.y,dq.z)).length,abs(dq.w));max_angle=max(max_angle,math.degrees(angle))
report={'frames':len(clip['frames']),'maxLocalPositionMetres':max_position,'maxLocalRotationDegrees':max_angle,'pass':max_position<.0001 and max_angle<.01}
(Path(sys.argv[sys.argv.index('--')+2]) if len(sys.argv)>sys.argv.index('--')+2 else out/'baked-action-comparison.json').write_text(json.dumps(report,indent=2));print('BAKED_ACTION',json.dumps(report))
if not report['pass']:raise ValueError('Saved Blender action differs from exported frames')
