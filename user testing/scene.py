#!/usr/bin/env python3
"""Build a detail-preserving scene reference from posed avatars, then optionally run AnyAngle."""
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--layout', type=Path, required=True)
    parser.add_argument('--registration', type=Path, required=True, help='Measured camera pixel bounds from splat-scene/editor-camera.json')
    parser.add_argument('--standing', type=Path, required=True, help='Detailed posed standing avatar PNG on black or transparent background')
    parser.add_argument('--lying', type=Path, required=True, help='Detailed posed lying avatar PNG on black or transparent background')
    parser.add_argument('--width', type=int, default=512)
    parser.add_argument('--output-dir', type=Path, default=HERE/'outputs/scene-repaired')
    parser.add_argument('--anyangle', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if args.width < 256 or args.width > 4096 or args.width % 32:
        parser.error('width must be a multiple of 32 between 256 and 4096')
    # Use the already installed image runtime; no environment installation or download.
    try:
        from PIL import Image, ImageFilter, ImageDraw
    except ImportError:
        python = ROOT/'vpipe/examples/triposplat/.venv/bin/python'
        if Path(sys.executable).resolve() == python.resolve():
            raise ValueError('Pillow is missing from the existing TripoSplat runtime')
        return subprocess.call([str(python), str(Path(__file__).resolve()), *sys.argv[1:]])
    import numpy as np
    paths = [p.expanduser().resolve(strict=True) for p in (args.layout,args.registration,args.standing,args.lying)]
    layout_path,registration_path,standing_path,lying_path = paths
    registration=json.loads(registration_path.read_text())
    layout=Image.open(layout_path).convert('RGB')
    width=args.width;height=round(width*layout.height/layout.width)
    layout=layout.resize((width,height),Image.Resampling.LANCZOS)
    out=args.output_dir.expanduser().absolute();out.mkdir(parents=True,exist_ok=True)
    layout.save(out/'image1-layout.png')
    # The scene has a plain floor and backdrop. Recover their row colours without
    # copying the low-detail rendered characters into the appearance reference.
    rows=np.median(np.asarray(layout),axis=1).astype('uint8')
    background=Image.fromarray(np.repeat(rows[:,None,:],width,axis=1)).convert('RGBA')
    placements=[]
    for index,name,path in [(0,'standing',standing_path),(1,'lying',lying_path)]:
        source=Image.open(path).convert('RGBA');rgba=np.array(source)
        if rgba[:,:,3].min()>=230:
            # These testing-runner outputs have a black background. Alpha follows
            # the dark exterior; feathering avoids a rectangular black cutout.
            bright=rgba[:,:,:3].max(axis=2).astype(float)
            alpha=np.clip((bright-5)/15,0,1)*255
            source.putalpha(Image.fromarray(alpha.astype('uint8')).filter(ImageFilter.GaussianBlur(.35)))
        box=source.getchannel('A').point(lambda a:255 if a>=128 else 0).getbbox()
        if box is None:raise ValueError(f'No foreground: {path}')
        sprite=source.crop(box)
        target=registration['pixelBounds'][index]
        sx=width/registration['width'];sy=height/registration['height']
        target_width=(target['x1']-target['x0'])*sx;target_height=(target['y1']-target['y0'])*sy
        scale=target_height/sprite.height if name=='standing' else target_width/sprite.width
        size=(max(1,round(sprite.width*scale)),max(1,round(sprite.height*scale)))
        sprite=sprite.resize(size,Image.Resampling.LANCZOS)
        cx=(target['x0']+target['x1'])*sx/2;cy=(target['y0']+target['y1'])*sy/2
        x,y=round(cx-size[0]/2),round(cy-size[1]/2)
        # Add only a subtle contact shadow, keeping the posed image as the texture.
        shadow=Image.new('RGBA',background.size);draw=ImageDraw.Draw(shadow)
        if name=='standing':draw.ellipse((x+size[0]*.15,y+size[1]-2,x+size[0]*.9,y+size[1]+3),fill=(0,0,0,65))
        else:draw.ellipse((x,y+size[1]*.65,x+size[0],y+size[1]+2),fill=(0,0,0,55))
        background=Image.alpha_composite(background,shadow.filter(ImageFilter.GaussianBlur(2)))
        background.alpha_composite(sprite,(x,y))
        placements.append({'name':name,'source':str(path),'source_crop':box,'position':[x,y],'size':size,'target_pixels':target})
    background.convert('RGB').save(out/'image2-appearance.png')
    manifest={'layout':str(layout_path),'registration':str(registration_path),'width':width,'height':height,'placements':placements,'appearance_method':'Composite original posed-avatar pixels; no full-scene appearance generation or enlarged previous scene output'}
    (out/'pair.json').write_text(json.dumps(manifest,indent=2))
    print(f'Prepared {width}x{height} pair: {out}',flush=True)
    if not args.anyangle:return 0
    canvas_height=math.ceil(height/32)*32
    command=[sys.executable,str(HERE/'image.py'),'--anyangle','--width',str(width),'--height',str(canvas_height),'--fit','contain','--reference',str(out/'image1-layout.png'),'--reference',str(out/'image2-appearance.png'),'--prompt','Change the camera angle from <image2> to <image1>.','--output-dir',str(out/'generation')]
    if args.prepare_only:command.append('--prepare-only')
    result=subprocess.call(command)
    if result:return result
    if not args.prepare_only:
        generated=Image.open(out/'generation/output.png')
        y=(canvas_height-height)//2
        generated.crop((0,y,width,y+height)).save(out/'final.png')
        print(f'Saved {out / "final.png"}',flush=True)
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,subprocess.CalledProcessError) as e:sys.exit(f'Error: {e}')
