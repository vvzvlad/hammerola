"""Dump a .kicad_pcb (read-only) to JSON for check.py and creep.py: footprints, pads with copper polygons, tracks, vias with their copper layers, zones with fills refilled in memory, edge, the board outline polygon with its cut-outs as holes, each net's net class, the copper layers in stack order, F/B silk (mm).
usage: dump.py board.kicad_pcb out.json
needs: KiCad's bundled Python with pcbnew, e.g. /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3"""
import sys, json, pcbnew

b = pcbnew.LoadBoard(sys.argv[1])
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
MM = 1e-6


def pt(p):
    return [round(p.x * MM, 4), round(p.y * MM, 4)]


def polyset(ps):
    out = []
    for i in range(ps.OutlineCount()):
        o = ps.Outline(i)
        ring = [pt(o.CPoint(j)) for j in range(o.PointCount())]
        holes = []
        for h in range(ps.HoleCount(i)):
            hh = ps.Hole(i, h)
            holes.append([pt(hh.CPoint(j)) for j in range(hh.PointCount())])
        out.append({'outer': ring, 'holes': holes})
    return out


CU = {l: b.GetLayerName(l) for l in b.GetEnabledLayers().CuStack()}
outline = pcbnew.SHAPE_POLY_SET()
b.GetBoardPolygonOutlines(outline, False)
D = {'fps': [], 'tracks': [], 'vias': [], 'zones': [], 'edge': [], 'texts': [], 'netclass': {}, 'copper': list(CU.values()),
     'outline': polyset(outline)}
for n, ni in b.GetNetsByName().items():
    nm = str(n)
    if nm:
        D['netclass'][nm] = ni.GetNetClassName()

for f in b.GetFootprints():
    fd = {'ref': f.GetReference(), 'value': f.GetValue(), 'fpid': f.GetFPIDAsString(), 'pos': pt(f.GetPosition()),
          'rot': f.GetOrientationDegrees(), 'side': 'B' if f.IsFlipped() else 'F', 'pads': [],
          'ref_visible': f.Reference().IsVisible(), 'ref_layer': f.Reference().GetLayerName(),
          'ref_pos': pt(f.Reference().GetPosition()), 'ref_h': f.Reference().GetTextHeight() * MM,
          'ref_thick': f.Reference().GetTextThickness() * MM, 'ref_rot': f.Reference().GetTextAngleDegrees()}
    cy = f.GetCourtyard(pcbnew.F_CrtYd if not f.IsFlipped() else pcbnew.B_CrtYd)
    fd['courtyard'] = polyset(cy) if cy.OutlineCount() else []
    bb = f.GetBoundingBox(False)
    fd['bbox'] = [bb.GetLeft() * MM, bb.GetTop() * MM, bb.GetRight() * MM, bb.GetBottom() * MM]
    for p in f.Pads():
        pd = {'num': p.GetNumber(), 'net': p.GetNetname(), 'pos': pt(p.GetPosition()),
              'size': [p.GetSizeX() * MM, p.GetSizeY() * MM], 'rot': p.GetOrientationDegrees(),
              'shape': p.ShapeType(p.GetShape()) if hasattr(p, 'ShapeType') else int(p.GetShape()),
              'attr': int(p.GetAttribute()), 'drill': [p.GetDrillSizeX() * MM, p.GetDrillSizeY() * MM],
              'layers': [CU[l] for l in CU if p.IsOnLayer(l)], 'poly': {}}
        for l, nm in CU.items():
            if p.IsOnLayer(l) and p.FlashLayer(l):
                ps = pcbnew.SHAPE_POLY_SET()
                # outside the true outline by at most 5 um: creep.py's distances never come out larger than the copper's
                p.TransformShapeToPolygon(ps, l, 0, 5000, pcbnew.ERROR_OUTSIDE)
                pd['poly'][nm] = polyset(ps)
        fd['pads'].append(pd)
    D['fps'].append(fd)

for t in b.GetTracks():
    if t.GetClass() == 'PCB_VIA':
        D['vias'].append({'pos': pt(t.GetPosition()), 'd': t.GetWidth(pcbnew.F_Cu) * MM, 'drill': t.GetDrillValue() * MM,
                          'net': t.GetNetname(), 'uuid': t.m_Uuid.AsString(), 'layers': [CU[l] for l in CU if t.IsOnLayer(l)]})
    elif t.GetClass() == 'PCB_TRACK':
        D['tracks'].append({'a': pt(t.GetStart()), 'b': pt(t.GetEnd()), 'w': t.GetWidth() * MM,
                            'layer': t.GetLayerName(), 'net': t.GetNetname(), 'uuid': t.m_Uuid.AsString()})
    else:
        D['tracks'].append({'arc': True, 'a': pt(t.GetStart()), 'mid': pt(t.GetMid()), 'b': pt(t.GetEnd()), 'w': t.GetWidth() * MM,
                            'layer': t.GetLayerName(), 'net': t.GetNetname(), 'uuid': t.m_Uuid.AsString()})

for z in b.Zones():
    zd = {'name': z.GetZoneName(), 'net': z.GetNetname(), 'layers': [b.GetLayerName(l) for l in z.GetLayerSet().Seq()],
          'rule_area': z.GetIsRuleArea(), 'priority': z.GetAssignedPriority(),
          'outline': polyset(z.Outline()), 'uuid': z.m_Uuid.AsString(), 'clearance': z.GetLocalClearance() * MM if z.GetLocalClearance() is not None else None,
          'min_w': z.GetMinThickness() * MM, 'fill': {}}
    if z.GetIsRuleArea():
        zd['keepout'] = {'tracks': z.GetDoNotAllowTracks(), 'vias': z.GetDoNotAllowVias(), 'pads': z.GetDoNotAllowPads(),
                         'zones': z.GetDoNotAllowZoneFills(), 'fps': z.GetDoNotAllowFootprints()}
    else:
        zd['connect'] = int(z.GetPadConnection())
        zd['thermal_gap'] = z.GetThermalReliefGap() * MM
        zd['spoke'] = z.GetThermalReliefSpokeWidth() * MM
        for l in z.GetLayerSet().Seq():
            fp = z.GetFilledPolysList(l)
            zd['fill'][b.GetLayerName(l)] = polyset(fp)
    D['zones'].append(zd)

for d in b.GetDrawings():
    if d.GetLayer() == pcbnew.Edge_Cuts:
        D['edge'].append({'type': d.GetShapeTypeName() if hasattr(d, 'GetShapeTypeName') else d.GetClass(),
                          'a': pt(d.GetStart()), 'b': pt(d.GetEnd()), 'uuid': d.m_Uuid.AsString()})
    if d.GetClass() in ('PCB_TEXT',):
        D['texts'].append({'text': d.GetText(), 'pos': pt(d.GetPosition()), 'layer': d.GetLayerName(),
                           'h': d.GetTextHeight() * MM, 'rot': d.GetTextAngleDegrees(), 'uuid': d.m_Uuid.AsString()})
# silkscreen polygons on both sides: footprint graphics, visible footprint fields/texts, board graphics/texts
SILK = (pcbnew.F_SilkS, pcbnew.B_SilkS)
D['silk'] = []
for f in b.GetFootprints():
    items = list(f.GraphicalItems()) + [x for x in f.GetFields() if x.IsVisible()]
    for it in items:
        if it.GetLayer() not in SILK:
            continue
        ps = pcbnew.SHAPE_POLY_SET()
        try:
            it.TransformShapeToPolygon(ps, it.GetLayer(), 0, 5000, pcbnew.ERROR_INSIDE)
        except Exception as e:
            continue
        kind = 'field' if it.GetClass() in ('PCB_FIELD',) else ('text' if 'TEXT' in it.GetClass() else 'shape')
        D['silk'].append({'ref': f.GetReference(), 'layer': b.GetLayerName(it.GetLayer()), 'kind': kind,
                          'text': it.GetText() if kind != 'shape' else '', 'poly': polyset(ps)})
for d in b.GetDrawings():
    if d.GetLayer() not in SILK:
        continue
    ps = pcbnew.SHAPE_POLY_SET()
    d.TransformShapeToPolygon(ps, d.GetLayer(), 0, 5000, pcbnew.ERROR_INSIDE)
    D['silk'].append({'ref': '', 'layer': b.GetLayerName(d.GetLayer()), 'kind': 'board',
                      'text': d.GetText() if 'TEXT' in d.GetClass() else '', 'poly': polyset(ps),
                      'uuid': d.m_Uuid.AsString()})
json.dump(D, open(sys.argv[2], 'w'))
print('fps', len(D['fps']), 'tracks', len(D['tracks']), 'vias', len(D['vias']), 'zones', len(D['zones']), 'edge', len(D['edge']), 'texts', len(D['texts']))
