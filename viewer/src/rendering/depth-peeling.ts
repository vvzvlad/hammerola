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
    // A three upgrade that renames the anchor must fail loudly: without the
    // discard every peel pass draws the nearest surface again, and a ghost
    // stacks up into an opaque part drawn over the solids in front of it.
    if (!shader.fragmentShader.includes(CLIPPING_ANCHOR)) {
      throw new Error(`patchPeelMaterial: shader anchor not found: ${CLIPPING_ANCHOR}`);
    }
    shader.fragmentShader =
      PEEL_FRAGMENT_HEADER +
      "\n" +
      shader.fragmentShader.replace(
        CLIPPING_ANCHOR,
        `${CLIPPING_ANCHOR}${PEEL_DISCARD}`,
      );
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
 * One peeled layer, UNDER what is accumulated so far. A render target gets
 * linear output and the canvas sRGB, so the layer is encoded here the way three
 * encodes a fragment for the canvas, then premultiplied: three blends onto the
 * canvas in sRGB, so a peeled layer looks the same as an unpeeled one.
 */
const UNDER_FRAGMENT = `
uniform sampler2D tLayer;
varying vec2 vUv;
void main() {
  vec4 layer = texture2D( tLayer, vUv );
  vec3 encoded = clamp( sRGBTransferOETF( vec4( layer.rgb, 1.0 ) ).rgb, 0.0, 1.0 );
  gl_FragColor = vec4( encoded * layer.a, layer.a );
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

/**
 * Renders the scene with translucent faces peeled. Without a visible
 * translucent face, or without `EXT_color_buffer_float` (the layer and
 * accumulation targets are half float), it is a plain `renderer.render`.
 */
export class DepthPeeling {
  private readonly _renderer: THREE.WebGLRenderer;
  private _targets: PeelTargets | null = null;
  private readonly _bufferSize = new THREE.Vector2();
  private readonly _snapshot: LayerSnapshot = { objects: [], masks: [] };
  private readonly _savedClearColor = new THREE.Color();
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

  constructor(renderer: THREE.WebGLRenderer) {
    this._renderer = renderer;

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
   * pass, depth-tested against pass A's depth, which (d) left in place.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, nestedGroup: NestedGroup): void {
    const renderer = this._renderer;
    const translucent = translucentGroups(nestedGroup.groups);
    if (
      translucent.length === 0 ||
      !renderer.extensions.has("EXT_color_buffer_float")
    ) {
      renderer.render(scene, camera);
      return;
    }

    renderer.getDrawingBufferSize(this._bufferSize);
    const targets = this._ensureTargets(this._bufferSize.x, this._bufferSize.y);
    const uniforms = nestedGroup.peelUniforms;

    const savedTarget = renderer.getRenderTarget();
    const savedClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._savedClearColor);

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

      // (d) the translucent layers over pass A.
      this._compositeMaterial.uniforms.tAccum.value = targets.accum.texture;
      this._quad.material = this._compositeMaterial;
      renderer.setRenderTarget(savedTarget);
      renderer.render(this._quad, this._quadCamera);

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
      renderer.setRenderTarget(savedTarget);
      renderer.setClearColor(this._savedClearColor, savedClearAlpha);
    }
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
        type: THREE.HalfFloatType,
        depthTexture: depth[0],
      }),
      accum: new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
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
    this._disposeTargets();
    this._quad.geometry.dispose();
    this._underMaterial.dispose();
    this._compositeMaterial.dispose();
  }
}
