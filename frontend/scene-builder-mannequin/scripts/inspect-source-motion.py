"""Read source UAL actions without editing or saving the Blender assets."""
import bpy,json,sys,math
from pathlib import Path
from mathutils import Matrix
root=Path(__file__).resolve().parents[1];out=root/'docs/ual-fit/limb-clearance/motion-review'
flags=[r for r in json.loads((root/'assets/ual-library/limb-correction-continuity.json').read_text()) if r['maxCorrectionStepDegrees']>8]
C=Matrix.Rotation(-math.pi/2,4,'X');Ci=C.inverted()
by_source={}
for row in flags:
 fit=json.loads((root/'assets/ual-library'/row['id']/'fit-report.json').read_text());by_source.setdefault(fit['source'],[]).append((row['id'],fit))
for source,items in by_source.items():
 bpy.ops.wm.open_mainfile(filepath=source,load_ui=False,use_scripts=False);scene=bpy.context.scene;rig=next(o for o in scene.objects if o.type=='ARMATURE');names=[b.name for b in rig.data.bones if b.use_deform]
 rig.animation_data.action=bpy.data.actions['A_TPose'];scene.frame_set(0);bpy.context.view_layer.update();baseline={b.name:b.matrix_basis.copy() for b in rig.pose.bones}
 for id,fit in items:
  rows=[]
  for f in range(fit['start'],fit['end']+1):
   rig.animation_data.action=None
   for n,m in baseline.items():rig.pose.bones[n].matrix_basis=m.copy()
   action=bpy.data.actions[fit['action']];rig.animation_data.action=action
   if action.slots:rig.animation_data.action_slot=action.slots[0]
   scene.frame_set(f);bpy.context.view_layer.update();ev=rig.evaluated_get(bpy.context.evaluated_depsgraph_get());rows.append({'frame':f,'boneWorld':{n:[v for row in C@(ev.matrix_world@ev.pose.bones[n].matrix)@Ci for v in row] for n in names}})
  (out/(id+'-source.json')).write_text(json.dumps({'source':source,'frames':rows}));print('REVIEW SOURCE',id,len(rows),flush=True)
