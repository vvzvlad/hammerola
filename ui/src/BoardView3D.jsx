// The 3D model of a board: the `.glb` KiCad exports, drawn with three. The third
// view of a KiCad design (KicadView.jsx), which keeps it mounted beside the
// schematic and the board and tells it whether it is the one on screen
// (`active`) and which part the design has selected (`selected`).
//
// What it reads of the model — which node is a part and by what designator, and
// how the loader's meshes are merged — is board3d.js, where it is tested.
//
// Props:
//   url       the `.glb`, fetched the first time the view is on screen, so a
//             design opened on its schematic costs nothing until it is looked at
//   bytes     its size, what the bar under `Loading…` fills to (loadbar.jsx)
//   active    on screen: only then is anything drawn
//   selected  a designator or null: that part is lit and the camera moves to it;
//             null puts it out. Never reported back through `onSelect`
//   onSelect  a click: the designator of the part under the pointer, or null
//   onMenu    a right click on a part, which selects it as a click does: its
//             designator and the pointer's page point (`clientX`, `clientY`)
//   onTools   told `{ fit, frame }` once the model is drawn: what the page's
//             bar does with this view (DocumentView.jsx)
//   onFetched told each time the `.glb` has come in or failed to: KicadView.jsx
//             holds the design's other files back for it
//   comment   the model page's comments on this model (KicadView.jsx), or none:
//             `on`, the page's Comment tool armed here, so that a left click
//             on a part is the place of a comment (`onPoint` with `partPlace`
//             of board3d.js: the designator, and the point and the normal in
//             the part's own frame) and selects nothing; `marks`, the open
//             comments and the draft, `{ id, part, point, normal, active }`,
//             each an arrow on its part as the model's page draws one
//             (`arrowKit` in viewport/pins.js), as long against the board as
//             that one is against the model (`PIN_LENGTH_FRACTION`), a left
//             click on it named back (`onMarker`), the ids of those whose
//             part the model has none of told (`onLost`) as that changes;
//             `focus`, a part to frame, which then is told done (`onFocused`)
//
// THE BOARD IS DRIVEN AS THE MODEL IS. The camera is turned by the model's own
// trackball (`CADTrackballControls`, board3d.js) at the model's speeds: a left
// drag turns it without tumbling it, a right drag pans, a middle drag zooms.
// The WHEEL is the model page's second layer (ui/src/viewport/wheel.js and
// zoom.js), which is written for that page's orthographic camera and so could
// not simply be reached for: a two-finger swipe moves the board under the
// fingers, a pinch — a wheel event with Control held — and Control and the
// wheel zoom about the pointer, by the arithmetic the Gerbers' view uses
// (`wheelMove` in gerber.js). The trackball's own wheel zooms to the centre off
// `deltaY` alone, so the event is taken on its way down, on the holder, before
// the canvas it listens on (`Stage.wheel`).
//
// Drawing is on demand — a frame when the camera, the size or the selection
// changes, none while the view is hidden. Everything three holds is freed on
// unmount, the WebGL context included: a page has few of them to give.

import React from 'react';

import {
  disposeModel, exportRoot, frameBox, fromPart, light, loadThree, mergeByMaterial, partPlace, partsOf, pickedPart,
  plainColours, sharedGeometries,
} from './board3d.js';
import { wheelMove } from './gerber.js';
import { fetchBody, loadBar, meter, painted } from './loadbar.jsx';
import { css, MONO } from './style.jsx';
import { PIN_LENGTH_FRACTION, PIN_PX } from './viewport/options.js';
import { arrowKit, pinDirection } from './viewport/pins.js';

// The page's 3D canvas colour behind a transparent canvas, so the view follows
// the theme. The canvas goes into HOLDER, which React renders empty and so never
// touches; its `color` is the selection's, read back when a part is lit.
const SHELL = 'position:relative;width:100%;height:100%;overflow:hidden;background:var(--canvas-bg)';
const HOLDER = 'position:absolute;top:0;left:0;width:100%;height:100%;color:var(--accent)';
const CANVAS = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;outline:none';
const NOTE = `position:absolute;top:0;left:0;padding:24px 28px;font:400 12.5px ${MONO};color:var(--text-muted)`;

/** The vertical field of view, degrees. */
const FOV = 35;
/** The board is first seen from above, tilted toward the viewer by 30°: glTF
 *  is Y-up, and KiCad's +Y (down on the board as drawn) is the model's +Z. */
const FIRST_VIEW = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
/** The board's bounding sphere is loose round a flat board seen tilted, so the
 *  first view frames a little less than all of it. */
const BOARD_MARGIN = 0.85;
/** How much room a framed part gets around it, and at least what share of the
 *  board, so a 0402 still shows its neighbours. */
const PART_MARGIN = 2.5;
const PART_LEAST = 1 / 10;
/** How far a pointer may move between press and release and still click; the
 *  controls turn with a left drag and pan with a right one. */
export const CLICK_SLOP = 4;
/** The trackball's speeds as the model's page has them: the library's
 *  defaults, 1.0 each, times its factors for a trackball (`SPEED_FACTORS` in
 *  viewer/src/camera/controls.ts, multiplied in by `_applySpeedFactors`). */
export const TRACKBALL_SPEEDS = { rotateSpeed: 1.0, zoomSpeed: 2.0, panSpeed: 0.22 };
/** Up in glTF, which a comment's arrow with no normal comes down from. */
const GLTF_UP = [0, 1, 0];

/** One loaded model on its canvas: the WebGL half of the view. */
class Stage {
  constructor(lib, host, gltf, handlers) {
    const { THREE, TrackballControls, mergeGeometries } = lib;
    this.THREE = THREE;
    this.host = host;
    this.handlers = handlers;
    this.active = false;
    this.selected = null;
    this.frame = 0;

    this.model = gltf.scene;
    plainColours(this.model, gltf.parser);
    this.root = exportRoot(this.model);
    const shared = sharedGeometries(this.root);
    for (const node of [...this.root.children]) mergeByMaterial(THREE, mergeGeometries, node, shared);
    this.parts = partsOf(this.model);
    this.box = new THREE.Box3().setFromObject(this.model);
    this.radius = this.box.getBoundingSphere(new THREE.Sphere()).radius || 1;

    this.scene = new THREE.Scene();
    this.scene.add(this.model);
    // The comments' arrows, beside the model so they are neither in its box
    // nor among its parts; the comment each node is (`setMarks`).
    this.kit = arrowKit(THREE);
    this.pins = new THREE.Object3D();
    this.scene.add(this.pins);
    this.arrows = new Map();
    this.arrowLength = (PIN_LENGTH_FRACTION * this.box.getSize(new THREE.Vector3()).length()) / 2;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, this.radius / 100, this.radius * 100);
    this.scene.add(this.camera);
    // Two directional lights: one fixed above the board, one riding with the
    // camera from its upper left, so a face turned to the viewer is never flat.
    this.scene.add(new THREE.AmbientLight(undefined, 1.2));
    const above = new THREE.DirectionalLight(undefined, 1.2);
    above.position.set(0, 1, 0);
    this.scene.add(above);
    const head = new THREE.DirectionalLight(undefined, 1.8);
    head.position.set(-1, 1, 0);
    head.target.position.set(0, 0, -1);
    this.camera.add(head, head.target);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    const canvas = this.renderer.domElement;
    canvas.setAttribute('style', CANVAS);
    host.append(canvas);

    // The model's trackball, with the model's speeds. It moves the camera from
    // its own pointer handlers and says `change` each time, so it needs no
    // frame of its own.
    this.controls = new TrackballControls(this.camera, canvas);
    Object.assign(this.controls, TRACKBALL_SPEEDS);
    this.controls.addEventListener('change', () => this.request());

    // THE WHEEL IS OURS, and it is taken here rather than on the canvas: the
    // trackball listens on the canvas itself, and two listeners on one element
    // run in the order they were added, so only an ancestor's capture listener
    // can be sure of coming first.
    this.onWheel = (event) => this.wheel(event);
    host.addEventListener('wheel', this.onWheel, { capture: true, passive: false });

    // A click with the left button or the right one: `[button, x, y]` of the
    // press. The right one selects as the left does and opens the menu too.
    // A left one on a comment's arrow names it, and with the Comment tool
    // armed one on a part is a comment's place, selecting nothing; what is
    // nearest decides, so a part in front of an arrow hides it.
    this.raycaster = new THREE.Raycaster();
    this.down = null;
    canvas.addEventListener('pointerdown', (event) => {
      this.down = event.button === 0 || event.button === 2 ? [event.button, event.clientX, event.clientY] : null;
    });
    canvas.addEventListener('pointerup', (event) => {
      const down = this.down;
      this.down = null;
      if (!down || event.button !== down[0]
        || Math.hypot(event.clientX - down[1], event.clientY - down[2]) > CLICK_SLOP) return;
      if (down[0] === 0) {
        this.aim(event);
        const [hit] = this.raycaster.intersectObjects([this.root, this.pins], true);
        const mark = hit ? this.markOf(hit.object) : null;
        if (mark !== null) {
          this.handlers.onMarker(mark);
          return;
        }
        if (this.handlers.commenting()) {
          const place = hit && partPlace(THREE, hit, this.root, this.raycaster.ray.direction);
          if (place) this.handlers.onPoint(place);
          return;
        }
      }
      const part = this.pick(event);
      this.select(part, false);
      this.handlers.onSelect(part);
      if (part && down[0] === 2) this.handlers.onMenu(part, event.clientX, event.clientY);
    });

    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    if (this.observer) this.observer.observe(host);
    this.resize();
    this.fit();
  }

  /** Whether the view is on screen: a frame is drawn only while it is. */
  setActive(active) {
    this.active = active;
    this.controls.enabled = active;
    if (active) {
      this.resize();
      this.request();
    } else if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  /** Ask for a frame, drawn on the next animation frame if the view is on screen. */
  request() {
    if (!this.active || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    // The depth range follows the camera, so a close look at a 0402 keeps its
    // precision. Silkscreen lies 40 µm over the copper: with near at a hundredth
    // of the distance to what is looked at, a whole board seen from 30 cm lost
    // its far half's silkscreen under the copper; a twentieth keeps it.
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = distance / 20;
    this.camera.far = distance + this.radius * 4;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // The trackball measures a drag against the canvas's box, which it keeps.
    this.controls.handleResize();
    this.request();
  }

  /** The camera onto `box`, along `direction`, with `margin` and at least `least`.
   *  Turned to it here: the trackball sets the camera's turn itself and leaves
   *  it as it was on `update`. `lookAt` builds the turn from `camera.up`, so
   *  this also takes a roll a trackball drag has wound in — which is why the
   *  part framing of a selection arrives upright too. */
  look(box, direction, margin, least) {
    const { target, position } = frameBox(this.THREE, box, direction, FOV, this.camera.aspect, margin, least);
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.camera.lookAt(target);
    this.controls.update();
    this.request();
  }

  /** The board as it was first seen: the bar's Fit. Upright again too, as a
   *  drag on the trackball may have rolled it. */
  fit() {
    this.camera.up.set(0, 1, 0);
    this.look(this.box, new this.THREE.Vector3(...FIRST_VIEW), BOARD_MARGIN, 0);
  }

  /** The frame on screen as a PNG blob: drawn now and read in the same task,
   *  before the context, which keeps no drawing buffer, hands it to the screen.
   *  Not `frame`, which is the handle of the frame asked for. */
  snapshot() {
    this.draw();
    return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
  }

  /**
   * A wheel event over the view, taken before the trackball's own handler: a
   * two-finger swipe moves the board under the fingers, a pinch or Control and
   * the wheel zoom about the pointer (`wheelMove` says by how much).
   *
   * The camera is PERSPECTIVE, so a CSS pixel is worth `2·tan(FOV/2)·distance /
   * height` of world at the distance the camera is looking, and that plane is
   * also where the point under the pointer is taken: its offset from the target
   * is the camera's screen axes times the pointer's place in the frame. Moving
   * the camera and the target together by `(1 − scale)` of that offset while
   * the eye shrinks by `scale` leaves the point under the pointer exactly where
   * it was — the orthographic page's law (viewport/zoom.js), with the depth it
   * is exact at being the target's.
   */
  wheel(event) {
    event.preventDefault();
    event.stopPropagation();
    const box = this.renderer.domElement.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const { camera, controls } = this;
    const eye = camera.position.clone().sub(controls.target);
    const halfUp = eye.length() * Math.tan((FOV / 2) * (Math.PI / 180));
    const right = new this.THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new this.THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const move = wheelMove(event);
    if (event.ctrlKey) {
      const across = ((event.clientX - box.left) / box.width) * 2 - 1;
      const down = ((event.clientY - box.top) / box.height) * 2 - 1;
      const off = right.multiplyScalar(across * halfUp * camera.aspect)
        .add(up.multiplyScalar(-down * halfUp));
      const scale = 1 / move.factor;
      controls.target.add(off.multiplyScalar(1 - scale));
      camera.position.copy(controls.target).add(eye.multiplyScalar(scale));
    } else {
      // The board follows the fingers, so the camera and what it looks at go
      // the other way, both by the same vector: a swipe pans, it does not turn.
      const perPixel = (2 * halfUp) / box.height;
      const moved = right.multiplyScalar(-move.dx * perPixel).add(up.multiplyScalar(move.dy * perPixel));
      camera.position.add(moved);
      controls.target.add(moved);
    }
    camera.updateMatrixWorld();
    this.request();
  }

  /** The raycaster through the point of a pointer event. */
  aim(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const at = new this.THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(at, this.camera);
  }

  /** The designator of the part under a pointer event, or null. */
  pick(event) {
    this.aim(event);
    return pickedPart(this.raycaster.intersectObject(this.root, true), this.root);
  }

  /** The id of the comment whose arrow `object` is part of, or null. */
  markOf(object) {
    for (let node = object; node; node = node.parent) {
      if (this.arrows.has(node)) return this.arrows.get(node);
    }
    return null;
  }

  /** The arrows of `marks` (see the header), each standing on the first
   *  node of its part, its point and normal put in the world through it
   *  (`fromPart`); the ids of those whose part the model has none of. */
  setMarks(marks) {
    const { THREE } = this;
    for (const node of this.arrows.keys()) this.pins.remove(node);
    this.arrows.clear();
    const lost = [];
    const y = new THREE.Vector3(0, 1, 0);
    for (const mark of marks) {
      const nodes = this.parts.get(mark.part);
      if (!nodes || !Array.isArray(mark.point)) {
        lost.push(mark.id);
        continue;
      }
      const { p, n } = fromPart(THREE, nodes[0], mark.point, mark.normal);
      const arrow = this.kit.arrow();
      this.kit.paint(arrow, Boolean(mark.active));
      arrow.node.position.copy(p);
      arrow.node.quaternion.setFromUnitVectors(y, new THREE.Vector3(...pinDirection(n && n.toArray(), GLTF_UP)));
      arrow.node.scale.setScalar(this.arrowLength / PIN_PX);
      this.pins.add(arrow.node);
      this.arrows.set(arrow.node, mark.id);
    }
    this.request();
    return lost;
  }

  /** The camera onto the part `designator`, if the model has it, from the
   *  side it looks from now. */
  framePart(designator) {
    const nodes = designator && this.parts.get(designator);
    if (!nodes) return;
    const box = new this.THREE.Box3();
    for (const node of nodes) box.expandByObject(node);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.look(box, direction, PART_MARGIN, this.radius * PART_LEAST);
  }

  /** Light the part `designator` (null: none), the camera moving to it when
   *  `frame` is set. A designator the model has no part for lights nothing. */
  select(designator, frame) {
    if (designator === this.selected) return;
    if (this.selected) light(this.parts.get(this.selected) || [], null);
    this.selected = designator;
    const nodes = designator && this.parts.get(designator);
    if (nodes) {
      light(nodes, new this.THREE.Color().setStyle(window.getComputedStyle(this.host).color));
      if (frame) this.framePart(designator);
    }
    this.request();
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.observer) this.observer.disconnect();
    this.host.removeEventListener('wheel', this.onWheel, true);
    this.controls.dispose();
    this.kit.dispose();
    disposeModel(this.model);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

/** The 3D view of a board. */
export default class BoardView3D extends React.Component {
  constructor(props) {
    super(props);
    // `received`: the bytes of the `.glb` in so far; `got`: all of them, the
    // model being built.
    this.state = { loading: false, error: '', received: 0, got: false };
    this.host = null;
    this.stage = null;
    this.setHost = (element) => {
      this.host = element;
    };
    // What the page's bar does with this view (`onTools`).
    this.tools = { fit: () => this.stage.fit(), frame: () => this.stage.snapshot() };
  }

  componentDidMount() {
    this.follow({});
  }

  componentDidUpdate(prev) {
    this.follow(prev);
  }

  componentWillUnmount() {
    this._gone = true;
    if (this.stage) this.stage.dispose();
    this.stage = null;
  }

  /** Bring the stage in line with the props: load on first showing (and again
   *  on showing after a failure), then the selection, whether it draws, and
   *  the comments. */
  follow(prev) {
    const { active, selected } = this.props;
    const shown = active && !prev.active;
    if (!this.stage && !this.loading && active && (!this.state.error || shown)) this.load();
    if (!this.stage) return;
    this.stage.select(selected || null, true);
    if (active !== prev.active) this.stage.setActive(active);
    this.comments();
  }

  /** The stage in line with `comment` (see the header): its arrows, rebuilt
   *  only when the marks changed, the lost ones told only when they changed;
   *  a focus not yet framed; and a crosshair while the tool is armed. */
  comments() {
    const { comment } = this.props;
    const marks = (comment && comment.marks) || [];
    const key = JSON.stringify(marks);
    if (key !== this.marked) {
      this.marked = key;
      const lost = JSON.stringify(this.stage.setMarks(marks));
      if (comment && lost !== this.lost) {
        this.lost = lost;
        comment.onLost(JSON.parse(lost));
      }
    }
    const focus = comment && comment.focus;
    if (focus && focus !== this.focused) {
      this.focused = focus;
      this.stage.framePart(focus.part);
      comment.onFocused();
    }
    this.stage.renderer.domElement.style.cursor = comment && comment.on ? 'crosshair' : '';
  }

  load() {
    const { url } = this.props;
    this.loading = true;
    this.setState({ loading: true, error: '', received: 0, got: false });
    const count = meter((received) => {
      if (!this._gone) this.setState({ received });
    });
    // In or failed, the parent hears it before the model is built, and the full
    // bar is painted before the model is read.
    const model = fetchBody(url, count).then((buffer) => {
      if (!this._gone) {
        this.setState({ got: true });
        this.props.onFetched();
      }
      return painted().then(() => buffer);
    }, (error) => {
      if (!this._gone) this.props.onFetched();
      throw error;
    });
    Promise.all([loadThree(), model])
      .then(([lib, buffer]) => new lib.GLTFLoader().parseAsync(buffer, '').then((gltf) => [lib, gltf]))
      .then(([lib, gltf]) => {
        this.loading = false;
        if (this._gone || !this.host) {
          disposeModel(gltf.scene);
          return;
        }
        this.stage = new Stage(lib, this.host, gltf, {
          onSelect: (designator) => this.props.onSelect && this.props.onSelect(designator),
          onMenu: (designator, x, y) => this.props.onMenu && this.props.onMenu(designator, x, y),
          commenting: () => Boolean(this.props.comment && this.props.comment.on),
          onPoint: (place) => this.props.comment && this.props.comment.onPoint(place),
          onMarker: (id) => this.props.comment && this.props.comment.onMarker(id),
        });
        this.stage.select(this.props.selected || null, true);
        this.stage.setActive(Boolean(this.props.active));
        this.comments();
        this.setState({ loading: false });
        this.props.onTools(this.tools);
      })
      .catch((error) => {
        this.loading = false;
        if (!this._gone) this.setState({ loading: false, error: `The 3D model did not load: ${error.message || error}` });
      });
  }

  render() {
    const { loading, error, received, got } = this.state;
    const note = error || (loading && loadBar(received, this.props.bytes, got));
    return (
      <div style={css(SHELL)}>
        <div ref={this.setHost} style={css(HOLDER)} />
        {note && <div style={css(NOTE)}>{note}</div>}
      </div>
    );
  }
}
