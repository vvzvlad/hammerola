// The grip on the section plane: a double-headed arrow standing on the cut, at
// the point where the plane meets the face that was clicked, and dragged to
// slide the plane along its own normal.
//
// WHY IT EXISTS. The drag has worked from the start — tools.js, the `cut` branch
// of `onMove` — and nothing on screen ever said so, so the only readers who
// found it were the ones who had been told. A gesture with no handle is a
// gesture that is not there for most people.
//
// AN OBJECT IN THE SCENE AND NOT A DIV OVER IT, which is what makes the arrow
// point along the plane's normal rather than along a picture of it. Drawn flat,
// every question the widget asked was a question about the SCREEN — which way
// the normal projects, how much of it survives the projection, what to do in the
// zone where the answer collapses — and each of those had to be computed,
// guarded and floored. A mesh lying on the plane is simply turned to the normal
// once and projected by the camera like everything else, so all of that is gone
// from this file. `scene3d.js` carries the half that is shared.
//
// A MODULE OF ITS OWN AND NOT PART OF overlay.js, though the four callbacks are
// the same shape. Two things differ and both are load-bearing: what this draws
// comes from the SECTION rather than from `state.pins`, and it carries a live
// drag, which the overlay's pins — a press, a click, nothing in between — do
// not.

import { internals } from "./internals.js";
import { watchDrag } from "./drag.js";
import { finite3 } from "./math.js";
import { createScene3D, widgetMaterial } from "./scene3d.js";
import { dragSection, sectionGripAxis, sectionOffset } from "./section.js";
import { reportCut } from "./tools.js";
import {
  HANDLE_CASE_PX, HANDLE_HEAD_PX, HANDLE_HIT_PX, HANDLE_PX,
  HANDLE_SHAFT_PX,
} from "./options.js";

/** The arrow's ink: the grip's own dark, the same number the DOM layer drew it
 *  in, as a hex the material takes rather than a CSS string. One colour for both
 *  themes, which is what every widget over this canvas does — the canvas is
 *  white or near-black depending on the reader's answer (`readTheme` in
 *  ui/src/store.js), so a widget picks a colour that stands on either. */
const INK = 0x2f353d;

/** The casing under it: white, the same ink the rotation handles stand their
 *  discs on (`CASING` in rings.js). It is what makes ONE dark colour honest on
 *  a canvas that is white on one theme and near-black on the other. */
const CASING = 0xffffff;

/** How round the shaft and the heads are.
 *
 * Twelve is where a cylinder two pixels across stops reading as a polygon at
 * any angle, and the whole widget is seven meshes: nothing here is worth an
 * adaptive count.
 */
const SIDES = 12;

export function createHandle(vp) {
  // The group, the place in the library's render pass, the pixel scale, the
  // press and the teardown are `scene3d.js`'s. `wanted`, `build`, `place` and
  // `onDown` are the declarations below; nothing is called until the first
  // `attach` and the first frame the library draws after it.
  const widget = createScene3D(vp, {
    wanted, build, place, press: onDown, cursor: "grab",
  });

  // The two vectors the orientation is computed with, kept rather than minted
  // per frame: this runs once per frame the library draws, which during an orbit
  // is every frame there is. Built with the group, because the namespace they
  // come from arrives with it.
  let up = null;
  let aim = null;

  // The gesture in progress: the screen axis measured at its start, and where
  // the pointer was at the previous event. Null between gestures.
  let drag = null;

  /**
   * The arrow, in CSS pixels along +Y — the axis three gives a cylinder and a
   * cone, so the orientation below is one rotation from +Y onto the plane's
   * normal rather than two.
   *
   * TWO MATERIALS AND NOT SEVEN, because the arrow is two pieces of colour
   * rather than seven shapes: every mesh of the ink shares one, every mesh of
   * the casing shares the other, so the renderer sorts two programs and there
   * are two things to keep in step. Nothing here ever tints one head and not the
   * other.
   *
   * THE HEADS ARE AS LONG AS THEY ARE WIDE, which is `HANDLE_HEAD_PX`'s whole
   * argument, and they sit at the ENDS: half the arrow's length minus half a
   * head, so the outermost point of each is exactly `HANDLE_PX / 2` from the
   * anchor. That is a promise about the INK: the casing stands `HANDLE_CASE_PX`
   * outside it on every side, tips included, exactly as the rotation handles'
   * rim stands outside `RING_PX`.
   */
  function build(three, group) {
    up = new three.Vector3(0, 1, 0);
    aim = new three.Vector3();
    const ink = widgetMaterial(three, INK);
    const casing = widgetMaterial(three, CASING);
    // THE ARROW IS DRAWN TWICE, and the order is the whole of the contrast.
    // `grow` is 0 for the ink and `HANDLE_CASE_PX` for the copy under it, whose
    // `renderOrder` of -1 puts it first WITHIN this group -- three carries a
    // group's own `renderOrder` down as the group order and sorts the subtree
    // inside it, so the two numbers do not fight. With no depth test, first
    // drawn is underneath, and a white body two pixels proud of a dark one is a
    // rim. `options.js` says why a rim rather than a shadow.
    for (const [grow, material, order] of
      [[HANDLE_CASE_PX, casing, -1], [0, ink, 0]]) {
      const shaft = new three.Mesh(
        new three.CylinderGeometry(HANDLE_SHAFT_PX / 2 + grow,
                                   HANDLE_SHAFT_PX / 2 + grow,
                                   HANDLE_PX - 2 * HANDLE_HEAD_PX, SIDES),
        material);
      shaft.renderOrder = order;
      group.add(shaft);
      for (const end of [1, -1]) {
        const head = new three.Mesh(
          new three.ConeGeometry(HANDLE_HEAD_PX / 2 + grow,
                                 HANDLE_HEAD_PX + 2 * grow, SIDES), material);
        head.position.y = (end * (HANDLE_PX - HANDLE_HEAD_PX)) / 2;
        // A cone points +Y, so the lower one is turned over. About Z because any
        // axis across Y does it and Z is the one the shaft is not on.
        if (end < 0) head.rotation.z = Math.PI;
        head.renderOrder = order;
        group.add(head);
      }
    }
    // THE TARGET IS FAT AND THE INK IS THIN, which is the same requirement the
    // DOM box carried and the reason `HANDLE_HIT_PX` survives the move: a hand
    // cannot reliably hit a 2 px shaft. A cylinder of that diameter around the
    // whole arrow is what the ray really meets.
    //
    // `visible = false` AND NOT a transparent material: three's raycaster tests
    // an object's LAYERS and never its visibility (`intersect()` in three.core),
    // so this is a mesh that is hit and never drawn — no second draw call, no
    // blend, nothing for the renderer to sort. `scene3d.js` leans on the same
    // reading one storey up, where it has to check `group.visible` by hand.
    const target = new three.Mesh(
      new three.CylinderGeometry(HANDLE_HIT_PX / 2, HANDLE_HIT_PX / 2,
                                 HANDLE_PX, SIDES),
      ink);
    target.visible = false;
    group.add(target);
  }

  /**
   * Where the plane meets the face the reader clicked, in world coordinates.
   *
   * WITHOUT THE RENDER SLIVER — see `sectionBias` in section.js, which is the
   * one function that adds it and says why every reader takes it back out. This
   * is a reading of where the plane stands, so it is in the same frame as
   * `state.cutOffset` and `captureSection`, not in the library's.
   *
   * READ OFF THE PLANE EVERY FRAME, NOT OUT OF `state.cutOffset`, and the
   * difference is the whole of whether this is a handle at all. The two agree
   * everywhere except during a drag of this very arrow: `state.cutOffset` is
   * written once, by `reportCut` at the RELEASE, so an anchor taken from it
   * would sit still while the plane slid out from under the hand and then jump
   * to catch up when the hand came off. `sectionOffset` measures the plane
   * itself, so the arrow stays under the cursor — which is the one thing direct
   * manipulation has to get right.
   */
  const anchor = () => {
    const seed = vp.sectionSeed;
    const offset = sectionOffset(vp);
    return [seed.point[0] + seed.normal[0] * offset,
            seed.point[1] + seed.normal[1] * offset,
            seed.point[2] + seed.normal[2] * offset];
  };

  /** Whether there is a cut to put a handle on at all.
   *
   * THE OTHER WAYS THE GRIP LEAVES THE SCREEN ARE NOT IN HERE, on purpose: a
   * camera that cannot be measured and a seed that cannot be read are answers
   * about THIS FRAME, and a scene caught mid-swap has both again one render
   * later. This question is the one `scene3d.js` asks before it reaches into the
   * library at all, so it is about the cut and nothing else.
   */
  function wanted() {
    return !!(vp.sectionSeed && vp.state.cut);
  }

  /**
   * Stand the arrow on the plane, or say there is nothing to stand.
   *
   * ALONG THE SEED'S NORMAL AND NOT THE PLANE'S. The two are the same direction
   * up to a SIGN — `placeSectionPlane` turns the seed towards the camera and a
   * flip turns the plane in force over without moving it — and the arrow is
   * symmetric about its own middle, so the sign is invisible on screen. What
   * that buys is a reading the module already takes for the anchor, instead of a
   * second call into the library that can fail on its own.
   *
   * WHAT `finite3` IS AND IS NOT CHECKING, because the difference matters here.
   * It catches NaN and Infinity, which is what a plane read mid-swap or a camera
   * that cannot be measured produce, and `set` on a NaN leaves a group at no
   * position at all. It does NOT catch a zero vector — `math.js` says so in as
   * many words — and nothing here needs it to: `setFromUnitVectors` is the one
   * call that would care, and the normal it is handed was made a unit vector at
   * the seed: `placeSectionPlane` and `restoreSection` are the two functions
   * that write `vp.sectionSeed`, and both run `unit3` before they do — which
   * section.js states, together with the requirement on any third writer.
   */
  function place(group) {
    const seed = vp.sectionSeed;
    if (!seed || !finite3(seed.normal)) return false;
    const at = anchor();
    if (!finite3(at)) return false;
    group.position.set(at[0], at[1], at[2]);
    aim.set(seed.normal[0], seed.normal[1], seed.normal[2]);
    group.quaternion.setFromUnitVectors(up, aim);
    return true;
  }

  /** The window listeners this gesture is followed with, which `drag.js` says
   *  why are on the window and in the capture phase. */
  const watch = watchDrag({ onMove, onUp, onCancel });

  /** Let go of the gesture, wherever it ended. */
  const finish = () => {
    drag = null;
    watch.disarm();
    // The cursor goes back to answering the ray. Unconditional, because every
    // ending there is comes through here.
    widget.grabbed(false);
  };

  function onMove(event) {
    if (!drag) return;
    const g = internals(vp.viewer);
    if (!g) return;
    // Since the PREVIOUS event, exactly as `onMove` in tools.js counts it: the
    // plane moves by what the hand did between two frames, not by where the
    // gesture started.
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;
    dragSection(vp, g, drag.axis, dx, dy);
  }

  function onUp() {
    const held = drag;
    finish();
    // ONLY IF IT ACTUALLY MOVED, which is the same rule the canvas drag applies
    // (`tools.js`, `if (p.moved)`) and it is not tidiness. `reportCut` emits
    // `hmr:face`, and the interface answers that by disarming whatever tool is
    // up (`tool: null`, HammerolaViewer.jsx) — so a bare click on the arrow
    // would silently put down the measure or comment tool the reader was
    // holding.
    //
    // Once, at the end: the drag moves the library's slider sixty times a second
    // and the interface would re-render with it. Through the same function the
    // canvas drag ends in, so `state.cutOffset` and the number the interface
    // prints keep their one writer.
    if (held && held.moved) reportCut(vp);
  }

  function onCancel() {
    finish();
  }

  /**
   * A press the ray found on the arrow. True when the grip has taken it, which
   * is what `scene3d.js` suppresses the event on.
   *
   * THE PRIMARY BUTTON AND NOTHING ELSE. The press is taken off the CANVAS now,
   * so what this refuses really does go on to everything behind it: a right-drag
   * the reader meant as a pan is a pan, a right-click is the part menu over the
   * face the arrow is standing on, and a middle click is whatever the trackball
   * makes of it. Answering `false` rather than swallowing the event is the whole
   * of that — see `onDown` in scene3d.js.
   */
  function onDown(event, g) {
    if (event.button !== 0) return false;
    // A previous gesture is concluded before a new one begins, as `onDown` in
    // tools.js does it: a second pointer landing on the same arrow would
    // otherwise overwrite the anchor with its own position, and the first
    // finger's next move would read as a jump the width of the gap between them.
    finish();
    // MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as tools.js does it:
    // the camera cannot move under a press this one owns, and re-measuring per
    // frame would let the plane drift away from the hand.
    //
    // THE SCREEN AXIS SURVIVES THE MOVE INTO THE SCENE, and it is the one thing
    // that had to: the drag is a PIXEL delta and the plane moves in world units,
    // so something has to say what a pixel is worth along the normal.
    // `sectionGripAxis` is that, degenerate-zone fallback and all — a reader
    // looking straight down the normal still drags the plane vertically, which
    // is the gesture that was there before this widget was an object.
    const axis = sectionGripAxis(vp.viewer, g, anchor());
    if (!axis) return false;
    drag = { axis, x: event.clientX, y: event.clientY, moved: false };
    watch.arm();
    // From here the canvas wears `grabbing` until `finish`, whatever the ray
    // says: the hand carries the pointer off a 18 px cylinder within a few
    // pixels of travel, and a cursor that went back to the default there would
    // be saying the drag had ended.
    widget.grabbed(true);
    return true;
  }

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture`, and it exists for the same failure that one was
   * written for: everything a live press holds — here the plane's screen axis —
   * was measured against a scene that is being replaced, and the release that
   * would have concluded the gesture never comes.
   *
   * IT CONCLUDES RATHER THAN ABANDONS. A swap can arrive mid-drag: the interface
   * waits for the hand to come off the model but gives up after a deadline, and
   * that wait does not see this press at all — the idle clock listens on
   * `vp.box`, and this press is taken in a window listener of the widget's own.
   * So without this, `restoreSection` would subtract a `state.cutOffset` from
   * before the drag out of a point the drag had already moved, and the seed
   * would come back off the face that was clicked, with the interface printing a
   * depth the plane has not been at since.
   */
  const endDrag = () => {
    const held = drag;
    finish();
    if (held && held.moved) reportCut(vp);
  };

  return {
    refresh: widget.refresh,
    // The two halves of the lifecycle, passed straight through to the one caller
    // that knows when a scene is replaced: `show()` in element.js.
    attach: widget.attach,
    detach: widget.detach,
    endDrag,
    destroy() {
      // A viewport unmounted mid-drag would otherwise leave three capture-phase
      // listeners on the window holding a scene that is gone.
      finish();
      widget.destroy();
    },
  };
}
