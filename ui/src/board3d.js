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

/** Where the hub serves three and the add-ons this view uses. The camera is
 *  turned by the model's own trackball, `CADTrackballControls`, which the
 *  model's library exports (viewer/src/index.ts): the same URL as the
 *  model page's (`VIEWER_MODULE_URL` in viewport/library.js), so on that page
 *  the browser hands this import the module already loaded. */
export const THREE_URL = '/_v/three.module.js';
export const GLTF_LOADER_URL = '/_v/GLTFLoader.js';
export const TRACKBALL_URL = '/_v/three-cad-viewer.esm.js';
export const GEOMETRY_UTILS_URL = '/_v/BufferGeometryUtils.js';

let pending = null;

/**
 * `{ THREE, GLTFLoader, TrackballControls, mergeGeometries }`, fetched once
 * per page. A rejected import is dropped, so opening the 3D view again tries
 * again (`loadViewerLibrary` says why).
 */
export function loadThree() {
  if (!pending) {
    pending = Promise.all([
      import(/* @vite-ignore */ THREE_URL),
      import(/* @vite-ignore */ GLTF_LOADER_URL),
      import(/* @vite-ignore */ TRACKBALL_URL),
      import(/* @vite-ignore */ GEOMETRY_UTILS_URL),
    ]).then(([THREE, loader, library, utils]) => ({
      THREE, GLTFLoader: loader.GLTFLoader, TrackballControls: library.CADTrackballControls,
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

/** Millimetres in a unit of the model: glTF's unit is the metre, and a
 *  comment's point is in millimetres, as the model page's are. */
export const MM_PER_UNIT = 1000;

/**
 * Where a comment hangs on the part a raycaster's `hit` is on, in that part's
 * own frame (SPEC 7A.1, `frame: "part"`): `{ part, point, normal }`, or null
 * for a hit on a layer of the board. The node is the part's top-level node
 * the hit is under — its transform is the footprint's placement, which
 * `mergeByMaterial` leaves alone — and the point is taken out of the world
 * through the inverse of its world matrix at the click, in millimetres
 * (`MM_PER_UNIT`). The normal is the hit face's, in the world through its
 * mesh's normal matrix, turned toward the camera along whose ray `toward` the
 * click looked, and taken into the part's frame by the inverse's normal
 * matrix: a rotation, a scale on the way being divided out, not applied.
 */
export function partPlace(THREE, hit, root, toward) {
  let node = hit.object;
  while (node && node.parent !== root) node = node.parent;
  const part = node ? designatorOf(node) : null;
  if (!part) return null;
  node.updateWorldMatrix(true, false);
  const inverse = node.matrixWorld.clone().invert();
  let normal = null;
  if (hit.face) {
    const world = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
    if (world.dot(toward) > 0) world.negate();
    normal = world.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(inverse)).toArray();
  }
  return { part, point: hit.point.clone().applyMatrix4(inverse).multiplyScalar(MM_PER_UNIT).toArray(), normal };
}

/** A point and a normal of part `node`'s own frame (`partPlace`) in the world
 *  as it stands: `{ p, n }`, three vectors, `n` null where `normal` is. */
export function fromPart(THREE, node, point, normal) {
  node.updateWorldMatrix(true, false);
  return {
    p: new THREE.Vector3(...point).divideScalar(MM_PER_UNIT).applyMatrix4(node.matrixWorld),
    n: normal ? new THREE.Vector3(...normal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(node.matrixWorld))
      : null,
  };
}

/**
 * Turn a node's meshes into one mesh per material, under the node itself.
 *
 * The loader makes a mesh of every glTF primitive, and KiCad writes a primitive
 * per face: 14 238 meshes for a 231-part board, a draw call each. Merged per
 * part and per layer, by material, they are a few hundred. A part keeps its own
 * meshes (it is still highlighted and picked as a whole); the node's transform
 * is untouched, each mesh's own one below it is baked into the vertices. A group
 * the geometry utility cannot merge (attributes that differ) is left as it was.
 *
 * It runs on the page's main thread over the whole board (42 330 meshes on
 * dionis), so it is written for that count. A geometry no other mesh uses is
 * moved into place where it is rather than copied first; one in `shared`
 * (`sharedGeometries`: the loader hands one geometry to every primitive that
 * names the same accessors, across parts) is copied, or the other users would
 * move with it (on dionis 864 sets of accessors are named by more than one
 * primitive; no mesh is drawn by two nodes, the loader's other way to share).
 * A geometry is the unit of sharing because OCCT, which writes KiCad's export,
 * names an accessor only in primitives with the same set (none of the 109 407
 * on dionis is in two sets): one attribute shared between two different
 * geometries would move with either. A group the utility then refuses is moved
 * back. The merged
 * meshes leave their parents in one pass per parent (`sweep`): three's `remove`
 * searches the parent's children for each one, which over thousands of
 * siblings is quadratic.
 */
export function mergeByMaterial(THREE, mergeGeometries, node, shared) {
  node.updateWorldMatrix(true, true);
  const inverse = node.matrixWorld.clone().invert();
  const byMaterial = new Map();
  node.traverse((object) => {
    if (object === node || !object.isMesh || Array.isArray(object.material)) return;
    const meshes = byMaterial.get(object.material);
    if (meshes) meshes.push(object);
    else byMaterial.set(object.material, [object]);
  });
  const merged = new Set();
  const local = new THREE.Matrix4();
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const geometry = mergeGeometries(meshes.map((mesh) => (shared.has(mesh.geometry) ? mesh.geometry.clone() : mesh.geometry)
      .applyMatrix4(local.multiplyMatrices(inverse, mesh.matrixWorld))));
    if (!geometry) {
      for (const mesh of meshes) {
        if (!shared.has(mesh.geometry)) mesh.geometry.applyMatrix4(local.multiplyMatrices(inverse, mesh.matrixWorld).invert());
      }
      continue;
    }
    node.add(new THREE.Mesh(geometry, material));
    for (const mesh of meshes) merged.add(mesh);
  }
  sweep(node, merged);
}

/** The geometries more than one mesh under `root` draws. */
export function sharedGeometries(root) {
  const seen = new Set();
  const shared = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    if (seen.has(object.geometry)) shared.add(object.geometry);
    seen.add(object.geometry);
  });
  return shared;
}

/** Take the `merged` meshes out from under `node`, and the empty containers
 *  that leaves, rebuilding each list of children once. */
function sweep(node, merged) {
  node.children = node.children.filter((child) => {
    if (merged.has(child)) {
      child.parent = null;
      return false;
    }
    sweep(child, merged);
    if (!child.children.length && (child.type === 'Object3D' || child.type === 'Group')) {
      child.parent = null;
      return false;
    }
    return true;
  });
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
