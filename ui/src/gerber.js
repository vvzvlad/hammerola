// The pure half of the Gerber view (GerberView.jsx): the zip that goes to the
// fab, unpacked; each file in it named as a layer of the board, coloured and
// stacked; and where the board lands on the canvas. Nothing here needs a GPU,
// so ui/tests/gerber.test.js runs all of it.
//
// THE ZIP is read from its central directory, as every unzip reads one: a
// writer that streams may leave the sizes out of the local headers. Two
// methods, stored and deflated, which is what CAD tools write; the second is
// inflated by the browser's own `DecompressionStream('deflate-raw')`. An
// encrypted entry, another method and ZIP64 are refused with a message rather
// than misread.
//
// A LAYER IS WHAT THE FILE SAYS IT IS. The renderer names no layer, and a file
// name is the CAD tool's choice (`-F_Cu.gtl`, `.GTL`, `copper_top.gbr`), so
// the layer is read off the Gerber X2 attribute `%TF.FileFunction,…*%`, off the
// comment `G04 #@! TF.FileFunction,…*` KiCad writes in its place with X2 turned
// off, or off the comment `; #@! TF.FileFunction,…` it writes into an Excellon
// drill program. A Gerber file that carries none is still drawn, as a layer of
// its own under its file name; a file that is neither Gerber nor Excellon (a
// job file, a readme) is left out.
//
// THE COLOURS are KiCad's default theme, the one its board view and the hub's
// (KicadView.jsx) draw a board in, laid on the same background (`--gerber-bg`
// in static/_v/tokens.css). They are the layers' own colours rather than roles
// of the interface, so they are written here as numbers and follow no theme.
//
// THE STACK is the board seen from one side: from the top, the bottom layers
// lie under the inner ones and the inner ones under the top's; from the bottom
// the order is reversed and the picture mirrored. The outline and the layers no
// side owns (drill maps, drawings) lie over the board from either side, and the
// drilled holes are punched through all of it last (GerberView.jsx).
//
// THE VIEW is `{ scale, x, y }`: a point (u, v) of the board, in the
// renderer's units, lands on the canvas at
// (width/2 + flip·u·scale + x, height/2 − v·scale + y) CSS pixels, `flip`
// being −1 from the bottom. `toProcessor` turns that into the renderer's zoom
// and offset, whose unit is half the canvas's shorter side.

/** The document type of a zip of Gerbers, as the hub spells it
 *  (`render.DOCUMENT_TYPES`, compared in tests/test_documents.py). */
export const GERBERS_TYPE = 'gerbers';

/** Where the hub serves the renderer; it fetches its `.wasm` from beside itself. */
export const GERBER_MODULE_URL = '/_v/wasm_gerber_processor.js';

let pending = null;

/**
 * The renderer's module, its WebAssembly compiled, fetched once per page. A
 * rejected import is dropped so that opening the Gerbers again tries again
 * (`loadViewerLibrary` in viewport/library.js says why).
 */
export function loadGerberRenderer() {
  if (!pending) {
    pending = import(/* @vite-ignore */ GERBER_MODULE_URL)
      .then((module) => module.default().then(() => module))
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

// -- the zip ---------------------------------------------------------------

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** One deflated entry's bytes, inflated. */
export async function inflateRaw(data) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // A broken stream rejects these as well as the read below; the read reports it.
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** The files of a zip, `[{ name, data }]` in the order its directory lists
 *  them; directories are left out. Rejects on what it cannot read. */
export async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The directory's end record is the last 22 bytes, followed by a comment of
  // at most 65535.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('this is not a zip: it has no central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error('a ZIP64 archive, which this reader does not take');
  const names = new TextDecoder();
  const files = [];
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) {
      throw new Error('the zip\'s central directory is damaged');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (name.endsWith('/')) continue;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_HEADER) {
      throw new Error(`${name}: the zip has no file where its directory points`);
    }
    if (flags & 1) throw new Error(`${name} is encrypted`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === STORED) files.push({ name, data });
    else if (method === DEFLATED) files.push({ name, data: await inflateRaw(data) });
    else throw new Error(`${name} is compressed by method ${method}, which this reader does not take`);
  }
  return files;
}

// -- the layers ------------------------------------------------------------

/** `%TF.FileFunction,…*%` in Gerber X2, `; #@! TF.FileFunction,…` in Excellon,
 *  `G04 #@! TF.FileFunction,…*` in a Gerber file written with X2 off. */
const FILE_FUNCTION = /%TF\.FileFunction,([^*%]*)\*%|;\s*#@!\s*TF\.FileFunction,([^\r\n]*)|G04\s*#@!\s*TF\.FileFunction,([^*\r\n]*)\*/;
/** An Excellon program opens with its header, `M48`. */
const EXCELLON = /^\s*M48\s*$/m;
/** A Gerber file declares its coordinate format. */
const GERBER = /%FS[LT]/;

/** A colour as the renderer takes it, from its 0–255 channels. */
const tint = (r, g, b) => [r / 255, g / 255, b / 255];

/** KiCad's default colours (see the header), and what each layer is drawn at. */
const COPPER_TOP = tint(200, 52, 52);
const COPPER_BOTTOM = tint(77, 127, 196);
/** The inner layers, In1.Cu first. */
const COPPER_INNER = [
  tint(127, 200, 127), tint(206, 125, 44), tint(79, 203, 203), tint(219, 98, 139),
  tint(167, 165, 198), tint(40, 204, 217), tint(232, 178, 167), tint(242, 237, 161),
];
const SIDES = {
  top: { mask: tint(216, 100, 255), paste: tint(180, 160, 154), legend: tint(242, 237, 161) },
  bottom: { mask: tint(2, 255, 238), paste: tint(0, 194, 194), legend: tint(232, 178, 167) },
};
const PROFILE = tint(208, 210, 205);
const DRAWING = tint(194, 194, 194);
/** The ring of a plated hole, KiCad's `pad_plated_hole`. */
export const HOLE_RING = tint(194, 194, 0);
const ALPHA = { copper: 0.9, mask: 0.4, paste: 0.9, legend: 1, profile: 1, other: 0.8, unknown: 0.8 };

/** KiCad's layer names, which the reader knows the layers by. */
const SIDE_NAME = { top: 'F', bottom: 'B' };
const LEGEND_NAME = 'Silkscreen';
const KIND_NAME = { mask: 'Mask', paste: 'Paste', legend: LEGEND_NAME };

// Where each layer lies, larger nearer the top: a top-side layer over the top
// copper, the copper by its number (L1 the top), a bottom-side layer under the
// bottom copper. What no side owns lies over the board from either side.
const DEPTH = { mask: 1, paste: 2, legend: 3 };
const BELOW_BOTTOM = -1000;
const OVER = { other: 2000, unknown: 2000, drill: 2500, profile: 3000 };

/** The base name of a path in the zip. */
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * What one file of the zip is: `{ file, label, kind, side, z, rgb, alpha,
 * excellon, plated }`, or null for a file that is neither Gerber nor Excellon.
 * `kind` is copper, mask, paste, legend, profile, drill, other (a function
 * this view has no place for: a drill map, a drawing) or unknown (no
 * attribute at all); `side` is top, bottom or null.
 */
export function layerOf(file, text) {
  const excellon = EXCELLON.test(text.slice(0, 2048));
  if (!excellon && !GERBER.test(text)) return null;
  const found = FILE_FUNCTION.exec(text);
  const fields = found ? (found[1] ?? found[2] ?? found[3]).split(',').map((field) => field.trim()) : null;
  return { file, excellon, plated: false, ...classify(fields, baseName(file)) };
}

function classify(fields, name) {
  if (!fields) return { kind: 'unknown', side: null, z: OVER.unknown, label: name, rgb: DRAWING, alpha: ALPHA.unknown };
  const [what, ...rest] = fields;
  const side = rest.includes('Top') ? 'top' : rest.includes('Bot') ? 'bottom' : null;
  if (what === 'Copper') {
    const number = Number((rest.find((field) => /^L\d+$/.test(field)) || 'L0').slice(1));
    const inner = side === null && number > 1;
    return {
      kind: 'copper',
      side,
      z: number ? -number : side === 'bottom' ? BELOW_BOTTOM + 1 : -1,
      label: side ? `${SIDE_NAME[side]}.Cu` : inner ? `In${number - 1}.Cu` : name,
      rgb: side === 'top' ? COPPER_TOP : side === 'bottom' ? COPPER_BOTTOM
        : COPPER_INNER[Math.max(0, number - 2) % COPPER_INNER.length],
      alpha: ALPHA.copper,
    };
  }
  const kind = { Soldermask: 'mask', Paste: 'paste', Legend: 'legend' }[what];
  if (kind && side) {
    return {
      kind,
      side,
      z: side === 'top' ? DEPTH[kind] : BELOW_BOTTOM - DEPTH[kind],
      label: `${SIDE_NAME[side]}.${KIND_NAME[kind]}`,
      rgb: SIDES[side][kind],
      alpha: ALPHA[kind],
    };
  }
  if (what === 'Profile') {
    return { kind: 'profile', side: null, z: OVER.profile, label: 'Edge.Cuts', rgb: PROFILE, alpha: ALPHA.profile };
  }
  if (what === 'Plated' || what === 'NonPlated') {
    const plated = what === 'Plated';
    return {
      kind: 'drill', side: null, z: OVER.drill, label: plated ? 'PTH' : 'NPTH', plated, rgb: HOLE_RING, alpha: 1,
    };
  }
  return { kind: 'other', side: null, z: OVER.other, label: name, rgb: DRAWING, alpha: ALPHA.other };
}

/** Every layer of the unpacked zip, with its text: `layerOf` of each file
 *  the view can draw, in the zip's order. */
export function layersOf(files) {
  const decoder = new TextDecoder();
  const layers = [];
  for (const { name, data } of files) {
    const text = decoder.decode(data);
    const layer = layerOf(name, text);
    if (layer) layers.push({ ...layer, text });
  }
  return layers;
}

/** Whether the board's lower layers lie under `layer` when it is seen from
 *  one side: true of everything a side or a copper number places. */
const onBoard = (layer) => layer.z < OVER.other;

/** The layers in the order they are drawn when the board is seen from `side`,
 *  the one drawn last last. */
export function stacked(layers, side) {
  const depth = (layer) => (onBoard(layer) && side === 'bottom' ? -layer.z : layer.z);
  return layers.slice().sort((a, b) => depth(a) - depth(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Whether `layer` is drawn when the board is turned to `side`: that side's
 *  copper, mask and silkscreen, the outline and the holes, and a layer with
 *  no attribute, which nothing places on a side. The rest — the other side,
 *  the inner copper, the paste, drill maps and drawings — waits for its eye. */
export function shownOn(layer, side) {
  if (layer.kind === 'drill' || layer.kind === 'profile' || layer.kind === 'unknown') return true;
  if (layer.kind === 'paste' || layer.kind === 'other') return false;
  return layer.side === side;
}

/** A layer's colour as CSS, for its swatch in the panel. */
export const swatch = (layer) => `#${layer.rgb.map((part) => Math.round(part * 255).toString(16).padStart(2, '0')).join('')}`;

// -- the view --------------------------------------------------------------

/** The room the board is fitted with, CSS pixels from each edge. */
export const FIT_MARGIN = 16;

/** The view that fits `bounds` (`{ minX, maxX, minY, maxY }`) into a canvas
 *  of `width` × `height`, centred, seen with `flip`. */
export function fitView(bounds, width, height, flip) {
  const across = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const down = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.max(Math.min((width - 2 * FIT_MARGIN) / across, (height - 2 * FIT_MARGIN) / down), 1e-6);
  return {
    scale,
    x: -flip * scale * (bounds.minX + bounds.maxX) / 2,
    y: scale * (bounds.minY + bounds.maxY) / 2,
  };
}

/** `view` zoomed by `factor` about the canvas point (`px`, `py`), which keeps
 *  the point of the board under it. */
export function zoomAt(view, px, py, width, height, factor) {
  const across = px - width / 2;
  const down = py - height / 2;
  return {
    scale: view.scale * factor,
    x: across - (across - view.x) * factor,
    y: down - (down - view.y) * factor,
  };
}

/** `view` moved by (`dx`, `dy`) CSS pixels. */
export const panBy = (view, dx, dy) => ({ ...view, x: view.x + dx, y: view.y + dy });

/** How much a pinch (a wheel event with Control held, which is how a touchpad
 *  pinch arrives) zooms: the factor is `exp(-deltaY · ZOOM_RATE)`, a line counting
 *  as 16 pixels, and one event moves `deltaY` by at most `ZOOM_STEP_MAX` so a
 *  notch of a mouse wheel under Control is a step, not a leap. */
const ZOOM_RATE = 0.01;
const ZOOM_STEP_MAX = 40;
const LINE_PX = 16;

/**
 * What a wheel event does to a flat drawing, the Gerbers and the KiCad
 * schematic and board alike: with Control held (a pinch, or Control and the
 * wheel) it zooms by `factor` about the pointer, else (the two-finger swipe
 * of a touchpad is a wheel event) the drawing follows the fingers by
 * (`dx`, `dy`) CSS pixels — a swipe up moves it up.
 */
export function wheelMove(event) {
  const unit = event.deltaMode === 1 ? LINE_PX : 1;
  if (event.ctrlKey) {
    const delta = Math.max(-ZOOM_STEP_MAX, Math.min(ZOOM_STEP_MAX, event.deltaY * unit));
    return { factor: Math.exp(-delta * ZOOM_RATE), dx: 0, dy: 0 };
  }
  return { factor: 1, dx: -event.deltaX * unit, dy: -event.deltaY * unit };
}

/** `view` with the board turned over about the canvas's vertical centre line. */
export const turned = (view) => ({ ...view, x: -view.x });

/** The canvas point, CSS pixels, the board point (`u`, `v`) lands on: the
 *  law in the header. */
export const canvasAt = (view, u, v, width, height, flip) => [
  width / 2 + flip * u * view.scale + view.x, height / 2 - v * view.scale + view.y];

/** The board point under the canvas point (`px`, `py`): `canvasAt` undone. */
export const boardAt = (view, px, py, width, height, flip) => [
  (px - width / 2 - view.x) / (flip * view.scale), (height / 2 + view.y - py) / view.scale];

/** The area of the board between two canvas points, as a comment stores it
 *  (SPEC 7A.1, `area`): `[x, y, w, h]` in the board's units, its corner of
 *  least x and least y — Gerber's y is up — and its size. */
export function boardArea(view, from, to, width, height, flip) {
  const [u1, v1] = boardAt(view, from[0], from[1], width, height, flip);
  const [u2, v2] = boardAt(view, to[0], to[1], width, height, flip);
  return [Math.min(u1, u2), Math.min(v1, v2), Math.abs(u2 - u1), Math.abs(v2 - v1)];
}

/** Where `area` (`boardArea`) lands on the canvas, `{ left, top, width,
 *  height }` in CSS pixels, from either side. */
export function canvasBox(view, [x, y, w, h], width, height, flip) {
  const [a, b] = canvasAt(view, x, y, width, height, flip);
  const [c, d] = canvasAt(view, x + w, y + h, width, height, flip);
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

/** `view` moved so the board point (`u`, `v`) is at the canvas's centre. */
export const centredOn = (view, u, v, flip) => ({ ...view, x: -flip * u * view.scale, y: v * view.scale });

/** The most characters a comment's `layer` may have: the hub's ceiling on a
 *  one-line field (`MAX_FIELD_CHARS` in src/records.py, held to it by
 *  tests/test_ui_source.py). */
export const LAYER_NOTE_CHARS = 200;

/** What a comment's `layer` says the board was seen as: the side, then the
 *  layers on screen as the panel lists them (`layers`, those `shown` and not
 *  `failed`), `top: F.Cu, F.Mask, Edge.Cuts`; cut to `LAYER_NOTE_CHARS`. */
export function layerNote(layers, shown, failed, side) {
  const note = `${side}: ${layers.filter((layer) => shown[layer.file] && !failed[layer.file])
    .map((layer) => layer.label).join(', ')}`;
  return note.length > LAYER_NOTE_CHARS ? `${note.slice(0, LAYER_NOTE_CHARS - 1)}…` : note;
}

/** The renderer's zoom and offset for `view` on a canvas of `width` × `height`. */
export function toProcessor(view, width, height, flip) {
  const unit = Math.min(width, height) / 2;
  return {
    zoomX: (flip * view.scale) / unit,
    zoomY: view.scale / unit,
    offsetX: view.x / unit,
    offsetY: -view.y / unit,
  };
}
