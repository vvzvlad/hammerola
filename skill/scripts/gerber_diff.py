"""Checks a panel against its board by the Gerbers, as a plain picture diff: gerbv renders every Gerber in one window with a fixed origin and resolution, so a pixel means the same board coordinates in every picture; the board's Gerbers are replicated over the panel's copies (shift and 180° by gerbv's own export of a moved Gerber, `-x rs274x -T`, rasterised as the panel is; a mirror by flipping the picture, with the PAIRED layer: L_i <-> L_(n+1-i), F <-> B silk, mask, paste) and XORed with the panel's: per layer a PNG, light grey agrees, red is in the replicated board and not in the panel, blue the reverse. Nothing is explained away: rails, tabs, the fill pull-back at tab holes, fiducials all come out red or blue, to be looked at. 1-px strips (an edge exactly on a pixel boundary) are dropped as raster and their area printed apart. Drills are compared as sets of holes (x, y, diameter).
usage: python3 gerber_diff.py --single DIR --panel DIR -o OUT (--auto-copies | --copy "OPS" ...) [--dpi 1000] [--gerbv PATH]   (DIR = a gerbers.sh output: the board's *.gbrjob gives the layers and the copper order, *-PTH.drl / *-NPTH.drl are decimal mm; a copy is a chain of operations applied left to right, mm: Tdx,dy shift, Mx<axis> mirror about x=axis, My<axis> about y=axis, R180@cx,cy rotation; --auto-copies finds the copies by matching the board's PTH drill to the panel's; 1000 dpi = 0.0254 mm/px; OUT gets one PNG per layer and summary.txt; exit 0 = no differences, the outline and the panel's extra NPTH aside, 1 = differences)
needs: python3 with numpy and pillow, gerbv (not on the laptop: panel.md, Checks, runs it in docker)"""
# Ported from Wiren Board's gerber_diff.py (wb-agent-tools, wb-panelize skill), under the MIT License:
#
# Copyright (c) 2026 Wiren Board
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
# persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import argparse, glob, json, math, os, re, shutil, subprocess, sys, tempfile
from collections import Counter

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
MIN_AREA = 0.02        # mm²: specks smaller than 0.14 x 0.14 mm are raster and rounding, counted as noise


# ----------------------------------------------------------------------------- files and layers
def find(dirname, suffix, ext):
    m = glob.glob(os.path.join(dirname, f'*-{suffix}.{ext}'))
    return m[0] if m else None


def discover_layers(single_dir, panel_dir):
    """[(name, kind, board file, panel file)], the mirror pairs, (board PTH, board NPTH, panel PTH, panel NPTH)."""
    jobs = glob.glob(os.path.join(single_dir, '*.gbrjob'))
    if not jobs:
        raise SystemExit(f"no *.gbrjob in {single_dir}: export with gerbers.sh, whose job file gives the layers")
    j = json.load(open(jobs[0], encoding='utf-8'))
    copper, others = [], []
    for fa in j.get('FilesAttributes', []):
        suffix = fa.get('Path', '').rsplit('-', 1)[-1]
        parts = fa.get('FileFunction', '').split(',')
        if parts[0] == 'Copper':
            copper.append((int(parts[1][1:]), suffix))
        elif parts[0] in ('Legend', 'SolderMask', 'SolderPaste', 'Profile'):
            others.append((parts[0], parts[1] if len(parts) > 1 else '', suffix,
                           {'Legend': 'silk', 'SolderMask': 'mask', 'SolderPaste': 'paste', 'Profile': 'outline'}[parts[0]]))
    copper.sort()

    def f(d, suffix):
        m = glob.glob(os.path.join(d, '*-' + glob.escape(suffix)))
        return m[0] if m else None
    layers, pair, n = [], {}, len(copper)
    for i, (num, suffix) in enumerate(copper):
        name = f"L{num} {suffix[:-4]}"
        layers.append((name, 'copper', f(single_dir, suffix), f(panel_dir, suffix)))
        pair[name] = f"L{copper[n - 1 - i][0]} {copper[n - 1 - i][1][:-4]}"
    for (func, side, suffix, kind) in others:
        name = suffix[:-4]
        layers.append((name, kind, f(single_dir, suffix), f(panel_dir, suffix)))
        other = [o for o in others if o[0] == func and o[1] != side]
        pair[name] = other[0][2][:-4] if other else name
    drills = (find(single_dir, 'PTH', 'drl'), find(single_dir, 'NPTH', 'drl'), find(panel_dir, 'PTH', 'drl'), find(panel_dir, 'NPTH', 'drl'))
    return layers, pair, drills


def gerber_bounds(path):
    """The extent of a Gerber's coordinates (mm) from its text: format from %FSLAX..Y..*%, units from %MOMM/%MOIN."""
    txt = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'%FSLAX(\d)(\d)Y(\d)(\d)\*%', txt)
    dec = int(m.group(2)) if m else 4
    unit = 25.4 if '%MOIN*%' in txt else 1.0
    xs = [int(v) for v in re.findall(r'X(-?\d+)', txt)]
    ys = [int(v) for v in re.findall(r'Y(-?\d+)', txt)]
    if not xs or not ys:
        return None
    s = unit / 10 ** dec
    return (min(xs) * s, min(ys) * s, max(xs) * s, max(ys) * s)


# ----------------------------------------------------------------------------- drills (Excellon)
def load_drills(path):
    """KiCad's Excellon: METRIC, decimal (an integer coordinate is read as inches 2.5 without leading zeros).
    set((x, y, diameter) mm)."""
    if not path:
        return set()
    txt = open(path, encoding='utf-8', errors='replace').read().splitlines()
    metric = any('METRIC' in l or l.strip() == 'M71' for l in txt[:30])
    scale = 0.001 if metric else 25.4 / 100000
    unit = 1 if metric else 25.4
    tools, cur, out, x, y = {}, None, set(), 0.0, 0.0

    def coord(v):
        return float(v) * unit if '.' in v else int(v) * scale
    for l in txt:
        l = l.strip()
        if l.startswith(';'):
            continue
        m = re.fullmatch(r'T(\d+)C([0-9.]+)', l)
        if m:
            tools[m.group(1)] = float(m.group(2)) * unit
            continue
        m = re.fullmatch(r'T(\d+)', l)
        if m:
            cur = tools.get(m.group(1))
            continue
        m = re.fullmatch(r'(?:X(-?[0-9.]+))?(?:Y(-?[0-9.]+))?(?:G85X(-?[0-9.]+)Y(-?[0-9.]+))?', l)
        if m and l and cur is not None:
            if m.group(1) is not None:
                x = coord(m.group(1))
            if m.group(2) is not None:
                y = coord(m.group(2))
            out.add((round(x, 3), round(y, 3), round(cur, 3)))
            if m.group(3) is not None:
                out.add((round(coord(m.group(3)), 3), round(coord(m.group(4)), 3), round(cur, 3)))
    return out


# ----------------------------------------------------------------------------- copy transforms
def mat_ops(spec):
    M = np.eye(3)
    for tok in spec.split():
        if tok.startswith('T'):
            dx, dy = map(float, tok[1:].split(','))
            A = np.array([[1, 0, dx], [0, 1, dy], [0, 0, 1]], float)
        elif tok.startswith('Mx'):
            ax = float(tok[2:])
            A = np.array([[-1, 0, 2 * ax], [0, 1, 0], [0, 0, 1]], float)
        elif tok.startswith('My'):
            ay = float(tok[2:])
            A = np.array([[1, 0, 0], [0, -1, 2 * ay], [0, 0, 1]], float)
        elif tok.startswith('R'):
            deg, c = tok[1:].split('@')
            cx, cy = map(float, c.split(','))
            t = math.radians(float(deg))
            cs, sn = round(math.cos(t)), round(math.sin(t))
            if abs(abs(cs) + abs(sn) - 1) > 1e-9:
                raise SystemExit("pictures support rotations by 0/90/180/270° only")
            A = np.array([[cs, -sn, cx - cs * cx + sn * cy], [sn, cs, cy - sn * cx - cs * cy], [0, 0, 1]], float)
        else:
            raise SystemExit(f"unknown copy operation: {tok}")
        M = A @ M
    return M


def apply_pt(x, y, M):
    v = M @ np.array([x, y, 1.0])
    return float(v[0]), float(v[1])


def auto_copies(single_pts, panel_pts, tol=0.01, min_frac=0.95):
    """Every transform (shift, Mx, My, R180, each with a shift) that lays the board's PTH onto the panel's."""
    if not single_pts:
        raise SystemExit("--auto-copies: the board has no PTH holes")
    pan = {}
    for (x, y, d) in panel_pts:
        pan.setdefault((round(x / tol), round(y / tol)), []).append((x, y, d))

    def hit(x, y):
        kx, ky = round(x / tol), round(y / tol)
        return any((kx + i, ky + j) in pan for i in (-1, 0, 1) for j in (-1, 0, 1))
    bases = {'T0,0': np.eye(3), 'Mx0': mat_ops('Mx0'), 'My0': mat_ops('My0'), 'R180@0,0': mat_ops('R180@0,0')}
    found = []
    dia = Counter(d for _, _, d in single_pts)
    rare = min(dia, key=lambda d: dia[d])
    anchor = next(p for p in single_pts if p[2] == rare)
    sample = list(single_pts)[:40]
    for bname, B in bases.items():
        bpts = [(*apply_pt(x, y, B), d) for (x, y, d) in single_pts]
        bsample = [(*apply_pt(x, y, B), d) for (x, y, d) in sample]
        ax, ay, ad = (*apply_pt(anchor[0], anchor[1], B), anchor[2])
        for (qx, qy, qd) in panel_pts:
            if abs(qd - ad) > 0.01:
                continue
            tx, ty = qx - ax, qy - ay
            if sum(hit(x + tx, y + ty) for (x, y, _) in bsample) < 0.9 * len(bsample):
                continue
            frac = sum(hit(x + tx, y + ty) for (x, y, _) in bpts) / len(bpts)
            if frac >= min_frac:
                M = mat_ops(f"T{tx},{ty}") @ B
                if not any(np.allclose(M, F, atol=0.02) for F, _ in found):
                    found.append((M, f"{bname} T{tx:.3f},{ty:.3f} ({frac:.0%})"))
    if not found:
        raise SystemExit("--auto-copies: no transform lays the board's PTH onto the panel")
    found.sort(key=lambda t: (apply_pt(0, 0, t[0])[1], apply_pt(0, 0, t[0])[0]))
    print("copies by the drill:", '; '.join(f"{i}: {d}" for i, (_, d) in enumerate(found)))
    return [M for M, _ in found]


# ----------------------------------------------------------------------------- gerbv rendering and pictures
class Frame:
    """The common render window: origin (x0, y0) mm, w x h pixels of px mm. Pixel (col, row):
    x = x0 + col*px, y = y1 - row*px (row 0 is the top)."""
    def __init__(self, x0, y0, x1, y1, px):
        self.px = px
        self.x0, self.y0 = math.floor(x0 / px) * px, math.floor(y0 / px) * px
        self.w, self.h = math.ceil((x1 - self.x0) / px), math.ceil((y1 - self.y0) / px)
        self.x1, self.y1 = self.x0 + self.w * px, self.y0 + self.h * px

    def col(self, x): return int(round((x - self.x0) / self.px))
    def row(self, y): return int(round((self.y1 - y) / self.px))


def render(gerbv, path, frame, dpi):
    """A Gerber -> bool array (h, w) by gerbv -x png in the fixed window."""
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'r.png')
        cmd = [gerbv, '-x', 'png', '-D', str(dpi), '-O', f"{frame.x0 / 25.4:.6f}x{frame.y0 / 25.4:.6f}",
               '-W', f"{frame.w * frame.px / 25.4:.6f}x{frame.h * frame.px / 25.4:.6f}", '-B', '0', '-b', '#000000', '-f', '#ffffff', '-o', out, path]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if not os.path.exists(out):
            raise SystemExit(f"gerbv did not render {path}: {r.stderr[-400:]}")
        a = np.asarray(Image.open(out).convert('L')) > 128
    if a.shape != (frame.h, frame.w):            # gerbv may round the size by a pixel: fit it to the window
        b = np.zeros((frame.h, frame.w), bool)
        hh, ww = min(a.shape[0], frame.h), min(a.shape[1], frame.w)
        b[:hh, :ww] = a[:hh, :ww]
        a = b
    return a


def shift(a, tx, ty, frame, what=''):
    """Shifts a picture by (tx, ty) mm in whole pixels; a fractional shift is a warning (1-px strips along edges)."""
    fc, fr = tx / frame.px, -ty / frame.px
    dc, dr = int(round(fc)), int(round(fr))
    if abs(fc - dc) > 0.05 or abs(fr - dr) > 0.05:
        print(f"WARNING: {what} shift ({tx:.4f}, {ty:.4f}) mm is not a whole number of pixels at {frame.px:.4f} mm/px; false 1-px strips are possible")
    out = np.zeros_like(a)
    h, w = a.shape
    r0, r1 = max(0, dr), min(h, h + dr)
    c0, c1 = max(0, dc), min(w, w + dc)
    if r1 > r0 and c1 > c0:
        out[r0:r1, c0:c1] = a[r0 - dr:r1 - dr, c0 - dc:c1 - dc]
    return out


def copy_image(gerbv, path, M, frame, dpi, cache):
    """A board copy's picture in the common window. gerbv itself shifts and turns by 180° (an exported moved Gerber,
    `-x rs274x -T`, rasterised as the panel is, with no half-pixel strips); gerbv cannot export a mirror, so a
    mirrored copy is the picture flipped about the window's centre and shifted by whole pixels."""
    det = round(np.linalg.det(M[:2, :2]))
    if abs(M[0, 1]) > 1e-9 or abs(M[1, 0]) > 1e-9:
        raise SystemExit("rotation by 90/270° is not implemented (gerbv -T can, but no layer pairs are defined for it)")
    sx, sy = round(M[0, 0]), round(M[1, 1])
    tx, ty = M[0, 2], M[1, 2]
    if det > 0:
        rot = 180 if sx < 0 else 0                 # sx = sy = -1: 180° about (0,0), then the shift
        with tempfile.TemporaryDirectory() as td:
            g = os.path.join(td, 'copy.gbr')
            r = subprocess.run([gerbv, '-x', 'rs274x', '-u', 'mm', '-T', f"{tx:.6f}x{ty:.6f}r{rot}", '-o', g, path], capture_output=True, text=True)
            if not os.path.exists(g):
                raise SystemExit(f"gerbv did not export the moved Gerber {path}: {r.stderr[-300:]}")
            return render(gerbv, g, frame, dpi)
    # mirror: x' = -x + tx (sx=-1, sy=+1) or y' = -y + ty (sy=-1)
    if path not in cache:
        cache[path] = render(gerbv, path, frame, dpi)
    a = cache[path]
    if sx < 0:
        a = a[:, ::-1]
        tx = tx - (frame.x0 + frame.x1)      # col's centre -> (w-1-col)'s centre: x' = x0 + x1 - x
    if sy < 0:
        a = a[::-1, :]
        ty = ty - (frame.y0 + frame.y1)
    return shift(a, tx, ty, frame, 'mirrored copy')


def components(mask, min_px):
    """Connected areas of a mask (4-connectivity) of at least min_px: [(area px, bbox px)]. Row runs, no scipy."""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    n = 0
    parent = {}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    runs_prev = []
    for r in range(h):
        row = mask[r]
        if not row.any():
            runs_prev = []
            continue
        idx = np.nonzero(np.diff(np.concatenate(([0], row.astype(np.int8), [0]))))[0]
        runs = [(idx[i], idx[i + 1]) for i in range(0, len(idx), 2)]
        cur = []
        for (c0, c1) in runs:
            n += 1
            parent[n] = n
            lab = n
            for (p0, p1, pl) in runs_prev:
                if p0 < c1 and c0 < p1:
                    parent[find(lab)] = find(pl)
            labels[r, c0:c1] = lab
            cur.append((c0, c1, lab))
        runs_prev = cur
    if n == 0:
        return []
    stats = {}
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys, xs):
        root = find(labels[y, x])
        s = stats.setdefault(root, [0, x, y, x, y])
        s[0] += 1
        s[1], s[2], s[3], s[4] = min(s[1], x), min(s[2], y), max(s[3], x), max(s[4], y)
    return sorted(((s[0], (s[1], s[2], s[3], s[4])) for s in stats.values() if s[0] >= min_px), key=lambda t: -t[0])


def bbox_mm(bb, frame):
    c0, r0, c1, r1 = bb
    return tuple(round(float(v), 2) for v in (frame.x0 + c0 * frame.px, frame.y1 - (r1 + 1) * frame.px, frame.x0 + (c1 + 1) * frame.px, frame.y1 - r0 * frame.px))


def erode(mask, r_px):
    out = mask.copy()
    for d in range(1, r_px + 1):
        out[d:, :] &= mask[:-d, :]; out[:-d, :] &= mask[d:, :]; out[:, d:] &= mask[:, :-d]; out[:, :-d] &= mask[:, d:]
    return out


def dilate(mask, r_px):
    """Grows a mask by r_px pixels (a square, by shifts)."""
    out = mask.copy()
    for d in range(1, r_px + 1):
        out[d:, :] |= mask[:-d, :]; out[:-d, :] |= mask[d:, :]; out[:, d:] |= mask[:, :-d]; out[:, :-d] |= mask[:, d:]
    return out


def opening(mask, r_px=1):
    """Drops strips thinner than 2*r_px+1 px (edges lying exactly on a pixel boundary rasterise differently)."""
    return dilate(erode(mask, r_px), r_px)


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--single', required=True)
    ap.add_argument('--panel', required=True)
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--copy', action='append')
    ap.add_argument('--auto-copies', action='store_true')
    ap.add_argument('--dpi', type=int, default=1000, help='gerbv render resolution: 1000 = 0.0254 mm/px, 2000 = 0.0127')
    ap.add_argument('--gerbv', default=shutil.which('gerbv') or 'gerbv')
    a = ap.parse_args()
    if not (a.copy or a.auto_copies):
        ap.error('needs --copy ... or --auto-copies')
    if not shutil.which(a.gerbv):
        raise SystemExit("no gerbv: install the gerbv package (apt install gerbv) or name it with --gerbv")
    os.makedirs(a.out, exist_ok=True)
    px = 25.4 / a.dpi
    layers, PAIR, (s_pth, s_npth, p_pth, p_npth) = discover_layers(a.single, a.panel)
    print("layers:", ', '.join(f"{n} [{k}]{'' if pf else ' (not in the panel)'}" for n, k, sf, pf in layers))
    mats = [mat_ops(s) for s in a.copy] if a.copy else auto_copies(load_drills(s_pth), load_drills(p_pth))
    print("copies:", '; '.join(f"{i}: det={np.linalg.det(M[:2, :2]):+.0f}, (0,0)->({apply_pt(0, 0, M)[0]:.3f}, {apply_pt(0, 0, M)[1]:.3f})" for i, M in enumerate(mats)))
    # the common window: the extent of every panel and board Gerber and of the board's copies, with a 2 mm margin
    bs = [gerber_bounds(f) for n, k, sf, pf in layers for f in (sf, pf) if f]
    sb = [b for (n, k, sf, pf) in layers if sf for b in [gerber_bounds(sf)] if b]
    xs, ys = [], []
    for b in bs:
        if b:
            xs += [b[0], b[2]]
            ys += [b[1], b[3]]
    for b in sb:
        for M in mats:
            for (x, y) in ((b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])):
                X, Y = apply_pt(x, y, M)
                xs.append(X)
                ys.append(Y)
    frame = Frame(min(xs) - 2, min(ys) - 2, max(xs) + 2, max(ys) + 2, px)
    print(f"window: x {frame.x0:.3f}..{frame.x1:.3f}, y {frame.y0:.3f}..{frame.y1:.3f}, {frame.w} x {frame.h} px, {px:.4f} mm/px")
    px2 = px * px
    lines, fail = [], False
    cache = {}
    sfile = dict((n, s) for n, k, s, p in layers)
    for (L, kind, sf, pf) in layers:
        if pf is None:
            lines.append(f"SKIP {L}: no file in the panel")
            print(lines[-1])
            continue
        act = render(a.gerbv, pf, frame, a.dpi)
        exp = np.zeros_like(act)
        for M in mats:
            src_name = L if round(np.linalg.det(M[:2, :2])) > 0 else PAIR[L]
            exp |= copy_image(a.gerbv, sfile[src_name], M, frame, a.dpi, cache)
        if kind == 'outline':
            # outline lines of different widths (0.127…0.3): compare the centrelines with a 0.2 mm tolerance
            k = max(1, int(round(0.2 / px)))
            exp, act = dilate(exp, k), dilate(act, k)
        raw_miss = exp & ~act
        raw_extra = act & ~exp
        r_open = max(1, int(round(0.08 / px))) if kind == 'outline' else 1     # outline: lines of different widths leave ~0.06 mm rings
        miss, extra = opening(raw_miss, r_open), opening(raw_extra, r_open)   # 1-px strips are raster, not geometry
        sliver = ((raw_miss & ~miss) | (raw_extra & ~extra)).sum() * px2
        min_px = int(MIN_AREA / px2)
        comp_m = components(miss, 1)
        comp_e = components(extra, 1)
        noise = (sum(c for c, _ in comp_m if c < min_px) + sum(c for c, _ in comp_e if c < min_px)) * px2 + sliver
        big_m = [(c, bb) for c, bb in comp_m if c >= min_px]
        big_e = [(c, bb) for c, bb in comp_e if c >= min_px]
        um_area = sum(c for c, _ in big_m) * px2
        ue_area = sum(c for c, _ in big_e) * px2
        status = 'DIFF' if (big_m or big_e) else 'SAME'
        fail |= status == 'DIFF' and kind != 'outline'
        img = np.full(act.shape + (3,), 255, np.uint8)
        img[exp & act] = (225, 225, 225)
        img[miss] = (220, 0, 0)
        img[extra] = (0, 60, 220)
        Image.fromarray(img).save(os.path.join(a.out, f"{L.replace(' ', '_')}.png"), optimize=True)
        del img
        line = (f"{status} {L:22s} board x copies {exp.sum() * px2:9.2f} mm², panel {act.sum() * px2:9.2f} mm²; missing (red) {um_area:.3f} mm² ({len(big_m)} areas), "
                f"extra (blue) {ue_area:.3f} mm² ({len(big_e)} areas); dropped as raster {noise:.3f} mm²")
        lines.append(line)
        print(line)
        for c, bb in big_m[:5]:
            print(f"      RED  {c * px2:.3f} mm² at {bbox_mm(bb, frame)}")
        for c, bb in big_e[:5]:
            print(f"      BLUE {c * px2:.3f} mm² at {bbox_mm(bb, frame)}")
        del act, exp, miss, extra
    for Dn, s_file, p_file in (('PTH', s_pth, p_pth), ('NPTH', s_npth, p_npth)):
        s = load_drills(s_file)
        act = load_drills(p_file)
        exp = set()
        for M in mats:
            for (x, y, d) in s:
                X, Y = apply_pt(x, y, M)
                exp.add((round(X, 3), round(Y, 3), d))

        def match(a_set, b_set):
            bl = list(b_set)
            return {(x, y, d) for (x, y, d) in a_set if not any(abs(x - bx) <= 0.002 and abs(y - by) <= 0.002 and abs(d - bd) <= 0.002 for bx, by, bd in bl)}
        miss = match(exp, act)
        extra = match(act, exp)
        status = 'SAME' if not miss and not extra else 'DIFF'
        fail |= bool(miss) or (bool(extra) and Dn == 'PTH')     # extra NPTH are the panel's tabs and mouse bites, expected
        line = f"{status} {Dn:22s} board x copies {len(exp)} holes, panel {len(act)}; missing {len(miss)}, extra {len(extra)} {dict(Counter(d for _, _, d in extra)) if extra else ''}"
        lines.append(line)
        print(line)
        for h in sorted(miss)[:5]:
            print("      MISSING:", h)
        for h in sorted(extra)[:5]:
            print("      EXTRA:", h)
    with open(os.path.join(a.out, 'summary.txt'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print("RESULT", "DIFFERENCES (the outline and the panel's NPTH aside)" if fail else "NO DIFFERENCES (the outline and the panel's NPTH aside)", f"— pictures and summary.txt in {a.out}")
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()
