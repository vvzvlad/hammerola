# Render a window of an original transcript as a quoted dialogue, saving every image the
# window carries. usage: window.py JSONL FROM_LINE TO_LINE OUT_DIR
# Lines are 0-based JSONL line numbers, inclusive. Writes OUT_DIR/dialog.txt and
# OUT_DIR/images/NNNN-K.<ext>; prints an inventory (who said what, which images where).
import base64, json, os, sys

path, lo, hi, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
os.makedirs(os.path.join(out, 'images'), exist_ok=True)
turns, inventory = [], []

def save_images(blocks, i, origin):
    n = 0
    for b in blocks:
        src = b.get('source') if isinstance(b, dict) else None
        if isinstance(b, dict) and b.get('type') == 'image' and src and src.get('type') == 'base64':
            ext = src.get('media_type', 'image/png').split('/')[-1].split('+')[0]
            name = f'{i:05d}-{n}.{ext}'
            open(os.path.join(out, 'images', name), 'wb').write(base64.b64decode(src['data']))
            inventory.append(f'image {name} from {origin} line {i}')
            n += 1
    return n

with open(path) as fh:
    for i, line in enumerate(fh):
        if i < lo:
            continue
        if i > hi:
            break
        o = json.loads(line)
        t = o.get('type')
        if t == 'user' and not o.get('isMeta'):
            c = o['message'].get('content')
            if isinstance(c, str):
                if not c.lstrip().startswith('<'):
                    turns.append(('user', c, i))
            else:
                texts = [b['text'] for b in c if b.get('type') == 'text' and not b['text'].lstrip().startswith('<')]
                n = save_images(c, i, 'user')
                for b in c:
                    if b.get('type') == 'tool_result' and isinstance(b.get('content'), list):
                        save_images(b['content'], i, 'tool_result')
                if texts or n:
                    turns.append(('user', '\n'.join(texts) + (f'\n(attached {n} image(s))' if n else ''), i))
        elif t == 'attachment' and (o.get('attachment') or {}).get('type') == 'queued_command':
            p = o['attachment'].get('prompt')
            if isinstance(p, list):
                texts = [b['text'] for b in p if b.get('type') == 'text']
                n = save_images(p, i, 'queued')
                turns.append(('user', '\n'.join(texts) + (f'\n(attached {n} image(s))' if n else ''), i))
            elif isinstance(p, str):
                turns.append(('user', p, i))
        elif t == 'assistant':
            for b in o['message'].get('content', []):
                if b.get('type') == 'text' and b['text'].strip():
                    turns.append(('assistant', b['text'], i))

with open(os.path.join(out, 'dialog.txt'), 'w') as f:
    for who, text, i in turns:
        f.write(f'[{who}] {text.strip()}\n\n')
for who, text, i in turns:
    print(f'{i} {who}: {text.strip()[:110]!r}')
print('\n'.join(inventory))
