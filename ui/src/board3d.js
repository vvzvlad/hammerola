// The parts of a board's 3D model, as KiCad exports it, and what the 3D view
// (BoardView3D.jsx) does to them: pure, so ui/tests/board3d.test.js runs them on
// three's own objects without a GPU.
//
// WHAT A KICAD `.glb` LOOKS LIKE (`kicad-cli pcb export glb`, KiCad 10, written
// by Open CASCADE): the scene has one unnamed top node, and that node's children
// are of two kinds.
//   * A PART: a node named by the footprint's designator (`C523`, `R104`,
//     `CM202`, `FB101`), placed and turned on the board; its meshes are below it,
//     one level down for most parts, a few levels down for a model built of
//     several bodies (whose inner nodes are named by bare numbers).
//   * A LAYER of the board itself — the body, solder mask, silkscreen, and in an
//     export with tracks the copper, pads and vias: a node carrying a mesh and
//     named by an XCAF label tag, `=>[0:1:1:98]`, the name OCCT gives a shape
//     KiCad did not name.
// So the designator rule is: a child of the top node is a part, named by its
// glTF name, unless that name is a label tag. Measured on a real export of a
// 231-part board, every top-level name either was a designator or was one of the
// layer tags; no inner node's name is ever read.
//
// three's GLTFLoader keeps the glTF name in `userData.name` and puts a
// SANITISED one in `name` (`[`, `]`, `.`, `:`, `/` removed, made unique), so the
// tag `=>[0:1:1:98]` is `=>01198` there and a designator with a dot would lose
// it. The rule reads `userData.name`.
//
// three and its add-ons come by URL, never bundled and never by a bare `three`:
// the reasons are `ui/src/viewport/library.js`'s, and the add-ons import three
// from beside themselves (static/_v/PROVENANCE.md), so all of them share the one
// instance the page imports here.

/** Where the hub serves three and the add-ons this view uses. */
export const THREE_URL = '/_v/three.module.js';
export const GLTF_LOADER_URL = '/_v/GLTFLoader.js';
export const ORBIT_CONTROLS_URL = '/_v/OrbitControls.js';
export const GEOMETRY_UTILS_URL = '/_v/BufferGeometryUtils.js';

let pending = null;

/**
 * `{ THREE, GLTFLoader, OrbitControls, mergeGeometries }`, fetched once per page.
 * A rejected import is dropped, so opening the 3D view again tries again
 * (`loadViewerLibrary` says why).
 */
export function loadThree() {
  if (!pending) {
    pending = Promise.all([
      import(/* @vite-ignore */ THREE_URL),
      import(/* @vite-ignore */ GLTF_LOADER_URL),
      import(/* @vite-ignore */ ORBIT_CONTROLS_URL),
      import(/* @vite-ignore */ GEOMETRY_UTILS_URL),
    ]).then(([THREE, loader, controls, utils]) => ({
      THREE, GLTFLoader: loader.GLTFLoader, OrbitControls: controls.OrbitControls,
      mergeGeometries: utils.mergeGeometries,
    }), (error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** The name OCCT gives a shape KiCad left unnamed: a layer of the board. */
const LABEL_TAG = /^=>\[[\d:]*\]$/;

/** The designator a top-level node of the export names, or null for a layer
 *  of the board (or a node with no name). */
export function designatorOf(node) {
  const name = node.userData && node.userData.name;
  return typeof name === 'string' && name && !LABEL_TAG.test(name) ? name : null;
}

/** The node whose children are the parts and the layers: the scene's single
 *  unnamed top node, however deep the loader nests it. */
export function exportRoot(scene) {
  let root = scene;
  while (root.children.length === 1 && root.children[0].children.length && !designatorOf(root.children[0])) {
    [root] = root.children;
  }
  return root;
}

/** The parts of an export, by designator: the top-level nodes that carry it —
 *  one, unless the board repeats a designator. */
export function partsOf(scene) {
  const parts = new Map();
  for (const node of exportRoot(scene).children) {
    const designator = designatorOf(node);
    if (designator) parts.set(designator, [...(parts.get(designator) || []), node]);
  }
  return parts;
}

/** The designator of the part `object` is (in), or null for a layer of the
 *  board or anything not under `root`. */
export function partOf(object, root) {
  for (let node = object; node && node.parent; node = node.parent) {
    if (node.parent === root) return designatorOf(node);
  }
  return null;
}

/** The part a click picked, from the raycaster's hits nearest first: the
 *  nearest thing decides, so the board in front of a part hides it. */
export const pickedPart = (hits, root) => (hits.length ? partOf(hits[0].object, root) : null);

/**
 * Turn a node's meshes into one mesh per material, under the node itself.
 *
 * The loader makes a mesh of every glTF primitive, and KiCad writes a primitive
 * per face: 14 238 meshes for a 231-part board, a draw call each. Merged per
 * part and per layer, by material, they are a few hundred. A part keeps its own
 * meshes (it is still highlighted and picked as a whole); the node's transform
 * is untouched, each mesh's own one below it is baked into the vertices. A group
 * the geometry utility cannot merge (attributes that differ) is left as it was.
 */
export function mergeByMaterial(THREE, mergeGeometries, node) {
  node.updateWorldMatrix(true, true);
  const inverse = node.matrixWorld.clone().invert();
  const byMaterial = new Map();
  node.traverse((object) => {
    if (object === node || !object.isMesh || Array.isArray(object.material)) return;
    byMaterial.set(object.material, [...(byMaterial.get(object.material) || []), object]);
  });
  const replaced = new Set();
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const local = new THREE.Matrix4();
    const geometry = mergeGeometries(meshes.map((mesh) => mesh.geometry.clone()
      .applyMatrix4(local.multiplyMatrices(inverse, mesh.matrixWorld))));
    if (!geometry) continue;
    node.add(new THREE.Mesh(geometry, material));
    for (const mesh of meshes) {
      mesh.removeFromParent();
      replaced.add(mesh.geometry);
    }
  }
  // The loader shares a geometry between primitives that read the same data.
  node.traverse((object) => replaced.delete(object.geometry));
  for (const geometry of replaced) geometry.dispose();
  prune(node);
}

/** Drop the empty containers a merge left behind. */
function prune(node) {
  for (const child of [...node.children]) {
    prune(child);
    if (!child.children.length && (child.type === 'Object3D' || child.type === 'Group')) child.removeFromParent();
  }
}

/**
 * Make a part's material that names a colour only a plain, non-metal one.
 *
 * KiCad writes a part's colours as a bare `baseColorFactor`, and glTF's default
 * metallic factor is 1: three draws every part a mirror, which with no
 * environment to reflect is near black. The board's own layers name their
 * factor (0) and are left alone, as is anything with a texture. Read off the
 * glTF itself (`parser.json`, `parser.associations`), not guessed from values.
 */
export function plainColours(scene, parser) {
  const definitions = (parser.json && parser.json.materials) || [];
  scene.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of [].concat(object.material)) {
      const at = parser.associations.get(material);
      const pbr = at && definitions[at.materials] && (definitions[at.materials].pbrMetallicRoughness || {});
      if (pbr && pbr.metallicFactor === undefined && !pbr.metallicRoughnessTexture) material.metalness = 0;
    }
  });
}

/**
 * Light a part in `colour`, or put it back (`colour` null).
 *
 * Parts share materials (every 0603 capacitor's body is one), so lighting one
 * swaps in a copy of its own: each mesh's material is cloned the first time its
 * part is lit, kept beside the shared one (`userData.board3d`), and reused after.
 */
export function light(nodes, colour) {
  for (const node of nodes) {
    node.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const own = mesh.userData.board3d || (mesh.userData.board3d = { shared: mesh.material, lit: null });
      if (!colour) {
        mesh.material = own.shared;
        return;
      }
      if (!own.lit) own.lit = own.shared.clone();
      own.lit.color.copy(colour);
      if (own.lit.emissive) own.lit.emissive.copy(colour).multiplyScalar(0.3);
      mesh.material = own.lit;
    });
  }
}

/**
 * Where a perspective camera stands to show `box` whole, looking along
 * `-direction` (a unit vector from the box to the camera): its bounding sphere,
 * `margin` times as large and at least `least` in radius, fits the narrower
 * side of the view. `{ target, position }`.
 */
export function frameBox(THREE, box, direction, fov, aspect, margin, least = 0) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius * margin, least);
  const half = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const narrow = Math.atan(half * Math.min(1, aspect));
  return {
    target: sphere.center.clone(),
    position: sphere.center.clone().addScaledVector(direction, radius / Math.sin(narrow)),
  };
}

/** Free what a model holds: its geometries and materials, the lit copies too. */
export function disposeModel(model) {
  const held = new Set();
  model.traverse((object) => {
    if (object.geometry) held.add(object.geometry);
    for (const material of [].concat(object.material || [])) held.add(material);
    const own = object.userData && object.userData.board3d;
    if (own) [own.shared, own.lit].forEach((material) => material && held.add(material));
  });
  for (const thing of held) thing.dispose();
}
