"""Derive a table-driven hull offsets set from J. R. Steffy's Kyrenia hull lines.

Headless run from the repo root:
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/blender/merchant_offsets.py

Writes:
  src/ship/merchantOffsets.ts
  docs/merchant-hull/offsets.json
  docs/merchant-hull/offsets-report.json
"""
import json
import math
import os

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(HERE, 'ref', 'kyrenia_steffy_gltf', 'scene.gltf')
TS_OUT = os.path.join(ROOT, 'src', 'ship', 'merchantOffsets.ts')
DOC_DIR = os.path.join(ROOT, 'docs', 'merchant-hull')
JSON_OUT = os.path.join(DOC_DIR, 'offsets.json')
REPORT_OUT = os.path.join(DOC_DIR, 'offsets-report.json')

SOURCE = {
    'title': 'Kyrenia Ship Hull Lines by J. Richard Steffy',
    'url': 'https://sketchfab.com/3d-models/kyrenia-ship-hull-lines-by-j-richard-steffy-407996fccafb4aacbec59c4a60f1c749',
    'author': 'Digital in situ Preservation Archive',
    'license': 'CC BY 4.0',
}


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def r4(v):
    v = round(float(v), 4)
    return 0.0 if v == 0 else v


def f4(v):
    return f'{r4(v):.4f}'


def movavg(v, w):
    """Centred moving average with edge padding (w odd); output length equals input length."""
    h = w // 2
    p = np.pad(np.asarray(v, dtype=float), h, mode='edge')
    return np.convolve(p, np.ones(w) / w, mode='valid')


def steps(a, b, step):
    """Values from a to b in `step` increments, always ending exactly on b."""
    vals = list(np.arange(a, b, step))
    if not vals or vals[-1] < b - 1e-9:
        vals.append(b)
    else:
        vals[-1] = b
    return np.array(vals, dtype=float)


def arc_len(C):
    return np.r_[0.0, np.cumsum(np.hypot(np.diff(C[:, 0]), np.diff(C[:, 1])))]


def dedupe(C):
    seg = np.hypot(np.diff(C[:, 0]), np.diff(C[:, 1]))
    return C[np.r_[True, seg > 1e-9]]


# ---------------------------------------------------------------- 1. import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)


def material_name(obj):
    if obj.type != 'MESH' or obj.data is None or len(obj.data.materials) == 0:
        return None
    mat = obj.data.materials[0]
    return mat.name if mat is not None else None


def world_vertices(obj):
    co = np.array([v.co[:] for v in obj.data.vertices], dtype=float).reshape(-1, 3)
    M = np.array(obj.matrix_world, dtype=float)
    return co @ M[:3, :3].T + M[:3, 3]


# ---------------------------------------------------------------- 2. densify
def densify(obj, verts):
    mesh = obj.data
    if len(mesh.edges) == 0:
        return verts
    e = np.array([ed.vertices[:] for ed in mesh.edges], dtype=np.int64)
    p1 = verts[e[:, 0]]
    p2 = verts[e[:, 1]]
    L = np.linalg.norm(p2 - p1, axis=1)
    n = np.maximum(1, np.ceil(L / 0.5).astype(np.int64))
    extra = n - 1
    total = int(extra.sum())
    if total == 0:
        return verts
    idx = np.repeat(np.arange(len(e)), extra)
    starts = np.cumsum(extra) - extra
    k = np.arange(total) - np.repeat(starts, extra) + 1
    f = k / n[idx]
    interior = p1[idx] + f[:, None] * (p2[idx] - p1[idx])
    return np.vstack([verts, interior])


lines = []
for obj in bpy.data.objects:
    mat = material_name(obj)
    if mat is None or len(obj.data.vertices) == 0:
        continue
    v = world_vertices(obj)
    lines.append({'name': obj.name, 'mat': mat, 'v': v, 'd': densify(obj, v)})
print(f'mesh objects with a material: {len(lines)}')

# ---------------------------------------------------------------- 3. profile / CL / keel half width
prof = [o for o in lines if o['mat'] == 'material_14']
check(len(prof) == 1, f'expected 1 material_14 object, found {len(prof)}')
P = prof[0]
yminV = float(P['v'][:, 1].min())
ymaxV = float(P['v'][:, 1].max())
CL = (yminV + ymaxV) / 2
keelHalfCm = (ymaxV - yminV) / 2
check(abs(CL + 98.7) < 1.0, f'CL={CL} not within 1.0 of -98.7')
check(4.0 < keelHalfCm < 6.0, f'keelHalfCm={keelHalfCm} not in (4, 6)')


# ---------------------------------------------------------------- 4-7. starboard selection
def starboard(o):
    return float(o['v'][:, 1].min()) > CL - 3


stations_raw = sorted(
    [o for o in lines if o['mat'] == 'material_1' and starboard(o)],
    key=lambda o: float(o['v'][:, 0].mean()),
)
check(len(stations_raw) == 13, f'expected 13 starboard stations, found {len(stations_raw)}')

sheer_c = [
    o for o in lines
    if o['mat'] == 'material_3' and starboard(o)
    and (float(o['v'][:, 1].max()) - float(o['v'][:, 1].min())) > 100
]
check(len(sheer_c) == 1, f'expected 1 starboard sheer curve, found {len(sheer_c)}')
SH = sheer_c[0]['d']

wl_raw = [o for o in lines if o['mat'] == 'material_2' and starboard(o)]
check(len(wl_raw) == 6, f'expected 6 starboard waterlines, found {len(wl_raw)}')
for o in wl_raw:
    o['zw'] = float(o['v'][:, 2].mean())
wl_raw.sort(key=lambda o: o['zw'])

# ---------------------------------------------------------------- 8-9. datums and lengths
zKeel = float(P['d'][:, 2].min())
# design waterline: 1.285 m above the lowest point of the keel, where the standard 18 t load floats
# (Rudan's 1.245 m draft measured from his keel datum, which sits 4 cm above Steffy's keel bottom)
zWL = zKeel + 128.5

xBow = float(SH[:, 0].min())
xStern = float(SH[:, 0].max())
xMid = (xBow + xStern) / 2
Lcm = xStern - xBow

PX = P['d'][:, 0]
PZ = P['d'][:, 2]
pxMin = float(PX.min())
pxMax = float(PX.max())
stemOverhang = (xBow - pxMin) / 100
postOverhang = (pxMax - xStern) / 100
check(0 <= stemOverhang <= 0.6, f'stemOverhang={stemOverhang} outside [0, 0.6]')
check(0 <= postOverhang <= 0.6, f'postOverhang={postOverhang} outside [0, 0.6]')

# ---------------------------------------------------------------- 10. keel / stem / post lower envelope zb(x)
b0 = math.floor(pxMin)
b1 = math.ceil(pxMax)
nb10 = b1 - b0
c10 = b0 + np.arange(nb10) + 0.5
idx10 = np.clip(np.floor(PX - b0).astype(np.int64), 0, nb10 - 1)
mins10 = np.full(nb10, np.inf)
np.minimum.at(mins10, idx10, PZ)
v10 = np.isfinite(mins10)
sm10 = movavg(np.interp(c10, c10[v10], mins10[v10]), 5)


def zb(x):
    return np.interp(x, c10, sm10)


# ---------------------------------------------------------------- 11. sheer functions hbSheer(x), zSheer(x)
SX = SH[:, 0]
SY = SH[:, 1]
SZ = SH[:, 2]
nb11 = int(math.ceil(Lcm / 2))
c11 = xBow + 2 * (np.arange(nb11) + 0.5)
idx11 = np.clip(np.floor((SX - xBow) / 2).astype(np.int64), 0, nb11 - 1)
cnt11 = np.bincount(idx11, minlength=nb11)
v11 = cnt11 > 0
hbRaw = np.full(nb11, -np.inf)
np.maximum.at(hbRaw, idx11, SY - CL)
zRaw = np.bincount(idx11, weights=SZ, minlength=nb11) / np.maximum(cnt11, 1)
hbS = movavg(np.interp(c11, c11[v11], hbRaw[v11]), 9)
zS = movavg(np.interp(c11, c11[v11], zRaw[v11]), 9)


def hbSheer(x):
    return np.interp(x, c11, hbS)


def zSheer(x):
    return np.interp(x, c11, zS)


# ---------------------------------------------------------------- 12. real station sections
def station_section(st):
    x = float(st['v'][:, 0].mean())
    D = st['d']
    h = D[:, 1] - CL
    z = D[:, 2]

    # a. Pareto front, z ascending, ties h descending
    order = np.lexsort((-h, z))
    F = []
    run = -np.inf
    for j in order:
        hj = float(h[j])
        zj = float(z[j])
        if hj > run + 1e-6:
            F.append((hj, zj))
            run = hj
    paretoPoints = len(F)

    # b. top and tumblehome
    zTop = float(z.max())
    hTopLip = float(h[z >= zTop - 3].max())
    tumblehomeCm = F[-1][0] - hTopLip

    # c. keel endpoints
    zbx = float(zb(x))
    K1 = (keelHalfCm, F[0][1])
    keelFixed = zbx >= F[0][1]
    K0 = (keelHalfCm, F[0][1] - 1.0) if keelFixed else (keelHalfCm, zbx)

    # d. curve C
    C = [K1] + [(max(fh, keelHalfCm), fz) for fh, fz in F]
    if zTop > F[-1][1] + 0.5:
        C.append((F[-1][0], zTop))
    C = dedupe(np.array(C, dtype=float))

    # e. resample at 0.5 cm, smooth, enforce monotonicity
    cum = arc_len(C)
    total = cum[-1]
    n = int(math.ceil(total / 0.5))
    t = np.linspace(0.0, total, n + 1)
    R = np.column_stack([np.interp(t, cum, C[:, 0]), np.interp(t, cum, C[:, 1])])
    hS = movavg(R[:, 0], 11)
    zS_ = movavg(R[:, 1], 11)
    hS[0], zS_[0] = R[0, 0], R[0, 1]
    hS[-1], zS_[-1] = R[-1, 0], R[-1, 1]
    hS = np.maximum.accumulate(hS)
    zS_ = np.maximum.accumulate(zS_)
    hS = np.maximum(hS, keelHalfCm)
    Q = dedupe(np.column_stack([hS, zS_]))
    cumQ = arc_len(Q)
    totQ = cumQ[-1]

    # f. final 48 points
    p = np.zeros((48, 2))
    p[0] = K0
    p[1] = ((K0[0] + K1[0]) / 2, (K0[1] + K1[1]) / 2)
    p[2] = Q[0]
    tgt = np.arange(1, 46) / 45 * totQ
    p[3:] = np.column_stack([np.interp(tgt, cumQ, Q[:, 0]), np.interp(tgt, cumQ, Q[:, 1])])

    return {
        'x': x,
        'K0z': float(K0[1]),
        'K1z': float(K1[1]),
        'zTop': zTop,
        'paretoPoints': paretoPoints,
        'tumblehomeCm': float(tumblehomeCm),
        'keelFixed': bool(keelFixed),
        'h47': float(p[47, 0]),
        'pts': p,
    }


real = [station_section(st) for st in stations_raw]
check(len(real) == 13, 'real station count')

# ---------------------------------------------------------------- 13. synthetic end stations
def synth_station(E, x):
    Ep = E['pts']
    h = Ep[:, 0]
    z = Ep[:, 1]
    u = (h - keelHalfCm) / (h[47] - keelHalfCm)
    v = (z - z[0]) / (z[47] - z[0])
    yb = float(zb(x))
    yt = float(zSheer(x))
    ht = max(keelHalfCm, float(hbSheer(x)))
    if yt - yb < 5:
        yb = yt - 5
    return np.column_stack([keelHalfCm + u * (ht - keelHalfCm), yb + v * (yt - yb)])


E_bow = real[0]
E_stern = real[-1]
allst = []
for g in [0.0, 0.25, 0.5, 0.75]:
    x = xBow + g * (E_bow['x'] - xBow)
    allst.append({'x': x, 'real': False, 'pts': synth_station(E_bow, x)})
for st in real:
    allst.append({'x': st['x'], 'real': True, 'pts': st['pts'], 'rep': st})
for g in [0.75, 0.5, 0.25, 0.0]:
    x = xStern + g * (E_stern['x'] - xStern)
    allst.append({'x': x, 'real': False, 'pts': synth_station(E_stern, x)})

for a in allst:
    a['s'] = (a['x'] - xBow) / Lcm
allst.sort(key=lambda a: a['s'])
check(len(allst) == 21, f'station count {len(allst)} != 21')
allst[0]['s'] = 0.0
allst[-1]['s'] = 1.0
Sv = np.array([a['s'] for a in allst])
check(bool(np.all(np.diff(Sv) > 0)), 's not strictly increasing')

# ---------------------------------------------------------------- 14. metres and monotonicity
for a in allst:
    pc = a['pts']
    pm = np.column_stack([pc[:, 0] / 100, (pc[:, 1] - zWL) / 100])
    a['pm'] = pm
    check(bool(np.all(np.diff(pm[:, 0]) >= -1e-9)), f"x not non-decreasing at x={a['x']:.4f}")
    check(bool(np.all(np.diff(pm[:, 1]) >= -1e-9)), f"y not non-decreasing at x={a['x']:.4f}")

S_arr = Sv
P_arr = np.array([a['pm'] for a in allst])
N_ST = len(allst)

# ---------------------------------------------------------------- 15. profileBottom and sheerLine
Xp = steps(pxMin, pxMax, 5.0)
profileBottom = []
for X in Xp:
    profileBottom += [(X - xMid) / 100, (float(zb(X)) - zWL) / 100]

Xs = steps(xBow, xStern, 5.0)
sheerLine = []
for X in Xs:
    sheerLine += [(X - xMid) / 100, float(hbSheer(X)) / 100, (float(zSheer(X)) - zWL) / 100]


# ---------------------------------------------------------------- 16. waterline cross-check
def section(s, t):
    s = min(max(s, 0.0), 1.0)
    t = min(max(t, 0.0), 1.0)
    i = int(np.searchsorted(S_arr, s, side='right')) - 1
    i = min(max(i, 0), N_ST - 2)
    w = (s - S_arr[i]) / (S_arr[i + 1] - S_arr[i])
    u = t * 47
    k = min(int(math.floor(u)), 46)
    f = u - k
    a = P_arr[i, k] * (1 - f) + P_arr[i, k + 1] * f
    b = P_arr[i + 1, k] * (1 - f) + P_arr[i + 1, k + 1] * f
    return (1 - w) * a + w * b


def halfWidthAt(s, y):
    y0 = section(s, 0.0)[1]
    y1 = section(s, 1.0)[1]
    if y <= y0:
        return 0.0
    if y >= y1:
        return float(section(s, 1.0)[0])
    lo, hi = 0.0, 1.0
    for _ in range(24):
        m = (lo + hi) / 2
        if section(s, m)[1] < y:
            lo = m
        else:
            hi = m
    return float(section(s, (lo + hi) / 2)[0])


x_first_real = real[0]['x']
x_last_real = real[-1]['x']


def stats(errs):
    if not errs:
        return 0, None, None
    e = np.array(errs, dtype=float)
    return len(e), float(np.sqrt(np.mean(e * e))), float(np.max(np.abs(e)))


waterlines = []
for wl in wl_raw:
    yw = (wl['zw'] - zWL) / 100
    D = wl['d']
    X = D[:, 0]
    Y = D[:, 1]
    idx = np.floor((X - xBow) / 2).astype(np.int64)
    body, ends = [], []
    for k in np.unique(idx):
        c = xBow + 2 * (k + 0.5)
        if c < xBow or c > xStern:
            continue
        hbW = float(Y[idx == k].max()) - CL
        s = (c - xBow) / Lcm
        err = 100 * halfWidthAt(s, yw) - hbW
        if x_first_real <= c <= x_last_real:
            body.append(err)
        else:
            ends.append(err)
    bn, brms, bmax = stats(body)
    en, ermsv, emax = stats(ends)
    waterlines.append({
        'z': wl['zw'], 'y': yw,
        'bodyCount': bn, 'bodyRmsCm': brms, 'bodyMaxCm': bmax,
        'endsCount': en, 'endsRmsCm': ermsv, 'endsMaxCm': emax,
    })

# ---------------------------------------------------------------- 17. outputs
os.makedirs(os.path.dirname(TS_OUT), exist_ok=True)
os.makedirs(DOC_DIR, exist_ok=True)

stations_out = []
for a in allst:
    stations_out.append({'s': r4(a['s']), 'real': a['real'],
                         'pts': [r4(v) for v in a['pm'].reshape(-1)]})
profile_out = [r4(v) for v in profileBottom]
sheer_out = [r4(v) for v in sheerLine]
length_out = r4(Lcm / 100)
stem_out = r4(stemOverhang)
post_out = r4(postOverhang)
keel_out = r4(keelHalfCm / 100)

ts_lines = [
    '// Generated by tools/blender/merchant_offsets.py from Steffy\'s Kyrenia hull lines. Do not edit by hand.',
    '// This work is based on "Kyrenia Ship Hull Lines by J. Richard Steffy"',
    '// (https://sketchfab.com/3d-models/kyrenia-ship-hull-lines-by-j-richard-steffy-407996fccafb4aacbec59c4a60f1c749)',
    '// by Digital in situ Preservation Archive (https://sketchfab.com/kotaro_yamafune), licensed under CC BY 4.0.',
    "import type { HullOffsets } from './hullShape';",
    '',
    'export const MERCHANT_OFFSETS: HullOffsets = {',
    f'  length: {f4(length_out)},',
    f'  stemOverhang: {f4(stem_out)},',
    f'  postOverhang: {f4(post_out)},',
    f'  keelHalf: {f4(keel_out)},',
    '  waterlineAboveKeel: 1.285,',
    '  stations: [',
]
for a in allst:
    ts_lines.append(
        f"    {{ s: {f4(a['s'])}, real: {'true' if a['real'] else 'false'}, "
        f"pts: [{', '.join(f4(v) for v in a['pm'].reshape(-1))}] }},"
    )
ts_lines += [
    '  ],',
    f"  profileBottom: [{', '.join(f4(v) for v in profileBottom)}],",
    f"  sheerLine: [{', '.join(f4(v) for v in sheerLine)}],",
    '};',
]
with open(TS_OUT, 'w') as fh:
    fh.write('\n'.join(ts_lines) + '\n')

offsets = {
    'length': length_out,
    'stemOverhang': stem_out,
    'postOverhang': post_out,
    'keelHalf': keel_out,
    'waterlineAboveKeel': 1.285,
    'stations': stations_out,
    'profileBottom': profile_out,
    'sheerLine': sheer_out,
    'source': SOURCE,
    'sourceTransform': {'units': 'cm', 'CL': round(CL, 2), 'xMid': round(xMid, 2), 'zWL': round(zWL, 2)},
}
with open(JSON_OUT, 'w') as fh:
    json.dump(offsets, fh, indent=1)
    fh.write('\n')

report_stations = []
for st in real:
    rep = st
    report_stations.append({
        'x': r4(rep['x']),
        's': r4((rep['x'] - xBow) / Lcm),
        'keelZ': r4(rep['K0z']),
        'rabbetZ': r4(rep['K1z']),
        'topZ': r4(rep['zTop']),
        'maxHalfBreadthCm': r4(rep['h47']),
        'tumblehomeCm': r4(rep['tumblehomeCm']),
        'paretoPoints': int(rep['paretoPoints']),
        'keelFixed': bool(rep['keelFixed']),
    })
report = {
    'CL': r4(CL), 'keelHalfCm': r4(keelHalfCm), 'zKeel': r4(zKeel), 'zWL': r4(zWL),
    'xBow': r4(xBow), 'xStern': r4(xStern), 'Lcm': r4(Lcm),
    'pxMin': r4(pxMin), 'pxMax': r4(pxMax),
    'stations': report_stations,
    'waterlines': [
        {k: (r4(v) if isinstance(v, float) else (int(v) if isinstance(v, (int, np.integer)) else v))
         for k, v in wl.items()}
        for wl in waterlines
    ],
}
with open(REPORT_OUT, 'w') as fh:
    json.dump(report, fh, indent=2)
    fh.write('\n')

# ---------------------------------------------------------------- summary
print('--- globals ---')
print(f'CL={CL:.4f} keelHalfCm={keelHalfCm:.4f} zKeel={zKeel:.4f} zWL={zWL:.4f}')
print(f'xBow={xBow:.4f} xStern={xStern:.4f} xMid={xMid:.4f} Lcm={Lcm:.4f}')
print(f'pxMin={pxMin:.4f} pxMax={pxMax:.4f} stemOverhang={stemOverhang:.4f} postOverhang={postOverhang:.4f}')
print('--- stations (sorted by s) ---')
for a in allst:
    if a['real']:
        rep = a['rep']
        print(f"station real x={a['x']:.4f} s={a['s']:.4f} keelZ={rep['K0z']:.4f} rabbetZ={rep['K1z']:.4f} "
              f"topZ={rep['zTop']:.4f} maxHalfBreadthCm={rep['h47']:.4f} tumblehomeCm={rep['tumblehomeCm']:.4f} "
              f"paretoPoints={rep['paretoPoints']} keelFixed={rep['keelFixed']}")
    else:
        print(f"station synthetic x={a['x']:.4f} s={a['s']:.4f}")
print('--- waterlines ---')
for wl in waterlines:
    print(f"waterline z={wl['z']:.4f} y={wl['y']:.4f} "
          f"body n={wl['bodyCount']} rms={wl['bodyRmsCm']} max={wl['bodyMaxCm']} "
          f"ends n={wl['endsCount']} rms={wl['endsRmsCm']} max={wl['endsMaxCm']}")
print(f'wrote {TS_OUT}')
print(f'wrote {JSON_OUT}')
print(f'wrote {REPORT_OUT}')
