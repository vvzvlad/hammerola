# A concept picture first, then the model from it

Read when the look of the part is free — a case on a desk, a housing, a figure,
anything a person looks at rather than only fits — or when the person asks for
a design, or sends a picture to build from. An image model draws forms; a form
written straight into code comes out as boxes and cylinders.

Contents: drawing the concept — when, the prompt, the call, edits, into the
project · the model from a picture — scale, pixels, what the picture does not
show.

## Drawing the concept

**After the say-back is answered, before the block preview.** The picture is
drawn from what the say-back settled, and the block preview is built from the
picture the person picks.

**The prompt carries what the say-back settled**: what the object is, what sits
in it or on it (a 2.9″ e-paper panel, three buttons), its overall size with
each number named by its axis — "115 mm wide, 80 mm tall, 25 mm deep" (a bare
"115 x 80 x 25 mm" came back standing upright) — how it stands, hangs or is
held, that it is 3D-printed and in how many colours. Ask for
the object three times on one sheet, on a plain light background: a
three-quarter product render, and straight views from the front and from the
side at one scale. The straight views are what the dimensions are read from.

**The call** goes to OpenRouter's image API with the person's OpenRouter key,
substituted into the command from wherever he keeps secrets and never printed.
**No OpenRouter key: hand the person the prompt**, whole and ready to paste, and
ask him either to draw the picture with an image generator of his own and send
it, or to give you an OpenRouter key — and end the turn there. A picture he
sends back goes into `ref/` like any picture he sends (`references/brief.md`).

```sh
OPENROUTER_API_KEY=... python3 - ref/concept-01.txt ref/concept-01 [reference.png ...] <<'EOF'
import base64, json, mimetypes, os, sys, urllib.error, urllib.request
prompt, out, *refs = sys.argv[1:]
body = {"model": "google/gemini-nano-banana-2.1", "resolution": "2K",
        "aspect_ratio": "16:9", "prompt": open(prompt, encoding="utf-8").read()}
if refs:
    body["input_references"] = [{"type": "image_url", "image_url": {
        "url": "data:%s;base64,%s" % (mimetypes.guess_type(p)[0],
                                      base64.b64encode(open(p, "rb").read()).decode())}}
        for p in refs]
request = urllib.request.Request(
    "https://openrouter.ai/api/v1/images", json.dumps(body).encode(),
    {"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"],
     "Content-Type": "application/json"})
try:
    reply = json.load(urllib.request.urlopen(request, timeout=600))
except urllib.error.HTTPError as error:
    sys.exit("HTTP %d: %s" % (error.code, error.read().decode()))
item = reply["data"][0]
path = out + "." + item.get("media_type", "image/png").split("/")[1]
open(path, "wb").write(base64.b64decode(item["b64_json"]))
print("wrote", path, "cost $%s" % reply.get("usage", {}).get("cost"))
EOF
```

The prompt is a file (`ref/concept-01.txt`), so it stays beside the picture it
drew. Another model: the list is `https://openrouter.ai/api/v1/images/models`,
and what one accepts — `resolution`, `aspect_ratio`, how many references — is
under `/api/v1/images/models/<id>/endpoints`.

**Every picture is paid** — the cost is the last thing the call prints. Draw
one, look at it yourself, show it to the person by its absolute path, and draw
more on his word. A concept is the one thing a person is shown before the first
revision, and it is not pushed: the block preview stays the first revision.

**An edit is the picture plus the change.** "Rounder corners", "the buttons on
the side": pass the chosen picture as a reference and say in the prompt only
what changes. A picture the person sent as the look he wants goes in the same
way.

**The picked concept goes into the project**: the picture as
`ref/concept-01.<ext>`, its prompt beside it, a line in `ref/README.md` with
the model, the date and what it shows, and an entry in `project.json`'s
`documents`, `{"file": "ref/concept-01.jpeg", "title": "Concept"}`, so every
revision shows it beside the model (`references/documents.md`).

## The model from a picture

A generated concept, a render or a photo the person sent: the same procedure.
(A barograph case came out of one generated render in about an hour.)

**The scale comes from one element whose real size is known** — a screen of a
named panel, a button, a connector. `PX = checklib.estimated(78.0 / 270,
"mm per pixel: the bezel spans 270 px, taken as 78 mm")` until the element is
named; then `derived` from its datasheet.

**An image model keeps the look, not the numbers.** Before scaling by an
element, compare its width to height in the picture with the real one: a
79 × 36 mm panel named in the prompt was drawn standing upright, 275 px wide
and 550 px tall. When they differ, a scale taken from it is wrong — redraw with
the picture as a reference and the proportion named, rather than model the
distortion.

**Every size the picture shows is pixels times the scale**:
`checklib.derived(395 * PX, "outline width, 395 px in the front view")`. Each
number can then be checked against the picture.

**Pixels come from the straight views**, not from the three-quarter render,
whose perspective shrinks whatever is farther away. A size only the
three-quarter render shows is an `estimated`. The height is on both the front
and the side view: when it differs in pixels, the side view gets its own scale
from it.

**Pixels are read off a grid, not by eye.** Crop the region, enlarge it two or
three times, draw a line every 10 px labelled every 50, and `Read` the result.
It needs Pillow on this machine, which the hub's image having it does not give:

```python
from PIL import Image, ImageDraw
im = Image.open("ref/concept-01.jpeg").convert("RGB")
x0, y0, x1, y1, s = 560, 0, 880, 600, 2          # the region, the enlargement
c = im.crop((x0, y0, x1, y1)).resize(((x1 - x0) * s, (y1 - y0) * s))
d = ImageDraw.Draw(c)
for x in range(x0 - x0 % 10 + 10, x1, 10):
    d.line([((x - x0) * s, 0), ((x - x0) * s, c.height)],
           fill=(255, 0, 0) if x % 50 == 0 else (255, 210, 210))
    if x % 50 == 0:
        d.text(((x - x0) * s + 2, 2), str(x), fill=(255, 0, 0))
for y in range(y0 - y0 % 10 + 10, y1, 10):
    d.line([(0, (y - y0) * s), (c.width, (y - y0) * s)],
           fill=(0, 0, 255) if y % 50 == 0 else (210, 210, 255))
    if y % 50 == 0:
        d.text((2, (y - y0) * s + 2), str(y), fill=(0, 0, 255))
c.save("/tmp/hammerola-grid.png")                # outside the project: not for git
```

**What the picture does not show is invented, and said so.** Depth the views
hide, the wall, how the shells hold together, the inside: each is an
`estimated`, and the message handing over the revision that first carries one
lists it as not in the picture.
