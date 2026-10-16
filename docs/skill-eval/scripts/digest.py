# Print what a replayed session did, in order: assistant text, tool calls (short), final result.
# usage: digest.py RUN_DIR [max_text_chars]
import json, os, sys

run = sys.argv[1]
cap = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
for line in open(os.path.join(run, 'stream.jsonl')):
    o = json.loads(line)
    t = o.get('type')
    if t == 'assistant':
        for c in o['message'].get('content', []):
            if c.get('type') == 'text' and c['text'].strip():
                print('TEXT:', c['text'][:cap].replace('\n', '\n      '))
            elif c.get('type') == 'tool_use':
                inp = c.get('input', {})
                short = inp.get('command') or inp.get('file_path') or inp.get('skill') or inp.get('description') or inp.get('pattern') or ''
                print('TOOL:', c['name'], str(short)[:160].replace('\n', ' '))
    elif t == 'result':
        print('RESULT: turns', o.get('num_turns'), 'cost', round(o.get('total_cost_usd') or 0, 2),
              'subtype', o.get('subtype'))
print('FILES:', [os.path.relpath(os.path.join(d, f), run) for d, _, fs in os.walk(run)
                 for f in fs if f not in ('stream.jsonl', 'stderr.txt')][:30])
