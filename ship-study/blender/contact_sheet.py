"""Arrange genuine Blender renders with labels; never retouch the ship images."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]
fontroot=Path('/System/Library/Fonts')
def font(size):
    for p in [fontroot/'Supplemental/Arial.ttf',fontroot/'Helvetica.ttc']:
        if p.exists():return ImageFont.truetype(str(p),size)
    return ImageFont.load_default()

def sheet(rows, destination, title, subtitle, width=1400):
    margin=44;top=132;foot=42
    thumbh=int((width-2*margin)*2/3)
    rowh=thumbh+112
    im=Image.new('RGB',(width,top+rowh*len(rows)+foot),'#eeece4')
    d=ImageDraw.Draw(im)
    d.text((margin,28),title,font=font(32),fill='#1c302e')
    d.text((margin,78),subtitle,font=font(19),fill='#5f6862')
    for i,(path,label,detail) in enumerate(rows):
        src=Image.open(path).convert('RGB')
        src.thumbnail((width-margin*2,thumbh),Image.Resampling.LANCZOS)
        y=top+i*rowh
        im.paste(src,(margin+(width-margin*2-src.width)//2,y))
        d.text((margin,y+thumbh+18),label,font=font(27),fill='#1c302e')
        d.text((margin,y+thumbh+61),detail,font=font(19),fill='#5f6862')
    im.save(destination)

if __name__=='__main__':
    p=ROOT/'renders/01-directions'
    sheet([
        (p/'a-p01-hero.png','01  DORY / THE LONG SPEAR','88 m hull / 11.8 m beam — low, ceremonial, closest to a galley'),
        (p/'b-p01-hero.png','02  NEREID / THE TERRACED FLAGSHIP','84 m hull / 16 m beam — open courts, aft terraces, inhabited galleries'),
        (p/'c-p01-hero.png','03  HESTIA / THE SHELTERED RESIDENCE','78 m hull / 18.4 m beam — broad, protected, more architectural'),
    ],ROOT/'renders/01-three-directions.png','A LARGER LIFE AT SEA','Trireme descendants / first exterior studies / Blender Cycles')
    p=ROOT/'renders/selection'
    if all((p/(c+'-hero.png')).exists() for c in 'abc'):
        labels=[('A  ASTERION','War flagship / 90 × 12.6 m'),
                ('B  NEREID','Broad residence / 84 × 19.2 m'),
                ('C  THALASSA','Twin-hull court / 82 × 23.6 m')]
        for views,dest in [(['hero'],'comparison.png'),(['hero','stern','waterline'],'all-views.png')]:
            width=2400;margin=40;gap=24;top=130
            cellw=(width-margin*2-gap*2)//3
            cellh=round(cellw*1300/2000)
            rowh=cellh+106
            im=Image.new('RGB',(width,top+rowh*len(views)+20),'#eeece4')
            d=ImageDraw.Draw(im)
            d.text((margin,26),'THREE TERRACED FLAGSHIPS',font=font(34),fill='#1c302e')
            d.text((margin,79),'Exterior alternatives / native Blender Cycles renders / choose a direction before further passes',font=font(21),fill='#5f6862')
            for row,view in enumerate(views):
                for col,(c,(name,desc)) in enumerate(zip('abc',labels)):
                    src=Image.open(p/(c+'-'+view+'.png')).convert('RGB').resize((cellw,cellh),Image.Resampling.LANCZOS)
                    x=margin+col*(cellw+gap);y=top+row*rowh
                    im.paste(src,(x,y))
                    d.text((x,y+cellh+17),name,font=font(25),fill='#1c302e')
                    d.text((x,y+cellh+55),desc+' / '+view,font=font(20),fill='#5f6862')
            im.save(p/dest)
