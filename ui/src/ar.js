// View in AR: the model view on screen as a USDZ file, which iOS opens in AR
// Quick Look at 1:1 (SPEC §4, the row on augmented reality).
//
// The file is made in the browser, out of the faces the viewer draws, so the hub
// and the build do not change and a revision built before this has it too. It
// is written by three's own exporter (static/_v/USDZExporter.js, three r184),
// imported by URL as the board's loader is (board3d.js) and only when it is
// first asked for. The exporter imports three and the fflate it zips with from
// beside itself (static/_v/PROVENANCE.md), so the parts handed over here are of
// the one three the viewer draws with.
//
// What goes into the file is what the viewer draws of each part: its group's
// `front`, the mesh of its faces, unless the library hides it
// (`setShapeVisible`: the material off, or the mesh off in its studio mode).
// The rest of a group — back faces, edges, the caps of a cut, the points only
// picking sees — and what stands beside the model, the widgets and the grid,
// are not parts and do not go.
//
// USDZ is in metres with Y up, the model in millimetres with Z up. Every part
// keeps its placement in the model's frame, and one group above them turns that
// frame into USDZ's (`arScene`).

/** Where the hub serves three's USDZ exporter. */
export const USDZ_EXPORTER_URL = '/_v/USDZExporter.js';

/** The type a blob is made under for Quick Look: Safari refuses a file whose
 *  type is not USD's or `application/octet-stream`. */
export const USDZ_TYPE = 'model/vnd.usdz+zip';

/** A millimetre, in metres. */
export const MM = 0.001;

/** Appended to the file's address: Quick Look opens a model at 1:1 and lets a
 *  pinch rescale it, and this fragment, which Safari hands on to Quick Look,
 *  turns the pinch off, so the model stays at the 1:1 the view is for. */
export const AR_FRAGMENT = '#allowsContentScaling=0';

/** Whether this browser opens an `<a rel="ar">` in AR Quick Look: WebKit's
 *  own test. False where the question cannot be asked. */
export function arSupported() {
  try {
    return document.createElement('a').relList.supports('ar');
  } catch {
    return false;
  }
}

/**
 * The scene the exporter is handed: a copy of each part drawn out of `groups`,
 * the library's `nestedGroup.groups` (see the header for what a part is). A
 * copy shares the front's positions, normals and index, which the exporter
 * only reads, stands where the front stands in the model's frame (its world
 * matrix: the view's placement and the reader's Move), and is painted with a
 * MeshStandardMaterial of the front's colour, opacity (a ghosted part as faint
 * as on screen), metalness and roughness. The copies hang under a group scaled
 * by `MM` and turned −90° about X, which takes the model's +Z to USDZ's +Y, and
 * that group under the root returned: the exporter writes no transform for the
 * object it is given. The group is then shifted so the model's lowest point is
 * at y = 0 and its middle over the origin: the file is anchored to a
 * horizontal plane (the exporter's `preliminary:anchoring:type = "plane"`), and
 * where a model stands relative to its own origin is a fact of how it was
 * drawn, not of where it should stand on the floor.
 */
export function arScene(THREE, groups) {
  const turned = new THREE.Group();
  turned.scale.setScalar(MM);
  turned.rotation.x = -Math.PI / 2;
  for (const group of Object.values(groups || {})) {
    const front = group && group.front;
    if (!front || !front.visible || !front.material.visible) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', front.geometry.getAttribute('position'));
    geometry.setAttribute('normal', front.geometry.getAttribute('normal'));
    geometry.setIndex(front.geometry.getIndex());
    const { color, opacity, metalness, roughness } = front.material;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color, opacity, transparent: opacity < 1, metalness, roughness,
    }));
    front.updateWorldMatrix(true, false);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(front.matrixWorld);
    turned.add(mesh);
  }
  const root = new THREE.Group();
  root.add(turned);
  root.updateMatrixWorld(true);
  // Precise: the box of the vertices as they stand, not of each part's own box
  // turned, which is larger for a part turned off the axes and would leave a
  // round part floating over the floor.
  const box = new THREE.Box3().setFromObject(turned, true);
  if (!box.isEmpty()) {
    const middle = box.getCenter(new THREE.Vector3());
    turned.position.set(-middle.x, -box.min.y, -middle.z);
    root.updateMatrixWorld(true);
  }
  return root;
}

let pending = null;

/** The exporter's module, fetched once per page. A rejected import is dropped,
 *  so the next tap on `View in AR` tries again (`loadViewerLibrary` says why). */
function loadExporter() {
  if (!pending) {
    pending = import(/* @vite-ignore */ USDZ_EXPORTER_URL).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** The parts drawn out of `groups` (`arScene`) as the bytes of a USDZ file. */
export function usdzOf(THREE, groups) {
  return loadExporter().then(({ USDZExporter }) => new USDZExporter().parseAsync(arScene(THREE, groups)));
}

/**
 * Hand the file at `href` to AR Quick Look: a click on a link Safari takes for
 * one — `rel="ar"`, its one element an `<img>` (WebKit's
 * `isSystemPreviewLink`) — made for the click, hidden, and gone after it.
 * Safari starts the preview inside the click and holds the blob from there
 * (`URLKeepingBlobAlive` in WebKit's `HTMLAnchorElement::handleClick`), so the
 * caller may revoke the address as soon as this returns.
 */
export function openQuickLook(href) {
  const link = document.createElement('a');
  link.rel = 'ar';
  link.href = href;
  link.style.display = 'none';
  link.append(document.createElement('img'));
  document.body.append(link);
  link.click();
  link.remove();
}
