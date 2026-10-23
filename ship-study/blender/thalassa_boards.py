"""Contact sheets of the untouched native Blender renders."""
from pathlib import Path
from PIL import Image,ImageDraw
from contact_sheet import font

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'renders/thalassa'

def board(items,path,title,subtitle,columns=2):
    width=2400;margin=44;gap=28;top=148
    cellw=(width-margin*2-gap*(columns-1))//columns
    cellh=round(cellw*1700/2600)
    rowh=cellh+100
    rows=(len(items)+columns-1)//columns
    im=Image.new('RGB',(width,top+rows*rowh+28),'#eeeae0')
    d=ImageDraw.Draw(im)
    d.text((margin,30),title,font=font(35),fill='#173b36')
    d.text((margin,85),subtitle,font=font(21),fill='#656b61')
    for i,(source,label,detail) in enumerate(items):
        photo=Image.open(source).convert('RGB')
        photo.thumbnail((cellw,cellh),Image.Resampling.LANCZOS)
        x=margin+(i%columns)*(cellw+gap);y=top+(i//columns)*rowh
        im.paste(photo,(x+(cellw-photo.width)//2,y+(cellh-photo.height)//2))
        d.text((x,y+cellh+15),label,font=font(27),fill='#173b36')
        d.text((x,y+cellh+57),detail,font=font(20),fill='#656b61')
    im.save(path)

if __name__=='__main__':
    labels=[('01 / MASSING','Fitted terraces, cross-hull frame and sculpted stems'),
            ('02 / SURFACES','Open canopy, richer materials and eased joinery'),
            ('03 / MARINE EQUIPMENT','Fuller rig, bow fittings and stern tender hoist'),
            ('04 / LIFE ABOARD','Olive court, shaded seating and exterior fittings'),
            ('05 / FINISH','Linen, bronze craft, open circulation and lighting')]
    items=[(ROOT/'renders/selection/c-hero.png','CHOSEN CONCEPT','The original twin-hull Thalassa')]
    items += [(OUT/f'pass-{i:02d}/hero.png',name,detail) for i,(name,detail) in enumerate(labels,1)]
    board(items,OUT/'five-passes.png','THALASSA / FIVE REFINEMENTS','82 m twin-hull residence / matched camera / native Blender Cycles renders')
    final=OUT/'pass-05'
    board([
        (final/'hero.png','THE FLAGSHIP','Twin galley hulls and open terraces'),
        (final/'stern.png','THE AFT QUARTERS','Sheltered tender hoist and paired residences'),
        (final/'bow.png','THE PROWS','Jade stems, bronze forefeet and bow fittings'),
        (final/'terrace.png','THE TERRACES','Shaded seating, woven runners and planted tubs'),
        (final/'garden.png','THE OLIVE COURT','Daylight beneath the open linen canopy'),
        (final/'waterline.png','AT WATER LEVEL','The continuous galley silhouette'),
        (final/'dusk/hero.png','EVENING AT ANCHOR','Warm lanterns against the cool sea'),
        (final/'dusk/garden.png','LIFE ABOARD','The garden court after sunset'),
    ],OUT/'final-gallery.png','THALASSA / EXTERIOR STUDY','Final refinement / 2600 × 1700 originals / daylight and dusk')
