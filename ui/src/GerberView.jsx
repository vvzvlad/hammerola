// A board's Gerbers: the zip that goes to the fab (`gerbers` in
// render.DOCUMENT_TYPES), unpacked in the page and drawn layer by layer with
// the vendored renderer (static/_v/PROVENANCE.md). A look at what the fab
// gets, not a view of the board: KicadView.jsx draws the board from its design.
//
// What it reads of the zip and of each file, how the layers are stacked from
// either side, and the arithmetic of the view are gerber.js, where they are
// tested.
//
// THE RENDERER IS DRIVEN BELOW ITS FRONT END. The package's
// `createGerberRenderer` parses every layer again for each frame, which a drag
// cannot afford; its `GerberProcessor` keeps the parsed layers on the GPU and
// draws a frame from a list of layer ids, colours and blend modes. Gerber
// layers are drawn source-over in stack order (blend mode 1): the package's
// default, additive blending, turns four layers of copper white. A drill
// program is two layers to it: the hole's ring, drawn in the hole colour, and
// the hole, punched out to transparent (blend mode 2) after everything else,
// so the sheet under the canvas shows through. A plated hole's ring is the
// plating, 20 µm; an unplated hole has none — both the package's own defaults.
//
// THE PANEL, over the top left corner as on the board (PcbPanel.jsx): the
// side the board is seen from, which mirrors it and restacks the layers and
// shows that side's layers (`shownOn`), and an eye per layer. The zip itself
// is downloaded from the strip at the bottom of the page, as every document
// is (`DocFile`, viewlist.jsx) — whether or not this page can read it.
//
// THE CANVAS: a drag with the left button or a finger pans, so does a wheel
// (the two-finger swipe of a touchpad is one), a pinch or Control and the wheel
// zoom about the pointer (`wheelMove` in gerber.js), two fingers on a touch
// screen pinch, a double click and the bar's Fit fit the board again. Drawing
// is on demand, a frame when the view, the size or the layers change; the
// context keeps its drawing buffer, so the bar's Frame reads the canvas as it
// stands. Everything the renderer holds is freed on unmount, the WebGL context
// included: a page has few to give.
//
// COMMENTS (`comment`, handed by both pages: comments.jsx). With the page's
// Comment tool armed (`on`) a drag with the left button or a finger draws an
// area instead of panning, and a click is an area of no size; the area goes to
// the page (`onArea`) as the place of a comment: `[x, y, w, h]` in the
// Gerbers' own units (`boardArea`), and the side and the layers on screen
// (`layerNote`).
// The open comments and the draft on this zip (`marks`) stand over the canvas
// as their areas, dashed, with a marker at each centre, following the pan and
// the zoom; a click on a marker names its comment to the page (`onMarker`).
// A place the page asks to be shown (`focus`) is put at the centre of the
// canvas, and the page told (`onFocused`).
//
// Props:
//   url      the zip, fetched on mount
//   bytes    its size in bytes, what the bar under `Loading…` fills to
//            (loadbar.jsx)
//   onTools  told `{ fit, frame }` once the layers are drawn (DocumentView.jsx)
//   onReady  told once the zip has come in or failed to (DocumentView.jsx)
//   doc      the document the zip is, which a comment's place names
//   comment  the page's comments, as above, or none

import React from 'react';

import { CLICK_SLOP } from './BoardView3D.jsx';
import {
  boardArea, canvasBox, centredOn, fitView, HOLE_RING, layerNote, layersOf, loadGerberRenderer, panBy, readZip,
  shownOn, stacked, swatch, toProcessor, turned, wheelMove, zoomAt,
} from './gerber.js';
import { fetchBody, loadBar, meter, painted } from './loadbar.jsx';
import { CHEVRON } from './PcbPanel.jsx';
import {
  ELLIPSIS, eyeDot, eyeOuter, FILL, LAYER_LIST, LAYER_NAME, LAYER_PANEL, LAYER_PANEL_BODY,
  LAYER_PANEL_HEAD, LAYER_PILL, LAYER_PILLS, layerRow, SLOT_24, SWATCH, TAB_ON,
} from './panelstyle.js';
import { css, MONO } from './style.jsx';

// The canvas goes into HOLDER, which React renders empty and so never touches.
const SHELL = 'position:relative;width:100%;height:100%;overflow:hidden;background:var(--gerber-bg)';
const HOLDER = 'position:absolute;top:0;left:0;width:100%;height:100%';
const CANVAS = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab';
const NOTE = `position:absolute;top:0;left:0;right:0;box-sizing:border-box;padding:24px 28px;`
  + `font:400 12.5px ${MONO};color:var(--text-muted)`;
// The comments over the canvas: a layer that takes no pointer but on the
// markers, their areas and the area being drawn dashed, a marker round.
const MARKS = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
const MARKER_PX = 18;
const box = ({ left, top, width, height }) => `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
const markArea = (at, active) => `position:absolute;${box(at)};box-sizing:border-box;`
  + `border:1.5px dashed var(${active ? '--accent-strong' : '--accent'})`;
const marker = (at, active) => `position:absolute;left:${at.left + at.width / 2 - MARKER_PX / 2}px;`
  + `top:${at.top + at.height / 2 - MARKER_PX / 2}px;width:${MARKER_PX}px;height:${MARKER_PX}px;`
  + `box-sizing:border-box;border-radius:50%;border:2px solid var(--card-bg);`
  + `background:var(${active ? '--accent-strong' : '--accent'});pointer-events:auto;cursor:pointer`;

/** The sides the board is seen from, as the panel names them. */
const SIDES = [['top', 'Top'], ['bottom', 'Bottom']];

/** The width of a plated hole's ring, mm: the package's default plating. */
const PLATING_MM = 0.02;

const flipOf = (side) => (side === 'bottom' ? -1 : 1);

/** The renderer's layers on one canvas: the WebGL half of the view.
 *  `handlers`: `onBand`, told the area being drawn in comment mode as its two
 *  canvas points, and null when it is done; `onArea`, the area drawn
 *  (`boardArea`); `onDraw`, told after each frame. */
class Stage {
  constructor(lib, host, layers, handlers = {}) {
    this.host = host;
    this.layers = layers;
    this.handlers = handlers;
    this.side = 'top';
    this.shown = {};
    this.frame = 0;
    this.pointers = new Map();
    // Comment mode, and the area a pointer is drawing in it: `{ id, from, to }`.
    this.commenting = false;
    this.band = null;

    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('style', CANVAS);
    host.append(this.canvas);
    this.gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!this.gl) throw new Error('this browser has no WebGL2');
    this.measure();
    this.processor = new lib.GerberProcessor();
    this.processor.init(this.gl);
    this.processor.set_anti_aliasing(true);

    // Each layer parsed once: a Gerber layer is one id, a drill program a
    // ring and a hole. A file the renderer refuses is named in `failed`.
    this.ids = new Map();
    this.failed = {};
    let all = null;
    let outline = null;
    for (const layer of layers) {
      try {
        let ids;
        let box;
        if (layer.excellon) {
          const added = this.processor.add_drill_layer(layer.text);
          ids = { ring: added.outlineLayerId, hole: added.fillLayerId };
          this.processor.set_layer_inner_outline(ids.ring, 0, layer.plated ? PLATING_MM : 0);
          box = this.boundsOf(ids.ring);
        } else {
          ids = { layer: this.processor.add_layer(layer.text) };
          box = this.boundsOf(ids.layer);
        }
        this.ids.set(layer.file, ids);
        all = merged(all, box);
        if (layer.kind === 'profile') outline = merged(outline, box);
      } catch (error) {
        this.failed[layer.file] = String((error && error.message) || error);
      }
    }
    // The board is fitted by its outline, or by everything there is.
    this.bounds = outline || all || { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    this.fit();

    this.bind();
    // A holder with no size yet is fitted when it gets one.
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (!this.measure()) return;
      if (this.fitted) this.request();
      else this.fit();
    }) : null;
    if (this.observer) this.observer.observe(host);
  }

  boundsOf(id) {
    const boundary = this.processor.get_layer_boundary(id);
    const box = { minX: boundary.min_x, maxX: boundary.max_x, minY: boundary.min_y, maxY: boundary.max_y };
    boundary.free();
    return [box.minX, box.maxX, box.minY, box.maxY].every(Number.isFinite) ? box : null;
  }

  /** The canvas sized to its holder, in device pixels. False while it has no size. */
  measure() {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return false;
    const ratio = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    if (this.processor) this.processor.resize();
    return true;
  }

  fit() {
    this.fitted = Boolean(this.width);
    this.view = fitView(this.bounds, this.width || 1, this.height || 1, flipOf(this.side));
    this.request();
  }

  /** The canvas point of a pointer event, CSS pixels. */
  at(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  bind() {
    const { canvas } = this;
    // A mouse drags with its left button only: the right one opens the
    // browser's menu, and its release lands on that menu, not on the canvas.
    // In comment mode the first pointer down draws an area instead.
    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      if (this.commenting && !this.pointers.size && !this.band) {
        this.band = { id: event.pointerId, from: this.at(event), to: this.at(event) };
        this.handlers.onBand(this.band);
        return;
      }
      this.pointers.set(event.pointerId, this.at(event));
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.band && this.band.id === event.pointerId) {
        this.band = event.buttons ? { ...this.band, to: this.at(event) } : null;
        this.handlers.onBand(this.band);
        return;
      }
      const was = this.pointers.get(event.pointerId);
      if (!was) return;
      // A move with nothing pressed is a press whose release went elsewhere
      // (another window, a menu): that drag is over.
      if (!event.buttons) {
        this.pointers.delete(event.pointerId);
        return;
      }
      const now = this.at(event);
      if (this.pointers.size === 1) {
        this.view = panBy(this.view, now[0] - was[0], now[1] - was[1]);
      } else if (this.pointers.size === 2) {
        // A pinch: zoomed about the two fingers' midpoint by how far apart
        // they moved, then moved with the midpoint.
        const other = [...this.pointers].find(([id]) => id !== event.pointerId)[1];
        const before = Math.hypot(was[0] - other[0], was[1] - other[1]);
        const after = Math.hypot(now[0] - other[0], now[1] - other[1]);
        const from = [(was[0] + other[0]) / 2, (was[1] + other[1]) / 2];
        const to = [(now[0] + other[0]) / 2, (now[1] + other[1]) / 2];
        const zoomed = before > 0 ? zoomAt(this.view, from[0], from[1], this.width, this.height, after / before) : this.view;
        this.view = panBy(zoomed, to[0] - from[0], to[1] - from[1]);
      }
      this.pointers.set(event.pointerId, now);
      this.request();
    });
    // The area drawn ends with its pointer's release, a release within
    // `CLICK_SLOP` of the press being a click: an area of no size there.
    const up = (event) => {
      const { band } = this;
      if (band && band.id === event.pointerId) {
        this.band = null;
        this.handlers.onBand(null);
        const to = this.at(event);
        const click = Math.hypot(to[0] - band.from[0], to[1] - band.from[1]) <= CLICK_SLOP;
        if (event.type === 'pointerup') {
          this.handlers.onArea(boardArea(this.view, band.from, click ? band.from : to, this.width, this.height,
            flipOf(this.side)));
        }
        return;
      }
      this.pointers.delete(event.pointerId);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const move = wheelMove(event);
      if (event.ctrlKey) {
        const [px, py] = this.at(event);
        this.view = zoomAt(this.view, px, py, this.width, this.height, move.factor);
      } else {
        this.view = panBy(this.view, move.dx, move.dy);
      }
      this.request();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => this.fit());
  }

  /** What the canvas holds, as a PNG blob. Read as it stands: the context
   *  keeps its drawing buffer. Not `frame`, which is the handle of the frame
   *  asked for. */
  snapshot() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /** The board point (`u`, `v`) put at the centre of the canvas. */
  centre(u, v) {
    this.view = centredOn(this.view, u, v, flipOf(this.side));
    this.request();
  }

  /** The layers drawn and the side they are seen from. */
  show(shown, side) {
    if (side !== this.side) this.view = turned(this.view);
    this.side = side;
    this.shown = shown;
    this.request();
  }

  request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    if (!this.width) return;
    const ids = [];
    const colours = [];
    const modes = [];
    const add = (id, rgb, alpha, mode) => {
      ids.push(id);
      colours.push(...rgb, alpha);
      modes.push(mode);
    };
    const holes = [];
    for (const layer of stacked(this.layers, this.side)) {
      const parsed = this.ids.get(layer.file);
      if (!parsed || !this.shown[layer.file]) continue;
      if (parsed.layer === undefined) holes.push([layer, parsed]);
      else add(parsed.layer, layer.rgb, layer.alpha, 1);
    }
    for (const [layer, parsed] of holes) if (layer.plated) add(parsed.ring, HOLE_RING, 1, 1);
    for (const [, parsed] of holes) add(parsed.hole, [0, 0, 0], 1, 2);
    const view = toProcessor(this.view, this.width, this.height, flipOf(this.side));
    this.processor.render_with_clear_and_blend_modes(
      new Uint32Array(ids), new Float32Array(colours), new Uint8Array(modes),
      view.zoomX, view.zoomY, view.offsetX, view.offsetY, 1, true,
    );
    if (this.handlers.onDraw) this.handlers.onDraw();
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.observer) this.observer.disconnect();
    this.processor.free();
    const lose = this.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    this.canvas.remove();
  }
}

/** Two boxes as one; either may be null. */
function merged(a, b) {
  if (!a || !b) return a || b;
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Each layer's visibility as the board is first seen from `side`. */
const shownFrom = (layers, side) => Object.fromEntries(layers.map((layer) => [layer.file, shownOn(layer, side)]));

/** The Gerbers of one zip. */
export default class GerberView extends React.Component {
  constructor(props) {
    super(props);
    // `received`: the bytes of the zip in so far; `got`: all of them, the
    // layers being read.
    // `band`: the two canvas points of the area being drawn in comment mode.
    this.state = {
      layers: null, failed: {}, shown: {}, side: 'top', open: true, error: '', received: 0, got: false, band: null,
    };
    this.host = null;
    this.stage = null;
    // The page's focus last put on screen.
    this.focused = null;
    this.setHost = (element) => {
      this.host = element;
    };
    this.toggle = () => this.setState({ open: !this.state.open });
    // What the page's bar does with this view (`onTools` in DocumentView.jsx).
    this.tools = { fit: () => this.stage.fit(), frame: () => this.frame() };
    // What the stage tells this view (`Stage`): the marks follow each frame.
    this.handlers = {
      onBand: (band) => this.setState({ band }),
      onArea: (area) => this.area(area),
      onDraw: () => {
        if (this.marks().length) this.forceUpdate();
      },
    };
  }

  /** The open comments and the draft on this zip (`comment.marks`). */
  marks() {
    const { comment, doc } = this.props;
    return ((comment && comment.marks) || []).filter((one) => doc && one.doc === doc.file && Array.isArray(one.area));
  }

  /** The frame as a PNG blob: the canvas with the marks drawn on it as they
   *  stand over it. The marks are elements over the canvas, not in it, and a
   *  comment's frame (its `shot`) has to show the area it is about, as the
   *  schematic's and the board's do, whose markers are in their canvas. */
  frame() {
    const { stage } = this;
    const marks = this.marks();
    if (!marks.length) return stage.snapshot();
    const out = document.createElement('canvas');
    out.width = stage.canvas.width;
    out.height = stage.canvas.height;
    const pen = out.getContext('2d');
    pen.drawImage(stage.canvas, 0, 0);
    // Canvas pixels per CSS pixel, which is what `canvasBox` answers in.
    const k = stage.canvas.width / stage.width;
    const style = getComputedStyle(this.host);
    const ink = (name) => style.getPropertyValue(name).trim();
    for (const mark of marks) {
      const at = canvasBox(stage.view, mark.area, stage.width, stage.height, flipOf(stage.side));
      const accent = ink(mark.active ? '--accent-strong' : '--accent');
      pen.setLineDash([4 * k, 3 * k]);
      pen.lineWidth = 1.5 * k;
      pen.strokeStyle = accent;
      pen.strokeRect(at.left * k, at.top * k, at.width * k, at.height * k);
      pen.setLineDash([]);
      pen.beginPath();
      // The ring's 2 px inside the marker's 18, as `border-box` draws it on
      // screen: a stroke is centred on its line.
      pen.arc((at.left + at.width / 2) * k, (at.top + at.height / 2) * k, (MARKER_PX / 2 - 1) * k, 0, 2 * Math.PI);
      pen.fillStyle = accent;
      pen.fill();
      pen.lineWidth = 2 * k;
      pen.strokeStyle = ink('--card-bg');
      pen.stroke();
    }
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  /** An area drawn in comment mode, handed to the page with what was on
   *  screen. */
  area(area) {
    const { comment, doc } = this.props;
    const { layers, shown, failed, side } = this.state;
    if (comment && doc) comment.onArea(doc, { frame: 'board', area, layer: layerNote(layers || [], shown, failed, side) });
  }

  /** The stage in line with `comment`: comment mode and its cursor while the
   *  tool is armed, and a focus on this zip not yet shown put at the centre. */
  comments() {
    const { comment, doc } = this.props;
    const { stage } = this;
    if (!stage) return;
    stage.commenting = Boolean(comment && comment.on);
    stage.canvas.style.cursor = stage.commenting ? 'crosshair' : 'grab';
    const focus = comment && comment.focus;
    if (focus && focus !== this.focused && doc && focus.doc === doc.file && Array.isArray(focus.area)) {
      this.focused = focus;
      const [x, y, w, h] = focus.area;
      stage.centre(x + w / 2, y + h / 2);
      comment.onFocused();
    }
  }

  componentDidMount() {
    const { url } = this.props;
    const count = meter((received) => {
      if (!this._gone) this.setState({ received });
    });
    // The full bar is painted before the zip is read.
    const zip = fetchBody(url, count).then((buffer) => {
      if (!this._gone) {
        this.setState({ got: true });
        this.props.onReady();
      }
      return painted().then(() => readZip(buffer));
    }, (error) => {
      if (!this._gone) this.props.onReady();
      throw error;
    });
    Promise.all([loadGerberRenderer(), zip])
      .then(([lib, files]) => {
        if (this._gone || !this.host) return;
        const layers = layersOf(files);
        if (!layers.length) throw new Error('the zip holds no Gerber or drill file');
        this.stage = new Stage(lib, this.host, layers, this.handlers);
        const shown = shownFrom(layers, 'top');
        this.stage.show(shown, 'top');
        // The panel lists the board from its top down, whichever side is shown.
        this.setState({ layers: stacked(layers, 'top').reverse(), failed: this.stage.failed, shown });
        this.props.onTools(this.tools);
        this.comments();
      })
      .catch((error) => {
        if (!this._gone) this.setState({ error: `The Gerbers did not load: ${(error && error.message) || error}` });
      });
  }

  componentDidUpdate(prev, before) {
    const { shown, side } = this.state;
    if (this.stage && (shown !== before.shown || side !== before.side)) this.stage.show(shown, side);
    this.comments();
  }

  componentWillUnmount() {
    this._gone = true;
    if (this.stage) this.stage.dispose();
    this.stage = null;
  }

  /** Layer `file` shown if it was hidden, hidden if it was shown. From the
   *  state as it stands, so two clicks inside one render both land. */
  flip(file) {
    this.setState((state) => ({ shown: { ...state.shown, [file]: !state.shown[file] } }));
  }

  /** The board turned to `side`, with that side's layers shown. */
  turn(side) {
    if (side !== this.state.side) this.setState({ side, shown: shownFrom(this.state.layers, side) });
  }

  render() {
    const { bytes, comment } = this.props;
    const { layers, failed, shown, side, open, error, received, got, band } = this.state;
    const note = error || (!layers && loadBar(received, bytes, got));
    const { stage } = this;
    // Where an area lands on the canvas as the stage's view stands.
    const at = (area) => canvasBox(stage.view, area, stage.width, stage.height, flipOf(stage.side));
    return (
      <div style={css(SHELL)}>
        <div ref={this.setHost} style={css(HOLDER)} />
        {note && <div style={css(NOTE)}>{note}</div>}
        {Boolean(stage && stage.width) && (
          <div data-marks="gerbers" style={css(MARKS)}>
            {this.marks().map((mark) => (
              <React.Fragment key={mark.id}>
                <div style={css(markArea(at(mark.area), mark.active))} />
                <div data-mark={mark.id} style={css(marker(at(mark.area), mark.active))}
                     onClick={() => comment.onMarker(mark.id)} />
              </React.Fragment>
            ))}
            {band && (
              <div style={css(markArea({
                left: Math.min(band.from[0], band.to[0]), top: Math.min(band.from[1], band.to[1]),
                width: Math.abs(band.to[0] - band.from[0]), height: Math.abs(band.to[1] - band.from[1]),
              }, true))} />
            )}
          </div>
        )}
        {layers && (
          <div data-panel="gerbers" style={css(LAYER_PANEL)}>
            <div onClick={this.toggle} title={open ? 'Hide the layers' : 'Show the layers'} style={css(LAYER_PANEL_HEAD)}>
              {CHEVRON(open)}
              <span style={css(FILL)}>Layers</span>
            </div>
            {open && (
              <div style={css(LAYER_PANEL_BODY)}>
                <div style={css(LAYER_PILLS)}>
                  {SIDES.map(([one, label]) => (
                    <div key={one} data-side={one} onClick={() => this.turn(one)}
                         title={`The board seen from the ${one}`}
                         style={css(LAYER_PILL + (one === side ? `;${TAB_ON}` : ''))}>{label}</div>
                  ))}
                </div>
                <div style={css(LAYER_LIST)}>
                  {layers.map((layer) => {
                    const broken = failed[layer.file];
                    const on = !broken && shown[layer.file];
                    return (
                      <div key={layer.file} data-layer={layer.file} style={css(layerRow(false))}
                           title={broken ? `${layer.file}: ${broken}` : layer.file}
                           onClick={() => !broken && this.flip(layer.file)}>
                        <span data-eye={layer.file} style={css(SLOT_24)}>
                          <span style={css(eyeOuter(on ? 'on' : 'off'))}>
                            <span style={css(eyeDot(on ? 'on' : 'off'))} />
                          </span>
                        </span>
                        <span style={css(LAYER_NAME + (on ? '' : ';color:var(--text-faint)'))}>
                          <span style={css(SWATCH + swatch(layer) + (on ? '' : ';opacity:.35'))} />
                          <span style={css(ELLIPSIS)}>{layer.label}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
}
