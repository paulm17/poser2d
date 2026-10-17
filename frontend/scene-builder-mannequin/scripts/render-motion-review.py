"""Fixed-camera MakeHuman before/after sheets from recorded deformed vertices."""
import json,math,sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont
root=Path(__file__).resolve().parents[1];out=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root/'docs/ual-fit/limb-clearance/motion-review';summary=json.loads((out/'summary.json').read_text());font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',15);small=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',12)
W,H=300,290
for item in summary['reviews']:
 id=item['id'];base=root/'assets/ual-library'/id;model=json.loads((base/'model.json').read_text());clip=json.loads((base/(id+'-frames.json')).read_text());faces=np.array(model['indices']).reshape(-1,3);visible=np.unique(faces);count=len(model['vertices'])//3;after=np.fromfile(base/'blender-vertices.f32',dtype='<f4').reshape(-1,count,3);before=np.fromfile(out/(id+'-before.f32'),dtype='<f4').reshape(-1,count,3)
 f=item['worstVisibleCorrectionStep']['frame']-clip['start'];lo=max(0,min(f-2,len(after)-5));frames=list(range(lo,min(lo+5,len(after))));points=np.concatenate([before[frames][:,visible,:].reshape(-1,3),after[frames][:,visible,:].reshape(-1,3)]);mins=points.min(0);maxs=points.max(0);cy=(mins[1]+maxs[1])/2;span=max(maxs[1]-mins[1],maxs[0]-mins[0],maxs[2]-mins[2])+.12;scale=(H-40)/span
 def render(v,side,corrected):
  horizontal=2 if side else 0;depth=0 if side else 2;center=(mins[horizontal]+maxs[horizontal])/2;xy=np.c_[(v[:,horizontal]-center)*scale+W/2,H/2-(v[:,1]-cy)*scale];image=Image.new('RGB',(W,H),'#e8e7e3');d=ImageDraw.Draw(image);floor=H/2+cy*scale
  if 0<=floor<H:d.line((0,floor,W,floor),fill='#b0aaa0',width=1)
  triangles=v[faces];normals=np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]);normals/=np.maximum(1e-12,np.linalg.norm(normals,axis=1))[:,None];light=np.array([.3,.8,1.]);light/=np.linalg.norm(light);shade=.48+.48*np.abs(normals@light);color=np.array([185,199,209] if corrected else [201,197,187]);colors=np.clip(shade[:,None]*color,0,255).astype(np.uint8);projected=xy[faces];order=np.argsort(triangles[:,:,depth].mean(1))
  for j in order:d.polygon([tuple(p) for p in projected[j]],fill=tuple(colors[j]))
  return image
 sheet=Image.new('RGB',(W*len(frames),H*4+65),'#f4f3ef');draw=ImageDraw.Draw(sheet);draw.text((12,7),item['action']+' | MakeHuman only | fixed cameras',font=font,fill='#111111');draw.text((12,30),'Grey: before limb correction. Blue: exported result. Window around largest added skin step.',font=small,fill='#333333')
 for col,i in enumerate(frames):
  for row,(side,corrected) in enumerate([(False,False),(False,True),(True,False),(True,True)]):
   img=render((after if corrected else before)[i],side,corrected);d=ImageDraw.Draw(img);d.text((7,7),('SIDE' if side else 'FRONT')+' | '+('AFTER' if corrected else 'BEFORE')+' | frame '+str(clip['frames'][i]['frame']),font=small,fill='#111111');sheet.paste(img,(col*W,row*H+65))
 sheet.save(out/(id+'.jpg'),quality=91)
 print('SHEET',id,flush=True)
