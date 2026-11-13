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
// THE BOARD'S EDGE cuts the copper as milling cuts a board: nothing of it is
// drawn off the board's body, so a pad, a track or a zone that runs past the
// outline, or the ring of a hole on the edge, ends at the edge. The body is the
// `.glb`'s `PCB`, whose top face (`bodyTop`) KiCad cuts the outline's cutouts
// and the pads' drills out of (not the vias': the hub exports it without
// `--cut-vias-in-body`); it is a second mask on the drills' grid
// (`boardMask`). A sheet is discarded off it. A barrel's wall lies on its
// drill's edge, where for a pad's drill the mask is halfway, so a barrel is
// read a little outward of its wall instead: board there for a hole inside
// the board, empty beyond the edge for the half of a plated hole the edge cuts
// through. A board with no `PCB` is not cut. The raycaster still meets the
// triangles the shader discards, so a click keeps a hit on copper only where
// the copper is drawn (`onBoard`).
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
 *  separation thins and Isolate hides; `body`, the board's body (`PCB`), whose
 *  edge cuts our copper (`bodyTop`). */
export function glbLayers(layers, parser) {
  const out = { copper: [], skin: [], board: [], body: [] };
  for (const node of layers) {
    const kind = glbLayerKind(node, parser);
    if (GLB_COPPER.has(kind)) {
      out.copper.push(node);
      continue;
    }
    out.board.push(node);
    if (GLB_SKIN.has(kind)) out.skin.push(node);
    if (kind === 'PCB') out.body.push(node);
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

/** How near the body's top a vertex lies on its top face, in mm: the `.glb`
 *  is float32 metres, a ten-thousandth of a micrometre at a board's height. */
const TOP_TOLERANCE = 0.001;

/** How many rows of the board mask are summed at once (`boardMask`): a band's
 *  sums are all it holds besides the mask, 2 MB at 4096 texels a row. */
const MASK_BAND = 128;

/** How many texels past its wall a barrel reads the board mask: clear of the
 *  drill's edge, where the mask is halfway, by more than the texel the
 *  lookup blurs over. */
const BARREL_REACH = 2;

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
 * The top face of the board's body, `nodes` (the `.glb`'s `PCB`, `glbLayers`),
 * as triangles in the board's mm, a vertex's x and y, in the frame of `root`,
 * which our copper is drawn in: those of its triangles whose three corners lie
 * at its top, the height of its highest vertex. The walls and the bottom face
 * are left out.
 */
export function bodyTop(THREE, nodes, root) {
  root.updateWorldMatrix(true, false);
  const inverse = root.matrixWorld.clone().invert();
  const meshes = [];
  for (const node of nodes) node.traverse((object) => object.isMesh && meshes.push(object));
  const point = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const corners = meshes.map((mesh) => {
    mesh.updateWorldMatrix(true, false);
    matrix.multiplyMatrices(inverse, mesh.matrixWorld);
    const { position } = mesh.geometry.attributes;
    const xyz = new Float64Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(matrix).multiplyScalar(1000).toArray(xyz, i * 3);
    }
    return { xyz, index: mesh.geometry.index };
  });
  let top = -Infinity;
  for (const { xyz } of corners) for (let i = 1; i < xyz.length; i += 3) top = Math.max(top, xyz[i]);
  const out = [];
  for (const { xyz, index } of corners) {
    const count = index ? index.count : xyz.length / 3;
    for (let i = 0; i + 2 < count; i += 3) {
      const at = [i, i + 1, i + 2].map((k) => (index ? index.getX(k) : k));
      if (at.every((v) => top - xyz[v * 3 + 1] < TOP_TOLERANCE)) for (const v of at) out.push(xyz[v * 3], xyz[v * 3 + 2]);
    }
  }
  return Float32Array.from(out);
}

/**
 * The board's body over the drills' grid (`grid`, a `holeMask`: the same box
 * and texel) as a mask: a byte per texel, how much of it the body's top face
 * (`triangles`, `bodyTop`) covers, 255 all of it, so that a linear lookup
 * halfway up lies on the board's edge, as on a drill's.
 *
 * The cover is the exact area, filled as font-rs fills a glyph: each edge of
 * each triangle, every triangle turned the same way, adds to the texels it
 * crosses the area it leaves to its right, a running sum along a row makes
 * that the cover, and an edge two triangles share cancels. Only the texels an
 * edge crosses are touched, a band of `MASK_BAND` rows at a time; the edges
 * are clamped to the grid's sides, past which nothing is read, so in the row
 * where an edge of the body crosses the grid's left or right side the cover
 * of the texels next to that side is approximate.
 */
export function boardMask(triangles, grid) {
  const { width, height, x0, y0, texel } = grid;
  // The edges in texels, each [x, y, x, y], those that run along a row dropped:
  // they cover nothing.
  const edges = [];
  for (let i = 0; i + 5 < triangles.length; i += 6) {
    const p = [0, 2, 4].map((k) => [(triangles[i + k] - x0) / texel, (triangles[i + k + 1] - y0) / texel]);
    const turn = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    if (!turn) continue;
    if (turn < 0) [p[1], p[2]] = [p[2], p[1]];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [p[k], p[(k + 1) % 3]];
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const data = new Uint8Array(width * height);
  const stride = width + 2;
  const sums = new Float32Array(stride * MASK_BAND);
  for (let r0 = 0; r0 < height; r0 += MASK_BAND) {
    const r1 = Math.min(height, r0 + MASK_BAND);
    sums.fill(0);
    for (const edge of edges) {
      if (Math.max(edge[1], edge[3]) > r0 && Math.min(edge[1], edge[3]) < r1) coverEdge(sums, stride, width, r0, r1, edge);
    }
    for (let y = r0; y < r1; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += sums[(y - r0) * stride + x];
        data[y * width + x] = Math.round(Math.min(1, Math.abs(sum)) * 255);
      }
    }
  }
  return data;
}

/** What `edge` (`boardMask`, in texels) adds to the `sums` of rows `r0` to
 *  `r1` (`stride` a row, x clamped to 0 to `width`): font-rs's `draw_line`. */
function coverEdge(sums, stride, width, r0, r1, [ax, ay, bx, by]) {
  const dir = ay < by ? 1 : -1;
  if (dir < 0) [ax, ay, bx, by] = [bx, by, ax, ay];
  const dxdy = (bx - ax) / (by - ay);
  const clampX = (x) => Math.min(width, Math.max(0, x));
  for (let y = Math.max(r0, Math.floor(ay)); y < Math.min(r1, Math.ceil(by)); y++) {
    const top = Math.max(y, ay);
    const bottom = Math.min(y + 1, by);
    const d = (bottom - top) * dir;
    const x = clampX(ax + (top - ay) * dxdy);
    const xnext = clampX(ax + (bottom - ay) * dxdy);
    const row = (y - r0) * stride;
    const left = Math.min(x, xnext);
    const right = Math.max(x, xnext);
    const leftFloor = Math.floor(left);
    const rightCeil = Math.ceil(right);
    if (rightCeil <= leftFloor + 1) {
      const middle = 0.5 * (x + xnext) - leftFloor;
      sums[row + leftFloor] += d - d * middle;
      sums[row + leftFloor + 1] += d * middle;
      continue;
    }
    const s = 1 / (right - left);
    const leftPart = left - leftFloor;
    const a0 = 0.5 * s * (1 - leftPart) * (1 - leftPart);
    const rightPart = right - rightCeil + 1;
    const am = 0.5 * s * rightPart * rightPart;
    sums[row + leftFloor] += d * a0;
    if (rightCeil === leftFloor + 2) {
      sums[row + leftFloor + 1] += d * (1 - a0 - am);
    } else {
      const a1 = s * (1.5 - leftPart);
      sums[row + leftFloor + 1] += d * (a1 - a0);
      for (let xi = leftFloor + 2; xi < rightCeil - 1; xi++) sums[row + xi] += d * s;
      const a2 = a1 + (rightCeil - leftFloor - 3) * s;
      sums[row + rightCeil - 1] += d * (1 - a2 - am);
    }
    sums[row + rightCeil] += d * am;
  }
}

/**
 * The shader of our copper: three's standard material with a net index on
 * every vertex (`netIndex`) and the uniforms `shared` holds, one object for
 * every layer's material: `litNet`, the lit net's code or −1; `isolate`, only
 * that net drawn; `accent`, the selection colour it is lit in; `dimTo`, the
 * canvas's colour in sRGB, which the rest of the copper fades into (`DIM`);
 * `holeMap` and
 * `holeBox`, the drills' mask (`holeMask`) as a texture and where it lies,
 * which a sheet (`holed`) is discarded over; `boardMap`, the body's mask on
 * the same grid (`boardMask`), which a sheet is discarded off, and a barrel
 * off where it reads it, `outward` (a vertex's, in mm) past its wall. The lit
 * net takes no metal, so
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
        + 'varying vec2 vBoard;\n#ifndef BOARD3D_HOLES\nattribute vec2 outward;\nvarying vec2 vOutward;\n#endif\n'
        + '#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNet = netIndex;\nvBoard = position.xz * 1000.0;\n'
        + '#ifndef BOARD3D_HOLES\nvOutward = outward;\n#endif')
      .replace('#include <project_vertex>', '#include <project_vertex>\n'
        + 'if ( litNet >= 0.0 && abs( netIndex - litNet ) < 0.5 ) {\n'
        + '  mvPosition.xyz += ( isPerspectiveMatrix( projectionMatrix ) ? - normalize( mvPosition.xyz )'
        + ` : vec3( 0.0, 0.0, 1.0 ) ) * ${LIT_LIFT.toFixed(6)};\n`
        + '  gl_Position = projectionMatrix * mvPosition;\n}');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'uniform float litNet;\nuniform bool isolate;\nuniform vec3 accent;\n'
        + 'uniform vec3 dimTo;\nuniform sampler2D holeMap;\nuniform sampler2D boardMap;\nuniform vec4 holeBox;\n'
        + 'varying float vNet;\nvarying vec2 vBoard;\n#ifndef BOARD3D_HOLES\nvarying vec2 vOutward;\n#endif\n'
        + '#include <common>')
      .replace('#include <color_fragment>', '#include <color_fragment>\n'
        + '#ifdef BOARD3D_HOLES\n'
        + 'vec2 holeAt = ( vBoard - holeBox.xy ) * holeBox.zw;\n'
        + 'if ( texture2D( holeMap, holeAt ).r > 0.5 || texture2D( boardMap, holeAt ).r < 0.5 ) discard;\n'
        + '#else\n'
        + 'if ( texture2D( boardMap, ( vBoard + vOutward - holeBox.xy ) * holeBox.zw ).r < 0.5 ) discard;\n'
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

/** A mask's value (`data` on the grid of `grid`, a `holeMask`), 0 to 1, at the
 *  board's mm point `x`, `y`, as the shader's linear lookup of its texture
 *  reads it: between the four nearest texel centres, the edge texels held past
 *  the grid as the texture's clamp to its edge holds them. */
export function maskAt(grid, data, x, y) {
  const { width, height, x0, y0, texel } = grid;
  const [u, v] = [(x - x0) / texel - 0.5, (y - y0) / texel - 0.5];
  const [i, j] = [Math.floor(u), Math.floor(v)];
  const [fu, fv] = [u - i, v - j];
  const at = (a, b) => data[Math.min(height - 1, Math.max(0, b)) * width + Math.min(width - 1, Math.max(0, a))] / 255;
  return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
}

/** A mask (`holeMask`, `boardMask`) as a texture the shader reads linearly. */
function maskTexture(THREE, data, width, height) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  return Object.assign(texture, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    unpackAlignment: 1, needsUpdate: true });
}

/**
 * Our copper (`copper`, what `getBoardCopper` hands, with `colours`, each
 * layer's CSS colour by its name, and `body`, the top face of the board's body,
 * `bodyTop`, or null for none, which cuts nothing: its mask is a single full
 * texel) as three objects: `group`, holding a mesh per
 * layer and one of every barrel; `layers`, each `{ name, mesh, material,
 * colour }`, the layer's own colour as a three colour; `barrels`, the barrels'
 * mesh and, per vertex, the layer whose height it follows and its height there
 * (`ends`, `heights`), which `place` moves; `nets`, the names by code;
 * `shared`, the uniforms of the shader (`copperMaterial`); `base`, the copper's
 * own colour; `diagonal`, what the separation's gap is scaled by; and
 * `onBoard(x, y)`, whether the shader draws copper at the board's mm point
 * (a barrel's read past its wall), which a click's hit is kept by.
 */
export function copperModel(THREE, copper, colours, body) {
  const box = copperBox(copper) || { x0: 0, y0: 0, x1: 0, y1: 0 };
  const mask = holeMask(copper, box);
  const holeMap = maskTexture(THREE, mask.data, mask.width, mask.height);
  const board = body ? boardMask(body, mask) : null;
  const boardMap = board ? maskTexture(THREE, board, mask.width, mask.height)
    : maskTexture(THREE, new Uint8Array([255]), 1, 1);
  const onBoard = (x, y) => !board || maskAt(mask, board, x, y) >= 0.5;
  const shared = { litNet: { value: -1 }, isolate: { value: false }, accent: { value: new THREE.Color() },
    dimTo: { value: new THREE.Color() }, holeMap: { value: holeMap }, boardMap: { value: boardMap },
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
  // Its `outward` reaches about BARREL_REACH texels past the drill's circle
  // from anywhere on a side, the middle of one too, which lies inside the
  // circle by the sagitta: the side's corners reach out by that much more, and
  // between them the reach shrinks as the side's distance from the axis does.
  const sides = copper.barrels.length * BARREL_SIDES * 6;
  const position = new Float32Array(sides * 3);
  const outward = new Float32Array(sides * 2);
  const netIndex = new Float32Array(sides);
  const ends = new Uint8Array(sides);
  const heights = new Float32Array(sides);
  let at = 0;
  for (const barrel of copper.barrels) {
    const top = [barrel.from, copper.layers[barrel.from].top];
    const bottom = [barrel.to, copper.layers[barrel.to].bottom];
    const reach = barrel.radius * (1 - Math.cos(Math.PI / BARREL_SIDES)) + BARREL_REACH * mask.texel;
    for (let i = 0; i < BARREL_SIDES; i++) {
      const a = (i / BARREL_SIDES) * 2 * Math.PI;
      const b = ((i + 1) / BARREL_SIDES) * 2 * Math.PI;
      for (const [angle, [layer, height]] of [[a, top], [b, top], [a, bottom], [a, bottom], [b, top], [b, bottom]]) {
        position[at * 3] = (barrel.x + barrel.radius * Math.cos(angle)) / 1000;
        position[at * 3 + 2] = (barrel.y + barrel.radius * Math.sin(angle)) / 1000;
        outward[at * 2] = reach * Math.cos(angle);
        outward[at * 2 + 1] = reach * Math.sin(angle);
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
  geometry.setAttribute('outward', new THREE.BufferAttribute(outward, 2));
  const material = copperMaterial(THREE, shared, base.clone(), false);
  const tubes = new THREE.Mesh(geometry, material);
  tubes.userData.board3dCopper = true;
  group.add(tubes);
  const barrels = { mesh: tubes, material, ends, heights };
  place(stackOffsets(0, 0, count), layers, barrels);
  return { group, layers, barrels, nets: copper.nets, shared, base, diagonal: Math.hypot(box.x1 - box.x0, box.y1 - box.y0),
    onBoard };
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
