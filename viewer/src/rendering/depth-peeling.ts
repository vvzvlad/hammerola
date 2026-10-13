import * as THREE from "three";
import type { NestedGroup } from "../scene/nestedgroup.js";
import type { ObjectGroup } from "../scene/objectgroup.js";

/**
 * Depth peeling for translucent CAD faces.
 *
 * Every CAD face material is `transparent: true`, and three sorts transparent
 * objects per OBJECT by bounding-sphere depth, so nested translucent parts (an
 * opaque board inside a translucent case, a translucent cover over a translucent
 * body) blend in the wrong order. Peeling sorts per PIXEL instead: each peel pass
 * draws only the nearest translucent surface that lies behind the previous
 * pass's surface and in front of the opaque scene, and the layers are composited
 * front to back. Exact up to {@link PEEL_PASSES} layers per pixel.
 *
 * A frame is split by three.js layers, assigned at the start of the frame and
 * restored at its end (see {@link assignPassLayers}):
 * - layer 0 (pass A): everything that is drawn as before;
 * - {@link PEEL_LAYER}: the faces of translucent parts;
 * - {@link OVERLAY_LAYER}: the edges and vertices of translucent parts and
 *   everything drawn on top of the model (`renderOrder >= 1000`), drawn after
 *   the peeled layers so they are not covered by them.
 *
 * Reference: https://github.com/gkjohnson/depth-peeling-demo
 */

/** Layer of the peel passes. id-picking.ts holds layers 1–3 for its pick passes. */
export const PEEL_LAYER = 4;

/** Layer of the pass drawn over the composited translucent layers. */
export const OVERLAY_LAYER = 5;

/**
 * Objects at or above this `renderOrder` (their own or an ancestor's) are drawn
 * on top of the model: the library's highlight points and the section outline
 * (1000) and the UI widgets (`ui/src/viewport/scene3d.js`, 1001 and up).
 */
export const OVERLAY_RENDER_ORDER = 1000;

/** Saved layer masks, restored in reverse order by {@link restorePassLayers}. */
export interface LayerSnapshot {
  objects: THREE.Object3D[];
  masks: number[];
}

/** What three draws: a mesh (fat lines included), a line, points or a sprite. */
function isPassRenderable(object: THREE.Object3D): boolean {
  return (
    (object as THREE.Mesh).isMesh === true ||
    (object as THREE.Line).isLine === true ||
    (object as THREE.Points).isPoints === true ||
    (object as THREE.Sprite).isSprite === true
  );
}

/**
 * The ObjectGroups whose front face is visible and translucent this frame.
 * Peeling runs only when this is not empty.
 */
export function translucentGroups(
  groups: NestedGroup["groups"],
): ObjectGroup[] {
  const result: ObjectGroup[] = [];
  for (const path in groups) {
    const group = groups[path] as ObjectGroup;
    if (group.isObjectGroup !== true) continue;
    const front = group.front;
    if (
      front != null &&
      front.visible &&
      front.material.visible &&
      front.material.opacity < 1
    ) {
      result.push(group);
    }
  }
  return result;
}

/**
 * Move this frame's renderables onto their pass layers, saving every mask it
 * changes (and the camera's) into `snapshot`.
 *
 * Only renderables currently on layer 0 are moved, and only off layer 0 onto
 * their pass layer: other bits (the pick layers) stay, and an object that is not
 * on layer 0 at all (the pick-only vertex cloud) is not touched. Everything that
 * is not a renderable (the scene, groups, lights) gets both pass layers in
 * addition to its own, because three tests their layers too: a light that fails
 * the test does not light the pass, and a group that fails it does not hand its
 * `renderOrder` down as `groupOrder`.
 */
export function assignPassLayers(
  scene: THREE.Object3D,
  camera: THREE.Camera,
  translucent: readonly ObjectGroup[],
  snapshot: LayerSnapshot,
): void {
  snapshot.objects.push(camera);
  snapshot.masks.push(camera.layers.mask);

  const peel = new Set<THREE.Object3D>();
  const overlay = new Set<THREE.Object3D>();
  for (const group of translucent) {
    if (group.front !== null) peel.add(group.front);
    if (group.back !== null) peel.add(group.back);
    if (group.edges !== null) overlay.add(group.edges);
    if (group.vertices !== null) overlay.add(group.vertices);
  }

  const visit = (object: THREE.Object3D, overlayAncestor: boolean): void => {
    const onTop =
      overlayAncestor || object.renderOrder >= OVERLAY_RENDER_ORDER;
    if (!isPassRenderable(object)) {
      snapshot.objects.push(object);
      snapshot.masks.push(object.layers.mask);
      object.layers.enable(PEEL_LAYER);
      object.layers.enable(OVERLAY_LAYER);
    } else if (object.layers.isEnabled(0)) {
      const layer = peel.has(object)
        ? PEEL_LAYER
        : onTop || overlay.has(object)
          ? OVERLAY_LAYER
          : 0;
      if (layer !== 0) {
        snapshot.objects.push(object);
        snapshot.masks.push(object.layers.mask);
        object.layers.disable(0);
        object.layers.enable(layer);
      }
    }
    for (const child of object.children) visit(child, onTop);
  };
  visit(scene, false);
}

/**
 * Put back every mask {@link assignPassLayers} saved, last saved first. Empties
 * the snapshot, so it holds no scene objects between frames.
 */
export function restorePassLayers(snapshot: LayerSnapshot): void {
  for (let i = snapshot.objects.length - 1; i >= 0; i--) {
    snapshot.objects[i].layers.mask = snapshot.masks[i];
  }
  snapshot.objects.length = 0;
  snapshot.masks.length = 0;
}

/** Peel passes per frame: translucent surfaces deeper than this per pixel are dropped. */
export const PEEL_PASSES = 8;

/**
 * Uniforms shared by every peel-patched face material of one NestedGroup. One
 * object, referenced by all of them, so a write here reaches every material
 * without a recompile.
 */
export interface PeelUniforms {
  /** Off outside the peel passes, which leaves normal rendering unchanged. */
  uPeelActive: THREE.IUniform<boolean>;
  /** The first peel pass has no previous layer to peel behind. */
  uPeelFirstLayer: THREE.IUniform<boolean>;
  /** Depth of the opaque scene (pass A). */
  uPeelOpaqueDepth: THREE.IUniform<THREE.Texture | null>;
  /** Depth of the layer peeled by the previous pass. */
  uPeelPrevDepth: THREE.IUniform<THREE.Texture | null>;
  /** Drawing-buffer size, to turn `gl_FragCoord` into a texture coordinate. */
  uPeelResolution: THREE.IUniform<THREE.Vector2>;
}

/** Fresh uniforms with peeling off. */
export function createPeelUniforms(): PeelUniforms {
  return {
    uPeelActive: { value: false },
    uPeelFirstLayer: { value: true },
    uPeelOpaqueDepth: { value: null },
    uPeelPrevDepth: { value: null },
    uPeelResolution: { value: new THREE.Vector2(1, 1) },
  };
}

const PEEL_FRAGMENT_HEADER = `
uniform bool uPeelActive;
uniform bool uPeelFirstLayer;
uniform sampler2D uPeelOpaqueDepth;
uniform sampler2D uPeelPrevDepth;
uniform vec2 uPeelResolution;`;

/**
 * Keep only fragments in front of the opaque scene and behind the previous
 * layer. Injected right after clipping, so a clipped-away fragment never takes
 * part in a layer.
 *
 * The previous layer is compared with a margin, as in the reference demo: even
 * with polygon offset off, the depth a GPU writes and the `gl_FragCoord.z` the
 * same surface sees in the next pass are not always bit-equal (ANGLE on Metal),
 * and without the margin that surface is peeled a second time at scattered
 * pixels, which shows as speckle on every translucent face.
 */
const PEEL_DISCARD = `
  if ( uPeelActive ) {
    vec2 peelUv = gl_FragCoord.xy / uPeelResolution;
    if ( gl_FragCoord.z >= texture2D( uPeelOpaqueDepth, peelUv ).r ) discard;
    if ( ! uPeelFirstLayer && gl_FragCoord.z <= texture2D( uPeelPrevDepth, peelUv ).r + 1e-6 ) discard;
  }`;

const CLIPPING_ANCHOR = "#include <clipping_planes_fragment>";

/**
 * Encode a peeled fragment the way three encodes it for the canvas. A render
 * target gets linear output and the canvas sRGB. The layer target is 8-bit,
 * which keeps sRGB-encoded colour as finely as the canvas does but would band
 * linear colour in the darks, and the composite blends onto the canvas in sRGB,
 * so a peeled layer looks the same as an unpeeled one. Injected right after the
 * output encoding, so fog and premultiplication still follow it as on the
 * canvas.
 */
const PEEL_ENCODE = `
  if ( uPeelActive ) gl_FragColor = sRGBTransferOETF( gl_FragColor );`;

const COLORSPACE_ANCHOR = "#include <colorspace_fragment>";

/**
 * Patch a CAD face material (front or back) for peeling. Both hooks are
 * CHAINED: the previous `onBeforeCompile` (the highlight patch) still runs, and
 * the previous program key is extended rather than replaced, so materials that
 * differ in an earlier patch keep separate programs.
 */
export function patchPeelMaterial(
  material: THREE.Material,
  uniforms: PeelUniforms,
): void {
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;

  material.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(material, shader, renderer);
    shader.uniforms.uPeelActive = uniforms.uPeelActive;
    shader.uniforms.uPeelFirstLayer = uniforms.uPeelFirstLayer;
    shader.uniforms.uPeelOpaqueDepth = uniforms.uPeelOpaqueDepth;
    shader.uniforms.uPeelPrevDepth = uniforms.uPeelPrevDepth;
    shader.uniforms.uPeelResolution = uniforms.uPeelResolution;
    // A three upgrade that renames an anchor must fail loudly: without the
    // discard every peel pass draws the nearest surface again, and a ghost
    // stacks up into an opaque part drawn over the solids in front of it;
    // without the encoding every peeled layer comes out too dark.
    for (const anchor of [CLIPPING_ANCHOR, COLORSPACE_ANCHOR]) {
      if (!shader.fragmentShader.includes(anchor)) {
        throw new Error(`patchPeelMaterial: shader anchor not found: ${anchor}`);
      }
    }
    shader.fragmentShader =
      PEEL_FRAGMENT_HEADER +
      "\n" +
      shader.fragmentShader
        .replace(CLIPPING_ANCHOR, `${CLIPPING_ANCHOR}${PEEL_DISCARD}`)
        .replace(COLORSPACE_ANCHOR, `${COLORSPACE_ANCHOR}${PEEL_ENCODE}`);
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|peel`;
  material.needsUpdate = true;
}

const QUAD_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/**
 * One peeled layer, UNDER what is accumulated so far. The peel pass wrote it
 * sRGB-encoded (see {@link PEEL_ENCODE}), so here it is only premultiplied.
 */
const UNDER_FRAGMENT = `
uniform sampler2D tLayer;
varying vec2 vUv;
void main() {
  vec4 layer = texture2D( tLayer, vUv );
  gl_FragColor = vec4( layer.rgb * layer.a, layer.a );
}`;

/** The accumulated layers, already premultiplied. */
const COMPOSITE_FRAGMENT = `
uniform sampler2D tAccum;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D( tAccum, vUv );
}`;

interface PeelTargets {
  /** Pass A again, for its depth (and the stencil the clipping caps need). */
  opaque: THREE.WebGLRenderTarget;
  /** One peeled layer; its depth texture alternates between `depth[0]` and `depth[1]`. */
  layer: THREE.WebGLRenderTarget;
  /** The layers composited front to back. */
  accum: THREE.WebGLRenderTarget;
  depth: [THREE.DepthTexture, THREE.DepthTexture];
}

interface PeelMaterialState {
  material: THREE.Material;
  blending: THREE.Blending;
  depthWrite: boolean;
  depthTest: boolean;
  polygonOffset: boolean;
}

/** How long the camera must stay still before the peeled frame is drawn, ms. */
const SETTLE_MS = 150;

/** Margin around the projected bounding boxes, in drawing-buffer pixels. */
const PEEL_RECT_PAD = 2;

const _corner = new THREE.Vector3();

/**
 * The drawing-buffer rectangle that holds the faces of `translucent` on screen:
 * x, y, width, height in pixels from the bottom left, as `gl.scissor` takes
 * them. It is the union of the projected bounding boxes of the front meshes
 * (the back mesh shares the front's geometry and place), padded by
 * {@link PEEL_RECT_PAD}. A corner behind a perspective camera does not project
 * to where the box crosses the screen, so then it is the whole buffer.
 *
 * Returns false when the rectangle is empty: nothing translucent is on screen.
 */
function peelRect(
  translucent: readonly ObjectGroup[],
  camera: THREE.Camera,
  size: THREE.Vector2,
  rect: THREE.Vector4,
): boolean {
  // renderer.render brings the world matrices up to date only once it runs,
  // and the rectangle is needed before that.
  camera.updateWorldMatrix(true, false);
  const perspective =
    (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  const near = (camera as THREE.PerspectiveCamera).near;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const group of translucent) {
    const front = group.front;
    if (front === null) continue;
    front.updateWorldMatrix(true, false);
    const geometry = front.geometry;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    if (box.isEmpty()) continue;
    for (let i = 0; i < 8; i++) {
      _corner
        .set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        )
        .applyMatrix4(front.matrixWorld)
        .applyMatrix4(camera.matrixWorldInverse);
      if (perspective && _corner.z >= -near) {
        rect.set(0, 0, size.x, size.y);
        return true;
      }
      _corner.applyMatrix4(camera.projectionMatrix);
      minX = Math.min(minX, _corner.x);
      minY = Math.min(minY, _corner.y);
      maxX = Math.max(maxX, _corner.x);
      maxY = Math.max(maxY, _corner.y);
    }
  }

  const x0 = Math.max(0, Math.floor((minX * 0.5 + 0.5) * size.x) - PEEL_RECT_PAD);
  const y0 = Math.max(0, Math.floor((minY * 0.5 + 0.5) * size.y) - PEEL_RECT_PAD);
  const x1 = Math.min(size.x, Math.ceil((maxX * 0.5 + 0.5) * size.x) + PEEL_RECT_PAD);
  const y1 = Math.min(size.y, Math.ceil((maxY * 0.5 + 0.5) * size.y) + PEEL_RECT_PAD);
  rect.set(x0, y0, x1 - x0, y1 - y0);
  return x1 > x0 && y1 > y0;
}

/**
 * Renders the scene with translucent faces peeled. Without a translucent face
 * on screen it is a plain `renderer.render`.
 *
 * The peel passes and the composite bound the frame by memory bandwidth, so
 * they write 8-bit targets and run only inside the screen rectangle of the
 * translucent faces (see {@link peelRect}).
 *
 * Even so a peeled frame costs several plain ones, so it is drawn only for a
 * still camera. While the camera moves, a frame draws the solids first and the
 * translucent faces over them in three's per-object order: no solid can come
 * out in front of a translucent part, and only translucent faces behind one
 * another may blend in the wrong order. {@link SETTLE_MS} after the camera last
 * changed the viewer is asked for one more frame, which is peeled.
 */
export class DepthPeeling {
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _requestRender: () => void;
  /**
   * The camera of the last frame that had translucent faces on screen: world
   * matrix, then projection matrix.
   */
  private readonly _lastView = new Float64Array(32);
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The camera changed less than {@link SETTLE_MS} ago. */
  private _moving = false;
  private _targets: PeelTargets | null = null;
  private readonly _bufferSize = new THREE.Vector2();
  private readonly _rect = new THREE.Vector4();
  private readonly _snapshot: LayerSnapshot = { objects: [], masks: [] };
  private readonly _savedClearColor = new THREE.Color();
  private readonly _savedScissor = new THREE.Vector4();
  private _savedScissorTest = false;
  private readonly _savedTargetScissor = new THREE.Vector4();
  private _savedTargetScissorTest = false;
  private readonly _quadCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0,
    1,
  );
  private readonly _quad: THREE.Mesh;
  private readonly _underMaterial: THREE.ShaderMaterial;
  private readonly _compositeMaterial: THREE.ShaderMaterial;

  /**
   * @param requestRender - draws a frame of the viewer; called once the camera
   *   has settled, for the peeled frame.
   */
  constructor(renderer: THREE.WebGLRenderer, requestRender: () => void) {
    this._renderer = renderer;
    this._requestRender = requestRender;

    // One triangle covering the viewport, as three's FullScreenQuad builds it.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2),
    );

    // Under-compositing, front to back: dst += src * (1 - dst.a).
    this._underMaterial = new THREE.ShaderMaterial({
      uniforms: { tLayer: { value: null } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: UNDER_FRAGMENT,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneMinusDstAlphaFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });

    // Premultiplied "over" onto the canvas, which is premultiplied as well.
    this._compositeMaterial = new THREE.ShaderMaterial({
      uniforms: { tAccum: { value: null } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    });

    this._quad = new THREE.Mesh(geometry, this._underMaterial);
  }

  /**
   * Render one frame of `scene` into the current render target.
   *
   * (a) pass A as before; (b) pass A again into the opaque target for its
   * depth; (c) {@link PEEL_PASSES} peel passes, each composited under the
   * accumulation; (d) the accumulation over the current target; (e) the overlay
   * pass, depth-tested against pass A's depth, which (d) left in place. (c) and
   * (d) are scissored to the rectangle of the translucent faces; (a), (b) and
   * (e) are full-screen.
   *
   * @param exact - peel even if the camera moved (a screenshot).
   */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    nestedGroup: NestedGroup,
    exact: boolean = false,
  ): void {
    const renderer = this._renderer;
    const translucent = translucentGroups(nestedGroup.groups);
    renderer.getDrawingBufferSize(this._bufferSize);
    const rect = this._rect;
    if (
      translucent.length === 0 ||
      !peelRect(translucent, camera, this._bufferSize, rect)
    ) {
      renderer.render(scene, camera);
      return;
    }

    // peelRect brought the camera's world matrix up to date. Moving lasts from
    // any change of the camera until the settle timer fires, not just for the
    // frame that saw the change: the viewer can draw more than one frame per
    // camera step.
    if (this._cameraMoved(camera)) {
      this._moving = true;
      this._scheduleSettle();
    }
    if (this._moving && !exact) {
      this._renderUnpeeled(scene, camera, translucent);
      return;
    }

    const targets = this._ensureTargets(this._bufferSize.x, this._bufferSize.y);
    const uniforms = nestedGroup.peelUniforms;

    const savedTarget = renderer.getRenderTarget();
    const savedClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._savedClearColor);
    renderer.getScissor(this._savedScissor);
    this._savedScissorTest = renderer.getScissorTest();
    if (savedTarget !== null) {
      this._savedTargetScissor.copy(savedTarget.scissor);
      this._savedTargetScissorTest = savedTarget.scissorTest;
    }

    const states: PeelMaterialState[] = [];
    for (const group of translucent) {
      for (const mesh of [group.front, group.back]) {
        if (mesh === null) continue;
        const material = mesh.material;
        states.push({
          material,
          blending: material.blending,
          depthWrite: material.depthWrite,
          depthTest: material.depthTest,
          polygonOffset: material.polygonOffset,
        });
      }
    }

    try {
      assignPassLayers(scene, camera, translucent, this._snapshot);

      // (a) pass A, to the current target as before.
      renderer.render(scene, camera);

      // (b) pass A again, for the opaque depth.
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(targets.opaque);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);

      // (c) peel. The nearest surviving surface must OVERWRITE the layer, not
      // blend into it, and the depth it writes must be its gl_FragCoord.z, so
      // the next pass can peel behind it: no blending, depth written, no offset.
      for (const state of states) {
        state.material.blending = THREE.NoBlending;
        state.material.depthWrite = true;
        state.material.depthTest = true;
        state.material.polygonOffset = false;
      }
      uniforms.uPeelActive.value = true;
      uniforms.uPeelOpaqueDepth.value = targets.opaque.depthTexture;
      uniforms.uPeelResolution.value.copy(this._bufferSize);

      // Clears honour the scissor as draws do, so outside the rectangle the
      // layer and accumulation targets keep stale pixels that nothing reads.
      targets.layer.scissor.copy(rect);
      targets.layer.scissorTest = true;
      targets.accum.scissor.copy(rect);
      targets.accum.scissorTest = true;

      renderer.setRenderTarget(targets.accum);
      renderer.clear(true, false, false);
      this._underMaterial.uniforms.tLayer.value = targets.layer.texture;
      camera.layers.set(PEEL_LAYER);

      for (let i = 0; i < PEEL_PASSES; i++) {
        targets.layer.depthTexture = targets.depth[i % 2];
        uniforms.uPeelPrevDepth.value = targets.depth[(i + 1) % 2];
        uniforms.uPeelFirstLayer.value = i === 0;

        renderer.setRenderTarget(targets.layer);
        renderer.clear(true, true, false);
        renderer.render(scene, camera);

        this._quad.material = this._underMaterial;
        renderer.setRenderTarget(targets.accum);
        renderer.render(this._quad, this._quadCamera);
      }

      // (d) the translucent layers over pass A, inside the rectangle. A render
      // target takes its own scissor; the canvas takes the renderer's, in CSS
      // pixels, set once the canvas is bound: three rounds it back to these
      // pixels there, where binding would floor it.
      this._compositeMaterial.uniforms.tAccum.value = targets.accum.texture;
      this._quad.material = this._compositeMaterial;
      if (savedTarget !== null) {
        savedTarget.scissor.copy(rect);
        savedTarget.scissorTest = true;
      }
      renderer.setRenderTarget(savedTarget);
      if (savedTarget === null) {
        const ratio = renderer.getPixelRatio();
        renderer.setScissor(
          rect.x / ratio,
          rect.y / ratio,
          rect.z / ratio,
          rect.w / ratio,
        );
        renderer.setScissorTest(true);
      }
      renderer.render(this._quad, this._quadCamera);
      this._restoreScissor(savedTarget);

      // (e) the overlay, over everything.
      camera.layers.set(OVERLAY_LAYER);
      renderer.render(scene, camera);
    } finally {
      for (let i = states.length - 1; i >= 0; i--) {
        const state = states[i];
        state.material.blending = state.blending;
        state.material.depthWrite = state.depthWrite;
        state.material.depthTest = state.depthTest;
        state.material.polygonOffset = state.polygonOffset;
      }
      // The depth textures are attached to targets; a sampler still pointing at
      // one when pass A is drawn into that target would be a feedback loop.
      uniforms.uPeelActive.value = false;
      uniforms.uPeelOpaqueDepth.value = null;
      uniforms.uPeelPrevDepth.value = null;
      restorePassLayers(this._snapshot);
      targets.layer.scissorTest = false;
      targets.accum.scissorTest = false;
      this._restoreScissor(savedTarget);
      renderer.setClearColor(this._savedClearColor, savedClearAlpha);
    }
  }

  /** Whether `camera` moved since the last frame; remembers where it is now. */
  private _cameraMoved(camera: THREE.Camera): boolean {
    const last = this._lastView;
    const world = camera.matrixWorld.elements;
    const projection = camera.projectionMatrix.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      if (last[i] !== world[i] || last[16 + i] !== projection[i]) moved = true;
      last[i] = world[i];
      last[16 + i] = projection[i];
    }
    return moved;
  }

  /**
   * The frame for a moving camera: the solids, then the translucent faces as
   * three orders and blends them, then the overlay, all into the current
   * target. The solids write depth first, so a translucent face behind one is
   * hidden and one in front blends over it.
   */
  private _renderUnpeeled(
    scene: THREE.Scene,
    camera: THREE.Camera,
    translucent: readonly ObjectGroup[],
  ): void {
    const renderer = this._renderer;
    try {
      assignPassLayers(scene, camera, translucent, this._snapshot);
      renderer.render(scene, camera);
      camera.layers.set(PEEL_LAYER);
      renderer.render(scene, camera);
      camera.layers.set(OVERLAY_LAYER);
      renderer.render(scene, camera);
    } finally {
      restorePassLayers(this._snapshot);
    }
  }

  /** End the move {@link SETTLE_MS} after this camera change, with a peeled frame. */
  private _scheduleSettle(): void {
    this._cancelSettle();
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this._moving = false;
      this._requestRender();
    }, SETTLE_MS);
  }

  private _cancelSettle(): void {
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
  }

  /**
   * Put back the scissor of the renderer and of `target`, the target the frame
   * is drawn into, and bind `target` again, which applies the scissor it uses.
   */
  private _restoreScissor(target: THREE.WebGLRenderTarget | null): void {
    const renderer = this._renderer;
    renderer.setScissor(this._savedScissor);
    renderer.setScissorTest(this._savedScissorTest);
    if (target !== null) {
      target.scissor.copy(this._savedTargetScissor);
      target.scissorTest = this._savedTargetScissorTest;
    }
    renderer.setRenderTarget(target);
  }

  /** The targets at `width` x `height`, rebuilt when the drawing buffer changed size. */
  private _ensureTargets(width: number, height: number): PeelTargets {
    if (
      this._targets !== null &&
      this._targets.layer.width === width &&
      this._targets.layer.height === height
    ) {
      return this._targets;
    }
    this._disposeTargets();

    const opaqueDepth = new THREE.DepthTexture(
      width,
      height,
      THREE.UnsignedInt248Type,
    );
    opaqueDepth.format = THREE.DepthStencilFormat;

    // Float depth: a layer's depth is compared with gl_FragCoord.z of the same
    // surface in the next pass, which a 24-bit buffer would round.
    const depth: [THREE.DepthTexture, THREE.DepthTexture] = [
      new THREE.DepthTexture(width, height, THREE.FloatType),
      new THREE.DepthTexture(width, height, THREE.FloatType),
    ];

    this._targets = {
      opaque: new THREE.WebGLRenderTarget(width, height, {
        depthTexture: opaqueDepth,
        stencilBuffer: true,
      }),
      layer: new THREE.WebGLRenderTarget(width, height, {
        depthTexture: depth[0],
      }),
      accum: new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
      }),
      depth,
    };
    return this._targets;
  }

  private _disposeTargets(): void {
    if (this._targets === null) return;
    const { opaque, layer, accum, depth } = this._targets;
    opaque.dispose();
    layer.dispose();
    accum.dispose();
    // A target disposes only the depth texture attached to it at the time.
    depth[0].dispose();
    depth[1].dispose();
    this._targets = null;
  }

  /** Release the render targets and the quad. */
  dispose(): void {
    this._cancelSettle();
    this._disposeTargets();
    this._quad.geometry.dispose();
    this._underMaterial.dispose();
    this._compositeMaterial.dispose();
  }
}
