"""Create review sheets and x-ray fitting overlays from captured frame images."""
from PIL import Image,ImageDraw,ImageChops
from pathlib import Path
import json
root=Path(__file__).resolve().parents[1];p=root/'docs/ual-fit'
for view in ['front','side']:
 for start in range(0,61,10):
  frames=list(range(start,min(start+10,61)));sheet=Image.new('RGB',(256*len(frames),3*278),'#202020');draw=ImageDraw.Draw(sheet)
  for row,kind in enumerate(['source','blender','app']):
   for col,f in enumerate(frames):
    sheet.paste(Image.open(p/kind/view/f'{f:03}.png'),(col*256,row*278+22));draw.text((col*256+5,row*278+5),f'{kind} {view} · frame {f}',fill='white')
  sheet.save(p/f'{view}-{start:02}-{frames[-1]:02}.png')
 # The overlay is an explicit composite, so hidden internal joints remain visible.
 neutral=Image.open(p/f'neutral-{view}.png').convert('RGB');skeleton=Image.open(p/f'skeleton-{view}.png').convert('RGB');mask=skeleton.point(lambda _:0).convert('L')
 pixels=skeleton.load();mp=mask.load()
 for y in range(skeleton.height):
  for x in range(skeleton.width):
   r,g,b=pixels[x,y]
   if r>g*1.4 and r>b*1.4:mp[x,y]=255
 overlay=neutral.copy();overlay.paste(skeleton,(0,0),mask);overlay.save(p/f'fit-overlay-{view}.png')
frames=[0,15,30,45,60];sheet=Image.new('RGB',(5*256,6*278),'#202020');draw=ImageDraw.Draw(sheet)
for row,(view,kind) in enumerate((v,k) for v in ['front','side'] for k in ['source','blender','app']):
 for col,f in enumerate(frames):
  sheet.paste(Image.open(p/kind/view/f'{f:03}.png'),(col*256,row*278+22));draw.text((col*256+5,row*278+5),f'{kind} {view} · frame {f}',fill='white')
sheet.save(p/'key-frames.png')
# Use the fitted body, rather than the old UAL body, for the app gallery.
Image.open(p/'blender/front/030.png').save(root/'assets/ual-fit/ual1-Crouch_Fwd_Loop.png')
print('Review sheets assembled for all 61 frames in front and side views.')
# Compact overviews, final preview, and measured documentation are regenerated
# alongside the detailed sheets so evidence cannot silently describe old data.
import hashlib,re
for view in ['front','side']:
 overview=Image.new('RGB',(1120,7*3*126),'#202020');draw=ImageDraw.Draw(overview)
 for frame in range(61):
  for row,kind in enumerate(['source','blender','app']):
   x=(frame%10)*112;y=(frame//10)*378+row*126
   overview.paste(Image.open(p/kind/view/f'{frame:03}.png').resize((112,112)),(x,y+14));draw.text((x+2,y+1),f'{frame} {kind}',fill='white')
 overview.save(p/f'all-frames-{view}.png')
preview=Image.new('RGB',(768,564),'#202020');draw=ImageDraw.Draw(preview)
for row,view in enumerate(['front','side']):
 for col,kind in enumerate(['source','blender','app']):
  preview.paste(Image.open(p/kind/view/'030.png'),(col*256,row*282+26));draw.text((col*256+8,row*282+8),f'{kind.upper()} · {view} · frame 30',fill='white')
preview.save(p/'comparison-preview.png')
report=json.loads((p/'browser-comparison.json').read_text());fit=json.loads((root/'assets/ual-fit/fit-report.json').read_text());baked=json.loads((p/'baked-action-comparison.json').read_text())
sha=hashlib.sha256((root/'assets/ual-fit/ual1-Crouch_Fwd_Loop-frames.json').read_bytes()).hexdigest()
readme=(p/'README.md').read_text()
for name,key,mult,fmt in [('Deformed vertex position','maxVertexMetres',1000,'.6f'),('Bone position','maxBoneMetres',1000,'.6f'),('Bone rotation','maxRotationDegrees',1,'.8f')]:
 value=format(report[key]*mult,fmt);unit='°' if mult==1 else ' mm'
 readme=re.sub(r'\| '+name+r' \| [^|]+ \|',f'| {name} | {value}{unit} |',readme)
readme=re.sub(r'The exporter was rerun using its saved anatomical binding and produced byte-identical animation JSON\. SHA-256: `[^`]+`\.',f'This export reused the saved anatomical binding. Animation JSON SHA-256: `{sha}`.',readme)
readme=re.sub(r'Animation JSON SHA-256: `[^`]+`\.',f'Animation JSON SHA-256: `{sha}`.',readme)
max_contact=max(v['correction'] for row in fit['corrections'] for v in row['feet'].values())
readme=re.sub(r'largest recorded stance correction is [\d.]+ mm',f'largest recorded stance correction is {max_contact*1000:.2f} mm',readme)
readme=re.sub(r'maximum position difference [\d.]+ mm and rotation difference [\d.]+°',f"maximum position difference {baked['maxLocalPositionMetres']*1000:.6f} mm and rotation difference {baked['maxLocalRotationDegrees']:.8f}°",readme)
if 'actual skinned soles' not in readme:
 stance=[v for row in fit['corrections'] for v in row['feet'].values() if v['blend']==1]
 readme+='\nContact correction measures the actual skinned soles. Maximum absolute sole clearance at full stance: '+format(max(abs(v['soleAfter']) for v in stance)*1000,'.8f')+' mm. The figure is not automatically grounded or recentered at each frame.\n'
(p/'README.md').write_text(readme)
