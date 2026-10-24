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
//   active    on screen: only then is anything drawn
//   selected  a designator or null: that part is lit and the camera moves to it;
//             null puts it out. Never reported back through `onSelect`
//   onSelect  a click: the designator of the part under the pointer, or null
//   onJump    a double click on a part: its designator
//
// Drawing is on demand — a frame when the camera, the size or the selection
// changes, none while the view is hidden. Everything three holds is freed on
// unmount, the WebGL context included: a page has few of them to give.

import React from 'react';

import {
  disposeModel, exportRoot, frameBox, light, loadThree, mergeByMaterial, partsOf, pickedPart, plainColours,
} from './board3d.js';
import { css, MONO } from './style.jsx';

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
/** How far a pointer may move between press and release and still click. */
const CLICK_SLOP = 4;

/** One loaded model on its canvas: the WebGL half of the view. */
class Stage {
  constructor(lib, host, gltf, handlers) {
    const { THREE, OrbitControls, mergeGeometries } = lib;
    this.THREE = THREE;
    this.host = host;
    this.handlers = handlers;
    this.active = false;
    this.selected = null;
    this.frame = 0;

    this.model = gltf.scene;
    plainColours(this.model, gltf.parser);
    this.root = exportRoot(this.model);
    for (const node of [...this.root.children]) mergeByMaterial(THREE, mergeGeometries, node);
    this.parts = partsOf(this.model);
    this.box = new THREE.Box3().setFromObject(this.model);
    this.radius = this.box.getBoundingSphere(new THREE.Sphere()).radius || 1;

    this.scene = new THREE.Scene();
    this.scene.add(this.model);
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

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.request());

    this.raycaster = new THREE.Raycaster();
    this.down = null;
    canvas.addEventListener('pointerdown', (event) => {
      this.down = event.button === 0 ? [event.clientX, event.clientY] : null;
    });
    canvas.addEventListener('pointerup', (event) => {
      const down = this.down;
      this.down = null;
      if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > CLICK_SLOP) return;
      const part = this.pick(event);
      this.select(part, false);
      this.handlers.onSelect(part);
    });
    canvas.addEventListener('dblclick', (event) => {
      const part = this.pick(event);
      if (part) this.handlers.onJump(part);
    });

    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    if (this.observer) this.observer.observe(host);
    this.resize();
    this.look(this.box, new THREE.Vector3(...FIRST_VIEW), BOARD_MARGIN, 0);
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
    this.request();
  }

  /** The camera onto `box`, along `direction`, with `margin` and at least `least`. */
  look(box, direction, margin, least) {
    const { target, position } = frameBox(this.THREE, box, direction, FOV, this.camera.aspect, margin, least);
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.controls.update();
    this.request();
  }

  /** The designator of the part under a pointer event, or null. */
  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const at = new this.THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(at, this.camera);
    return pickedPart(this.raycaster.intersectObject(this.root, true), this.root);
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
      if (frame) {
        const box = new this.THREE.Box3();
        for (const node of nodes) box.expandByObject(node);
        const direction = this.camera.position.clone().sub(this.controls.target).normalize();
        this.look(box, direction, PART_MARGIN, this.radius * PART_LEAST);
      }
    }
    this.request();
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.observer) this.observer.disconnect();
    this.controls.dispose();
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
    this.state = { loading: false, error: '' };
    this.host = null;
    this.stage = null;
    this.setHost = (element) => {
      this.host = element;
    };
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
   *  on showing after a failure), then the selection and whether it draws. */
  follow(prev) {
    const { active, selected } = this.props;
    const shown = active && !prev.active;
    if (!this.stage && !this.loading && active && (!this.state.error || shown)) this.load();
    if (!this.stage) return;
    this.stage.select(selected || null, true);
    if (active !== prev.active) this.stage.setActive(active);
  }

  load() {
    const { url } = this.props;
    this.loading = true;
    this.setState({ loading: true, error: '' });
    const model = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
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
          onJump: (designator) => this.props.onJump && this.props.onJump(designator),
        });
        this.stage.select(this.props.selected || null, true);
        this.stage.setActive(Boolean(this.props.active));
        this.setState({ loading: false });
      })
      .catch((error) => {
        this.loading = false;
        if (!this._gone) this.setState({ loading: false, error: `The 3D model did not load: ${error.message || error}` });
      });
  }

  render() {
    const { loading, error } = this.state;
    const note = error || (loading && 'Loading…');
    return (
      <div style={css(SHELL)}>
        <div ref={this.setHost} style={css(HOLDER)} />
        {note && <div style={css(NOTE)}>{note}</div>}
      </div>
    );
  }
}
