"""Discover the actual Blender actions without a hand-maintained pose list."""
import bpy,json,sys
from pathlib import Path
out=Path(sys.argv[sys.argv.index('--')+1])
rows=[]
for action in sorted(bpy.data.actions,key=lambda a:a.name):
 start,end=map(int,action.frame_range)
 rows.append({'name':action.name,'start':start,'end':end,'frames':end-start+1})
out.write_text(json.dumps(rows,indent=2))
print('UAL_ACTIONS',len(rows))
