// The board's copper in the 3D view of a board (BoardView3D.jsx), drawn by us
// rather than taken from the `.glb`: pure, so ui/tests/board3dcopper.test.js
// runs it on three's own objects without a GPU.
//
// WHERE IT COMES FROM. KiCad's `.glb` merges a board's copper into three meshes,
// `<board>_copper`, `<board>_pad` and `<board>_via`, which carry no net and no
// layer, and has no inner copper unless asked. The board's `<ecad-viewer>` has
// parsed the board already; its `getBoardCopper()` (our edit 18,
// static/_v/PROVENANCE.md) hands every copper layer in stack order with the
// heights KiCad's 3D export gives it, its triangles in the board's millimetres
// with each vertex's net, and the plated barrels. The page draws that, a mesh per
// layer, and hides the `.glb`'s own copper (`glbLayers`).
//
// THE FRAME is the `.glb`'s: glTF is Y-up and in metres, KiCad's x is the
// model's X and its y (down on the board as drawn) the model's Z, with no
// shift between the two (kicad-cli writes the board at its own coordinates), and
// a height of 0 is the face of the board's body B.Cu lies on. A layer is drawn
// as one sheet on the face of it that looks out of the board — the top face of
// the upper half of the stack, the bottom face of the lower half — so F.Cu lies
// where the `.glb`'s top copper face is, B.Cu where its bottom one is, and
// neither sheet lies in a face of the body.
//
// HOLES are cut out of every sheet where the 2D board paints them over the
// copper: a zone or a track runs into a pad's or a via's drill there, and the
// `.glb` has it drilled. The drills that go through the whole stack are a mask
// (`holeMask`) the sheets' shader discards over.
//
// HOW IT LOOKS is a uniform or two of one shader (`copperMaterial`): the lit net
// in the selection colour, the other copper all but faded into the canvas's
// colour (`DIM`), and with Isolate only the lit net's copper drawn. Stackup
// separation (`stackOffsets`, `separationLook`) follows Prism's 3D tab: the
// layers pulled apart in height, the parts gone by a tenth of the slider, the
// copper turned to the colours of its layers by a quarter, the barrels
// stretched between their layers; the board, unlike Prism's 28% at the end,
// thinned to 15% by a quarter.

/** What KiCad's 3D export makes copper of (`STEP_PCB_MODEL`'s copper colour,
 *  the `_copper` material of every `.glb` it writes): linear RGB and the
 *  material's metal and roughness. Our copper is drawn in it on the assembled
 *  board, the `.glb` having copper or not. */
export const COPPER = { colour: [0.7, 0.61, 0], metalness: 1, roughness: 0.4 };

/** How much of the canvas's colour the copper a lit net leaves out is drawn
 *  in: the canvas is light or dark by the theme, so a fixed colour to dim
 *  toward would stand out on one of them. Mixed in the screen's sRGB, so the
 *  copper keeps the same tenth of its contrast on either canvas. */
export const DIM = 0.9;

/** The kinds of a layer of the board KiCad's `.glb` names at the end of its
 *  mesh's name (`<board>_copper`, kicad-cli 10). */
const GLB_COPPER = new Set(['copper', 'pad', 'via']);
const GLB_SKIN = new Set(['soldermask', 'silkscreen']);

/** What layer of the board a top-level node of the export is: the suffix of
 *  its glTF mesh's name (`copper`, `pad`, `via`, `soldermask`, `silkscreen`,
 *  `PCB`), read through the loader's `parser.associations`, or null. */
export function glbLayerKind(node, parser) {
  const at = parser.associations.get(node);
  const mesh = at && at.meshes !== undefined && parser.json.meshes && parser.json.meshes[at.meshes];
  const match = mesh && /_([A-Za-z]+)$/.exec(mesh.name || '');
  return match ? match[1] : null;
}

/** The board's own layers among `layers` (the top-level nodes that are no
 *  part), by what they are to our copper: `copper`, the `.glb`'s copper, which
 *  ours replaces; `skin`, the solder mask and the silkscreen, which a click on
 *  copper goes through; `board`, all of them but the copper, which the stackup
 *  separation thins and Isolate hides. */
export function glbLayers(layers, parser) {
  const out = { copper: [], skin: [], board: [] };
  for (const node of layers) {
    const kind = glbLayerKind(node, parser);
    if (GLB_COPPER.has(kind)) {
      out.copper.push(node);
      continue;
    }
    out.board.push(node);
    if (GLB_SKIN.has(kind)) out.skin.push(node);
  }
  return out;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** How far each of `count` copper layers is raised at separation `s` (0 to
 *  1), top layer first, in mm: Prism's `stackOffsets`, a gap of
 *  `s² · clamp(0.12 · diagonal, 8, 25)` between neighbours about the middle of
 *  the stack, `diagonal` the board's in mm. */
export function stackOffsets(s, diagonal, count) {
  const gap = s * s * Math.min(25, Math.max(8, 0.12 * diagonal));
  const middle = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => (middle - i) * gap);
}

/** What separation `s` does to the rest of the board: `parts`, the parts'
 *  opacity, gone by 0.1, and `layers`, how far the copper has turned to its
 *  layers' colours, fully by 0.25 (Prism's frame inputs); `board`, the
 *  board's, down to 0.15 by 0.25 rather than Prism's 0.28 at 1, so every
 *  layer's copper shows through it. */
export const separationLook = (s) => ({ parts: clamp01(1 - s / 0.1), board: 1 - 0.85 * clamp01(s / 0.25),
  layers: clamp01(s / 0.25) });

/**
 * Draw `nodes` at `amount` of their own opacity, hidden at 0 (and so not
 * picked). Each material keeps its own opacity and whether it was
 * translucent (`userData.board3dFade`, which a copy made to light a part
 * takes along); it is translucent while faded at all. A part's lit copy and
 * the shared material it stands for (board3d.js, `light`) fade alike.
 */
export function fade(nodes, amount) {
  for (const node of nodes) {
    node.visible = amount > 0;
    node.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const own = mesh.userData.board3d;
      for (const material of new Set([mesh.material, own && own.shared, own && own.lit])) {
        if (!material) continue;
        const base = material.userData.board3dFade
          || (material.userData.board3dFade = { opacity: material.opacity, transparent: material.transparent });
        const transparent = base.transparent || amount < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.opacity = base.opacity * amount;
      }
    });
  }
}

/** The face of layer `index` of `count` that looks out of the board, in mm. */
export const outerFace = (layer, index, count) => (index < count / 2 ? layer.top : layer.bottom);

/** How many sides a barrel is drawn with. */
const BARREL_SIDES = 12;

/** How far toward the eye the lit net's copper is drawn, in metres: over the
 *  `.glb`'s solder mask and silkscreen (15 and 40 µm over its copper), which
 *  would otherwise hide it under 83% of green, and under any part. */
const LIT_LIFT = 0.00006;

/** The side of a texel of the hole mask, in mm, and the most texels a side
 *  of it has. */
const HOLE_TEXEL = 0.025;
const HOLE_TEXELS = 4096;

/** The box of the copper's triangles, in the board's mm, or null when it has
 *  none. */
export function copperBox(copper) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const layer of copper.layers) {
    const xy = layer.triangles;
    for (let i = 0; i < xy.length; i += 2) {
      if (xy[i] < x0) x0 = xy[i];
      if (xy[i] > x1) x1 = xy[i];
      if (xy[i + 1] < y0) y0 = xy[i + 1];
      if (xy[i + 1] > y1) y1 = xy[i + 1];
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * The drills through the whole stack over `box` (`copperBox`) as a mask: a
 * byte per texel, `texel` mm square, from `x0`, `y0`, how much of it a drill
 * covers (255 all of it), so a linear lookup halfway up lies on the drill's
 * edge. A drill that stops inside the stack has its hole in its own rings.
 */
export function holeMask(copper, box) {
  const last = copper.layers.length - 1;
  const texel = Math.max(HOLE_TEXEL, Math.max(box.x1 - box.x0, box.y1 - box.y0) / (HOLE_TEXELS - 3));
  // A texel to spare on every side, and one more for the rounding of the
  // division above, which can push the ceiling below a texel over.
  const [x0, y0] = [box.x0 - texel, box.y0 - texel];
  const width = Math.ceil((box.x1 - box.x0) / texel) + 2;
  const height = Math.ceil((box.y1 - box.y0) / texel) + 2;
  const data = new Uint8Array(width * height);
  for (const barrel of copper.barrels) {
    if (barrel.from !== 0 || barrel.to !== last) continue;
    const reach = barrel.radius / texel + 1;
    const [cx, cy] = [(barrel.x - x0) / texel - 0.5, (barrel.y - y0) / texel - 0.5];
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(height - 1, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(width - 1, Math.ceil(cx + reach)); x++) {
        const cover = clamp01(barrel.radius / texel - Math.hypot(x - cx, y - cy) + 0.5);
        const i = y * width + x;
        data[i] = Math.max(data[i], Math.round(cover * 255));
      }
    }
  }
  return { data, width, height, x0, y0, texel };
}

/**
 * The shader of our copper: three's standard material with a net index on
 * every vertex (`netIndex`) and the uniforms `shared` holds, one object for
 * every layer's material: `litNet`, the lit net's code or −1; `isolate`, only
 * that net drawn; `accent`, the selection colour it is lit in; `dimTo`, the
 * canvas's colour in sRGB, which the rest of the copper fades into (`DIM`);
 * `holeMap` and
 * `holeBox`, the drills' mask (`holeMask`) as a texture and where it lies,
 * which a sheet (`holed`) is discarded over. The lit net takes no metal, so
 * the colour reads as it is, and glows a little, as a lit part does (board3d.js,
 * `light`); it is drawn `LIT_LIFT` toward the eye along the line of sight, so
 * it stands where it is on screen and the mask over it fails the depth test.
 * Flat shading takes each sheet's normal toward the eye, whichever way its
 * triangles wind.
 */
export function copperMaterial(THREE, shared, colour, holed) {
  const material = new THREE.MeshStandardMaterial({ color: colour, metalness: COPPER.metalness,
    roughness: COPPER.roughness, side: THREE.DoubleSide, flatShading: true });
  if (holed) material.defines = { BOARD3D_HOLES: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float netIndex;\nuniform float litNet;\nvarying float vNet;\n'
        + 'varying vec2 vBoard;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNet = netIndex;\nvBoard = position.xz * 1000.0;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n'
        + 'if ( litNet >= 0.0 && abs( netIndex - litNet ) < 0.5 ) {\n'
        + '  mvPosition.xyz += ( isPerspectiveMatrix( projectionMatrix ) ? - normalize( mvPosition.xyz )'
        + ` : vec3( 0.0, 0.0, 1.0 ) ) * ${LIT_LIFT.toFixed(6)};\n`
        + '  gl_Position = projectionMatrix * mvPosition;\n}');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'uniform float litNet;\nuniform bool isolate;\nuniform vec3 accent;\n'
        + 'uniform vec3 dimTo;\nuniform sampler2D holeMap;\nuniform vec4 holeBox;\nvarying float vNet;\nvarying vec2 vBoard;\n'
        + '#include <common>')
      .replace('#include <color_fragment>', '#include <color_fragment>\n'
        + '#ifdef BOARD3D_HOLES\n'
        + 'if ( texture2D( holeMap, ( vBoard - holeBox.xy ) * holeBox.zw ).r > 0.5 ) discard;\n'
        + '#endif\n'
        + 'bool lit = litNet >= 0.0 && abs( vNet - litNet ) < 0.5;\n'
        + 'if ( isolate && ! lit ) discard;\n'
        + 'if ( lit ) diffuseColor.rgb = accent;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif ( lit ) metalnessFactor = 0.0;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n'
        + 'if ( lit ) totalEmissiveRadiance += accent * 0.3;')
      // After the light and the conversion to the screen's sRGB, which
      // `dimTo` is in: mixed in linear light, the copper would keep about
      // three times as much of its contrast on the dark canvas as on the
      // light one.
      .replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n'
        + `if ( litNet >= 0.0 && ! lit ) gl_FragColor.rgb = mix( gl_FragColor.rgb, dimTo, ${DIM.toFixed(2)} );`);
  };
  material.customProgramCacheKey = () => (holed ? 'board3d-copper-holed' : 'board3d-copper');
  return material;
}

/** A mesh of `xy` (the board's mm, a vertex's x and y) at `height` mm, with
 *  each vertex's net, in the `.glb`'s frame. */
function sheet(THREE, xy, nets, height, material) {
  const count = xy.length / 2;
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    position[i * 3] = xy[i * 2] / 1000;
    position[i * 3 + 1] = height / 1000;
    position[i * 3 + 2] = xy[i * 2 + 1] / 1000;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('netIndex', new THREE.BufferAttribute(Float32Array.from(nets), 1));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.board3dCopper = true;
  return mesh;
}

/**
 * Our copper (`copper`, what `getBoardCopper` hands, with `colours`, each
 * layer's CSS colour by its name) as three objects: `group`, holding a mesh per
 * layer and one of every barrel; `layers`, each `{ name, mesh, material,
 * colour }`, the layer's own colour as a three colour; `barrels`, the barrels'
 * mesh and, per vertex, the layer whose height it follows and its height there
 * (`ends`, `heights`), which `place` moves; `nets`, the names by code;
 * `shared`, the uniforms of the shader (`copperMaterial`); `base`, the copper's
 * own colour; and `diagonal`, what the separation's gap is scaled by.
 */
export function copperModel(THREE, copper, colours) {
  const box = copperBox(copper) || { x0: 0, y0: 0, x1: 0, y1: 0 };
  const mask = holeMask(copper, box);
  const holeMap = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RedFormat, THREE.UnsignedByteType);
  Object.assign(holeMap, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    unpackAlignment: 1, needsUpdate: true });
  const shared = { litNet: { value: -1 }, isolate: { value: false }, accent: { value: new THREE.Color() },
    dimTo: { value: new THREE.Color() }, holeMap: { value: holeMap },
    holeBox: { value: new THREE.Vector4(mask.x0, mask.y0, 1 / (mask.width * mask.texel), 1 / (mask.height * mask.texel)) } };
  const group = new THREE.Group();
  const count = copper.layers.length;
  const base = new THREE.Color().setRGB(...COPPER.colour);
  const layers = copper.layers.map((layer, index) => {
    const material = copperMaterial(THREE, shared, base.clone(), true);
    const mesh = sheet(THREE, layer.triangles, layer.nets, outerFace(layer, index, count), material);
    group.add(mesh);
    return { name: layer.name, mesh, material, colour: new THREE.Color().setStyle(colours[layer.name]) };
  });
  // Each barrel a tube of BARREL_SIDES sides from the top face of its upper
  // layer to the bottom face of its lower one, flat-shaded as the sheets are.
  const sides = copper.barrels.length * BARREL_SIDES * 6;
  const position = new Float32Array(sides * 3);
  const netIndex = new Float32Array(sides);
  const ends = new Uint8Array(sides);
  const heights = new Float32Array(sides);
  let at = 0;
  for (const barrel of copper.barrels) {
    const top = [barrel.from, copper.layers[barrel.from].top];
    const bottom = [barrel.to, copper.layers[barrel.to].bottom];
    for (let i = 0; i < BARREL_SIDES; i++) {
      const a = (i / BARREL_SIDES) * 2 * Math.PI;
      const b = ((i + 1) / BARREL_SIDES) * 2 * Math.PI;
      for (const [angle, [layer, height]] of [[a, top], [b, top], [a, bottom], [a, bottom], [b, top], [b, bottom]]) {
        position[at * 3] = (barrel.x + barrel.radius * Math.cos(angle)) / 1000;
        position[at * 3 + 2] = (barrel.y + barrel.radius * Math.sin(angle)) / 1000;
        netIndex[at] = barrel.net;
        ends[at] = layer;
        heights[at] = height;
        at += 1;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('netIndex', new THREE.BufferAttribute(netIndex, 1));
  const material = copperMaterial(THREE, shared, base.clone(), false);
  const tubes = new THREE.Mesh(geometry, material);
  tubes.userData.board3dCopper = true;
  group.add(tubes);
  const barrels = { mesh: tubes, material, ends, heights };
  place(stackOffsets(0, 0, count), layers, barrels);
  return { group, layers, barrels, nets: copper.nets, shared, base, diagonal: Math.hypot(box.x1 - box.x0, box.y1 - box.y0) };
}

/** The layers raised by `offsets` (mm, `stackOffsets`), and every barrel
 *  stretched between the layers it joins. */
export function place(offsets, layers, barrels) {
  layers.forEach((layer, index) => {
    layer.mesh.position.y = offsets[index] / 1000;
  });
  const position = barrels.mesh.geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    position.array[i * 3 + 1] = (barrels.heights[i] + offsets[barrels.ends[i]]) / 1000;
  }
  position.needsUpdate = true;
  barrels.mesh.geometry.computeBoundingSphere();
}

/**
 * Where an orthographic camera stands to draw a PCB inset of the 3D board
 * (the `InsetScene3D` of ecad-viewer/…/insets/types.ts): `view` is the inset's
 * camera (`InsetCamera`, the board's mm: `center`, `zoom` CSS px per mm,
 * `rotation` clockwise on screen, `mirror` for the bottom, `tilt` leaning back),
 * the canvas `width` by `height` CSS px, `radius` the model's in metres and
 * `surface` the height in metres the view pivots on. On that plane a point lands
 * where the inset's own 2D matrix (`inset_matrix`) puts it, so its leaders and
 * outlines stay right: Prism's `insetBasis`, in the `.glb`'s frame, where the
 * board's right is +X, its up on screen −Z and the eye above it +Y. In metres:
 * `{ eye, target, up }` and the frustum's `halfWidth`, `halfHeight`, `near`,
 * `far`.
 */
export function insetView(view, width, height, radius, surface) {
  const right0 = view.mirror ? [-1, 0, 0] : [1, 0, 0];
  const up0 = [0, 0, -1];
  const back0 = view.mirror ? [0, -1, 0] : [0, 1, 0];
  const [c, s] = [Math.cos(view.rotation), Math.sin(view.rotation)];
  const up1 = right0.map((v, i) => -s * v + c * up0[i]);
  const tilt = view.tilt || 0;
  const [ct, st] = [Math.cos(tilt), Math.sin(tilt)];
  const back = back0.map((v, i) => ct * v - st * up1[i]);
  const up = up1.map((v, i) => st * back0[i] + ct * v);
  const target = [view.center.x / 1000, surface, view.center.y / 1000];
  const eye = target.map((v, i) => v + back[i] * radius * 2);
  const perPixel = 1 / (view.zoom * 1000);
  return { eye, target, up, halfWidth: (width * perPixel) / 2, halfHeight: (height * perPixel) / 2, near: 0, far: radius * 4 };
}
