"""Independent source-surface inspection for every frame of an exported action.
Blender source.blend --python this.py -- /absolute/export-directory
"""
import bpy,json,sys,math
from pathlib import Path
from mathutils import Matrix
import numpy as np
out=Path(sys.argv[sys.argv.index('--')+1]).resolve()
# Accept the original milestone root as well as an arbitrary batch export.
if (out/'assets/ual-fit').exists():
 destination=out/'docs/ual-fit/all-frame-foot-inspection.json';out=out/'assets/ual-fit'
else:destination=out/'all-frame-foot-inspection.json'
fit=json.loads((out/'fit-report.json').read_text());scene=bpy.context.scene
mesh=bpy.data.objects['Mannequin'];rig=next(o for o in scene.objects if o.type=='ARMATURE')
C=Matrix.Rotation(-math.pi/2,4,'X');Ci=C.inverted()
names=[b.name for b in rig.data.bones if b.use_deform]
def matrix_rows(matrix):return [value for row in matrix for value in row]
source_rest={name:matrix_rows(C@(rig.matrix_world@rig.data.bones[name].matrix_local)@Ci) for name in names}
rig.animation_data.action=bpy.data.actions['A_TPose'];scene.frame_set(0);bpy.context.view_layer.update()
baseline={b.name:b.matrix_basis.copy() for b in rig.pose.bones}
groups={g.index:g.name for g in mesh.vertex_groups};ids={};toes={};heels={}
for side in ['l','r']:
 ids[side]=[v.index for v in mesh.data.vertices if sum(g.weight for g in v.groups if groups[g.group] in ['foot_'+side,'ball_'+side,'ball_leaf_'+side])>.5]
 toes[side]=[v.index for v in mesh.data.vertices if sum(g.weight for g in v.groups if groups[g.group] in ['ball_'+side,'ball_leaf_'+side])>.5]
 heels[side]=[v.index for v in mesh.data.vertices if sum(g.weight for g in v.groups if groups[g.group]=='foot_'+side)>.5]
 if not ids[side]:raise ValueError('No source foot surface: '+side)
visible=sorted({i for p in mesh.data.polygons for i in p.vertices})
rows=[]
for frame in range(fit['start'],fit['end']+1):
 rig.animation_data.action=None
 for n,m in baseline.items():rig.pose.bones[n].matrix_basis=m.copy()
 action=bpy.data.actions[fit['action']];rig.animation_data.action=action
 if action.slots:rig.animation_data.action_slot=action.slots[0]
 scene.frame_set(frame);bpy.context.view_layer.update()
 obj=mesh.evaluated_get(bpy.context.evaluated_depsgraph_get());em=obj.to_mesh();row={'frame':frame,'bodyMinimum':min((C@(obj.matrix_world@em.vertices[i].co)).y for i in visible),'pelvisHeight':(C@(rig.matrix_world@rig.pose.bones['pelvis'].matrix.translation)).y,'feet':{}}
 for side in ids:
  points=np.asarray([C@(obj.matrix_world@em.vertices[i].co) for i in ids[side]])
  near=points[points[:,1]<points[:,1].min()+.004]
  row['feet'][side]={'soleMin':float(points[:,1].min()),'lowestPatchCenter':near.mean(axis=0).tolist(),'vertexCount':len(points),'toeMinimum':min((C@(obj.matrix_world@em.vertices[i].co)).y for i in toes[side]),'heelMinimum':min((C@(obj.matrix_world@em.vertices[i].co)).y for i in heels[side])}
 row['boneWorld']={name:matrix_rows(C@(rig.matrix_world@rig.pose.bones[name].matrix)@Ci) for name in names}
 obj.to_mesh_clear();rows.append(row)
report={'sourceNeutralHeightMetres':max(v.co.z for v in mesh.data.vertices)-min(v.co.z for v in mesh.data.vertices),'boneRest':source_rest,'boneLengths':{name:rig.data.bones[name].length for name in names},'source':bpy.data.filepath,'action':fit['action'],'groundPlaneMetres':0,'contactToleranceMetres':.002,'sourcePenetrationEnvelopeMetres':.10,'sourceMinimumMetres':min(r['feet'][s]['soleMin'] for r in rows for s in ids),'frames':rows}
destination.write_text(json.dumps(report,indent=2));print('SOURCE_FEET',fit['action'],len(rows),'frames, both feet')
