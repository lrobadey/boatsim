"""Propagate the toolkit's reviewed shared primitives into the assembled study.
The toolkit remains authoritative for these named definitions; scene layout is preserved.
"""
import ast
from pathlib import Path
root=Path(__file__).resolve().parents[2]
src=(root/'harbor-kit/blender/authoring.py').read_text();target=root/'harbor-study/blender/build_harbor.py';dst=target.read_text()
names={'Mesh','tube','lathe','jar','basket','building','box','tint','masonry'}
source={n.name:ast.get_source_segment(src,n) for n in ast.parse(src).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names}
lines=dst.splitlines(keepends=True)
for n in sorted([n for n in ast.parse(dst).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names],key=lambda n:n.lineno,reverse=True):lines[n.lineno-1:n.end_lineno]=[source[n.name]+'\n']
dst=''.join(lines)
a=src.index('# Seamless multiscale');b=src.index('builders={}')
c=dst.index('# Seamless multiscale');d=dst.index('builders={}')
palette=src[a:b]+"for material in mats.values():material.use_backface_culling=material.name not in ('cloth','leaf','olive_leaf','tile')\n\n"
# The assembled terrain has a lighter dry-soil field; props retain kit materials.
palette=palette.replace("('earth',(0.46,0.44,0.32))","('earth',(0.60,0.56,0.43))")
target.write_text(dst[:c]+palette+dst[d:])
