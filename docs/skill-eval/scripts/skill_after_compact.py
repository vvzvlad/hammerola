# For each transcript: where the hammerola skill entered, where compactions happened,
# and whether skill text re-appears after each compaction (and how much of it).
import json, sys
MARK = 'The hub builds CAD models from code'
for path in sys.argv[1:]:
    loads, bounds, after = [], [], []
    with open(path) as f:
        for i, line in enumerate(f):
            if '"compact_boundary"' in line:
                o = json.loads(line)
                bounds.append((i, (o.get('compactMetadata') or {}).get('trigger'), o.get('version')))
                continue
            if MARK in line:
                o = json.loads(line)
                s = json.dumps(o, ensure_ascii=False)
                kind = o.get('type') + ':' + ((o.get('attachment') or {}).get('type') or '')
                rec = (i, kind, len(s), 'Keeping checks fast enough' in s)
                (after if bounds else loads).append(rec)
    print(path[:90])
    print('  loads before first compaction:', loads[:3], '... total', len(loads))
    print('  compactions:', bounds[:6], '... total', len(bounds))
    print('  skill text after a compaction:', after[:6], '... total', len(after))
