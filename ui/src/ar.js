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
//
// A browser with no Quick Look but WebXR AR (Chrome on an ARCore phone) is
// shown the same scene on the page itself, in an `immersive-ar` session
// (`requestXr`, `showXr`): at 1:1, ahead of where the phone was when the
// session began (`arPlacement`). No floor is looked for, so the model stands in
// the air in front of the reader.

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

/** Whether this browser opens a WebXR `immersive-ar` session: a promise, as
 *  WebXR answers. False where there is no WebXR (Safari, an insecure page) or
 *  it refuses the question. */
export function xrSupported() {
  const xr = navigator.xr;
  if (!xr) return Promise.resolve(false);
  return xr.isSessionSupported('immersive-ar').catch(() => false);
}

/** The nearest the model's middle stands to the phone in WebXR, in metres: a
 *  small part nearer than this would be held under the reader's nose. */
export const XR_NEAREST = 0.5;

/** How far below the horizon the reader looks to the model's middle in WebXR,
 *  in radians: a little below eye level, as at a thing on a table. An angle
 *  rather than a height, so the model is as far into the view near and far. */
export const XR_DIP = (10 * Math.PI) / 180;

/**
 * Where `arScene`'s root stands in a WebXR `local` space: `{ x, y, z }` in
 * metres, for a model whose box, as `arScene` stands it (bottom at y = 0,
 * middle over the origin), is `size` in metres. The space's origin is the
 * phone at the session's start, its −Z straight ahead and its Y up. The
 * model's middle comes straight ahead at one and a half times its largest
 * dimension and never nearer than `XR_NEAREST`, so the whole of it stands
 * ahead of the phone, `XR_DIP` below eye level. Whether all of it is in the
 * view is not promised: a phone held upright shows some 30–40° across, and a
 * wide model is seen whole by stepping back. A step, never a scale: the model
 * stays at 1:1.
 */
export function arPlacement(size) {
  const distance = Math.max(XR_NEAREST, 1.5 * Math.max(size.x, size.y, size.z));
  return { x: 0, y: -distance * Math.tan(XR_DIP) - size.y / 2, z: -distance };
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

/**
 * Ask for the WebXR session `View in AR` opens where there is no Quick Look:
 * `immersive-ar`, with a DOM overlay that holds one button, ×, ending it, as
 * the system's back gesture also does. Called synchronously in the tap, before
 * anything is awaited: the request needs the tap's user activation (three's
 * `ARButton`, examples/jsm/webxr/ARButton.js, asks the same way). The overlay
 * is put in the page hidden and leaves it when the session ends or is
 * refused. Returns a promise of `{ session, shown }`: `shown()` shows the ×,
 * called once the scene is set in the session, as `ARButton` shows its own.
 */
export function requestXr() {
  const overlay = document.createElement('div');
  overlay.style.display = 'none';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'close AR');
  Object.assign(close.style, {
    position: 'absolute', top: '16px', right: '16px', width: '44px', height: '44px',
    padding: '0', border: '1px solid var(--line)', borderRadius: '50%',
    background: 'var(--float-bg)', color: 'var(--text)', font: '28px/42px sans-serif',
  });
  overlay.append(close);
  document.body.append(overlay);
  return navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['dom-overlay'], domOverlay: { root: overlay },
  }).then((session) => {
    close.addEventListener('click', () => session.end());
    session.addEventListener('end', () => overlay.remove());
    return { session, shown: () => { overlay.style.display = ''; } };
  }, (error) => {
    overlay.remove();
    throw error;
  });
}

/**
 * Show the parts drawn out of `groups` (`arScene`) in WebXR `session`, at 1:1
 * where `arPlacement` stands them in the session's `local` space. On a
 * renderer and a canvas of its own, so the viewer's stay as they are, of the
 * one three the viewer draws with; lit by a hemisphere light and a directional
 * one, as the parts are painted MeshStandardMaterial. Settles once the session
 * shows the scene. When the session ends the loop stops and the renderer goes,
 * its GL context and its canvas with it: a context left to the garbage
 * collector counts against the few a page may hold, and the browser makes
 * room by losing the oldest, the viewer's own.
 */
export async function showXr(THREE, groups, session) {
  const model = arScene(THREE, groups);
  const at = arPlacement(new THREE.Box3().setFromObject(model, true).getSize(new THREE.Vector3()));
  model.position.set(at.x, at.y, at.z);
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
  sun.position.set(1, 3, 2);
  const scene = new THREE.Scene();
  scene.add(model, new THREE.HemisphereLight(0xffffff, 0x808080, Math.PI), sun);
  // The session draws through its own views, which take only the near and far
  // planes from this camera: a centimetre to a hundred metres.
  const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.domElement.style.display = 'none';
  document.body.append(renderer.domElement);
  const drop = () => {
    renderer.setAnimationLoop(null);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  // A session can end while it is being set, as `setSession` awaits its
  // reference space: three's own listener puts the renderer back then, and
  // `setSession` may still resolve, on a session that is over.
  let ended = false;
  const end = () => { ended = true; };
  session.addEventListener('end', end);
  try {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    // Before the session, as three's examples set it: `setSession` hands the
    // loop to the session's frames and stops the window's. Set after, it would
    // start the window's again, drawing outside the session's frames too.
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
    await renderer.xr.setSession(session);
    if (ended) throw new Error('the session ended as it was set');
  } catch (error) {
    drop();
    throw error;
  } finally {
    session.removeEventListener('end', end);
  }
  // Listened for only now, after `setSession`'s own listener, which puts the
  // renderer back from the session and must find it whole.
  session.addEventListener('end', drop);
}
