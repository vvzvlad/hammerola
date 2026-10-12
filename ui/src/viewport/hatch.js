// Hatching the cut face, as in a section drawing.
//
// The library draws the cut with the stencil trick: front and back stencil
// passes with `colorWrite: false`, then a `PlaneGeometry(2, 2)` cap quad where
// the stencil says the solid was opened. That cap is a flat fill. Like Fusion's
// `Show Hatch`, this file adds a diagonal hatch over the fill, which is drawn in
// the component's colour (`clipObjectColors`, options.js).
//
// The pattern lives in the plane of the cut, not on the screen: `uv` runs 0..1
// across a quad that `PlaneMesh.updateMatrixWorld` scales to `0.5 * size` and
// turns to face the clip normal, so uv is the section plane in world
// proportions, and direction and phase turn with the model.
//
//   * Every solid gets its own field and its own angle, so neighbouring bodies
//     differ in slope. The angle and phase are hashed from the solid's tree path
//     (`solid.name`), deterministically, so the hatch does not jump between
//     revisions. Two keys can hash onto one slope; the phase, taken from other
//     bits of the hash, separates most such pairs.
//   * One pitch for every cut face, anchored to the part: the period is a
//     distance in the plane of the cut, so within a level nothing moves with
//     the camera. The period steps through power-of-two LEVELS of that distance
//     so the on-screen spacing stays between PITCH_PX and twice it (CSS pixels);
//     zooming or tilting a face crosses levels, and since levels nest (see
//     `HATCH`) a crossing halves or doubles the lines and moves none of the
//     survivors. Line width is in framebuffer pixels (see PITCH_PX, LINE_PX).
//     The hatch is therefore not a scale: a 5 mm boss and a 500 mm plate hatch
//     identically, and spacing can differ between faces by up to 2x.
//
// `onBeforeCompile` rather than a material of our own: the cap material carries
// the stencil test, polygon offset, the other clip planes and its colour, and
// patching its shader keeps all of that instead of copying library code.
//
// This is string surgery on three.js shader chunks, so it is pinned to the THREE
// version in static/_v/three.module.js (r184), not to a three-cad-viewer release.
// A missing marker means the hatch silently disappears while the page still
// renders; the suite checks the markers are present.

const MARKER = "#include <opaque_fragment>";

/** The anchor the uniform declarations splice at: the first line of three.js's
 *  uniform block in `meshphysical_frag`, at global scope (the `MARKER` sits
 *  inside `main()`, where a declaration would not compile). It occurs once in
 *  that shader, and the suite checks it precedes `MARKER`. */
const UNIFORM_ANCHOR = "uniform vec3 diffuse;";

/** The two measurements, in two different pixel units. The lines are PITCH_PX
 *  CSS pixels apart (the target the level is picked against, so on-screen
 *  spacing is between that and twice it, see `HATCH`), and each line is LINE_PX
 *  FRAMEBUFFER pixels wide.
 *
 *  The canvas is drawn at the renderer's pixel ratio (viewport/element.js), so
 *  the units differ on a retina display:
 *    * spacing is legibility, perceived in CSS pixels, so the target is
 *      `PITCH_PX` times the renderer's pixel ratio (`hatchPitchPx`);
 *    * width is ink: 1.5 framebuffer pixels reads as a hairline, while 1.5 CSS
 *      pixels would be three device pixels on a 2x screen and read as a band. */
const PITCH_PX = 8.0;
const LINE_PX = 1.5;

/** The anti-aliasing band, also IN FRAMEBUFFER PIXELS and for the same reason as
 *  LINE_PX: a transition of about one pixel in total, half a pixel each side of
 *  a line's edge. See `HALF_AA_PX` for what the shader is handed. */
const AA_PX = 1.0;

/** The set every part's line direction is drawn from, in DEGREES, as the
 *  direction the lines run in the cap quad's uv plane. Six slopes covering the
 *  half turn, no two closer than 30 degrees so adjacent choices read as
 *  different hatches; 45 is the conventional section angle, and the mirrored
 *  slopes (>90) let two neighbours lean opposite ways. Exported for the suite,
 *  which checks the 30-degree gap. */
export const HATCH_SLOPES = [45, 15, 75, 105, 135, 165];

/** FNV-1a, 32 bits, over the part's tree path. Chosen for being adequate and
 *  nothing more — a stable digest of a short string. The raw low bits cluster
 *  on paths that share a prefix, so nothing buckets them directly: every
 *  consumer draws from `mix(hashKey(key))` instead. */
function hashKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The murmur3 finalizer — one round of avalanche so the buckets above spread.
 *  Measured, not assumed: on ten realistic tree paths, `hashKey(key) % 6`
 *  alone landed four of them on one slope; after this, five collisions in
 *  forty-five pairs, which is the birthday bound for six buckets. */
function mix(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Half a line and half its anti-aliasing band, IN FRAMEBUFFER PIXELS, as GLSL
 *  float literals. The shader converts them into fractions of the period using
 *  the period's own pixel size, because the period depends on the pixel ratio
 *  and the level the shader picks; a fraction computed here would let the line
 *  thicken with each level.
 *
 *  If the band grows to about the line width, no fully inked middle remains and
 *  the hatch washes out into an even grey, which looks like a colour choice
 *  rather than a bug. */
const HALF_LINE_PX = (LINE_PX / 2).toFixed(4);
const HALF_AA_PX = (AA_PX / 2).toFixed(4);

/** The hatch's five uniforms, declared at global scope just ahead of three.js's
 *  own (see UNIFORM_ANCHOR). Plain `float`s, because no THREE constructor is
 *  reachable from this module to build a Vector2 with.
 *
 *  `hatchPitch` is the target spacing in framebuffer pixels (see
 *  `hatchPitchPx`). It is a uniform rather than baked into `HATCH` because
 *  three.js keys its program cache off `onBeforeCompile.toString()`: a source
 *  that varied with the ratio would compile a second program or share one
 *  program between caps that need different ones. See `hatchShader`. */
const HATCH_UNIFORMS = `
uniform float hatchDirX;
uniform float hatchDirY;
uniform float hatchPhase;
uniform float hatchOn;
uniform float hatchPitch;
`;

/**
 * The hatch itself.
 *
 * `vUv` is the section plane (see the header). `hatchDirX`/`hatchDirY` is one
 * slope of HATCH_SLOPES turned 90 degrees, because the stripes are the level
 * sets of `dot(p, dir)`; `hatchPhase` is the per-part phase (see `capUniforms`).
 * `hatchPitch` is one number for the whole scene: the target spacing in
 * framebuffer pixels (see `hatchPitchPx`).
 *
 * The period is a distance in the section plane, so stripes stay over the same
 * material as the camera turns.
 *
 * Levels are powers of two in that plane. `hatchGrad` is the uv one
 * framebuffer pixel covers across the stripes, so `hatchPitch * hatchGrad` is
 * the target spacing in uv and `exp2(ceil(log2(...)))` the smallest power of
 * two at least that big: on-screen spacing lands between `hatchPitch` and
 * `2 * hatchPitch` pixels.
 *
 * Levels nest: line centres sit on the integers of `hatchS` and `hatchPhase` is
 * a fixed offset in the plane (not a fraction of the period), so lines stand at
 * `hatchUv = n * hatchStep - hatchPhase`. Doubling the step keeps every even
 * line in place, so a level change halves or doubles the line count and moves
 * nothing else. With power-of-two steps the division is exact, so the
 * surviving lines land on bit-identical positions. Levels change on zoom and on
 * tilt (tilting a face to 60 degrees doubles the gradient across the stripes),
 * which ordinary trackball use does constantly, so the nesting matters.
 *
 * Ink is counted in framebuffer pixels at every level: one period is
 * `hatchStep / hatchGrad` pixels, so HALF_LINE_PX and HALF_AA_PX are multiplied
 * by `hatchGrad / hatchStep` to become fractions of a period. Ink that changes
 * thickness at a level change means this cancellation is broken.
 *
 * `length`, not `fwidth`: `fwidth` is the L1 sum `abs(dFdx) + abs(dFdy)`,
 * up to 1.41x the true gradient depending on stripe orientation, which would
 * give each slope a different density and make faces near a boundary flip
 * levels as the model turns.
 *
 * The `max` guards against a zero gradient (a degenerate cap, or one magnified
 * below float precision): `log2(0)` would make `hatchStep` zero. An edge-on cap
 * has a huge gradient, gets a coarse level and renders as one flat tone.
 *
 * The viewport is orthographic (`ortho: true`, options.js), so the uv-to-pixel
 * map is one constant linear map per flat cap: the gradient is constant over a
 * face and a level boundary can fall inside a face only through float noise at
 * the threshold. The map is not isotropic, which is why the length is taken per
 * fragment. Under a perspective camera a level boundary would be a visible seam.
 *
 * Flat: this replaces `gl_FragColor` instead of tinting the lit result, so the
 * lighting does not shade the cut face. It is spliced in before
 * `tonemapping_fragment` and `colorspace_fragment`, so the colour is in the
 * working (linear) space like `diffuse`.
 *
 * Anti-aliasing is only the smoothstep band (AA_PX): the on-screen period never
 * falls below PITCH_PX pixels, so moire cannot occur.
 *
 * `hatchOn` gates the lines without a recompile. At 0 the cap is a flat fill
 * in the part's colour; the lit shading is gone either way, since the block
 * replaces `gl_FragColor` unconditionally.
 */
const HATCH = `
  {
    float hatchUv = dot(vUv - 0.5, vec2(hatchDirX, hatchDirY));
    // uv per framebuffer pixel, across the stripes
    float hatchGrad = max(length(vec2(dFdx(hatchUv), dFdy(hatchUv))), 1e-8);
    // the level, in uv: the smallest power of two at least the target spacing
    float hatchStep = exp2(ceil(log2(hatchPitch * hatchGrad)));
    // line centres on the INTEGERS and the phase a fixed offset in the plane, so
    // the levels nest: doubling the step leaves every second line where it was
    float hatchS = (hatchUv + hatchPhase) / hatchStep;
    float hatchF = abs(fract(hatchS + 0.5) - 0.5);
    // dividing a pixel count by the pixels in a period (hatchStep / hatchGrad)
    // gives a fraction of a period, which is what hatchF is measured in
    float hatchHalf = ${HALF_LINE_PX} * hatchGrad / hatchStep;
    float hatchAa = ${HALF_AA_PX} * hatchGrad / hatchStep;
    float hatchCov = (1.0 - smoothstep(hatchHalf - hatchAa,
                                       hatchHalf + hatchAa,
                                       hatchF)) * hatchOn;
    // The ink is the part's own colour taken further, so the hatch says the
    // same thing about the material as the fill does. A part whose colour is
    // already near black is lightened instead, because there is nothing below
    // it to darken into.
    float hatchLum = dot(diffuse, vec3(0.2126, 0.7152, 0.0722));
    vec3 hatchInk = mix(diffuse + vec3(0.16), diffuse * 0.42, step(0.1, hatchLum));
    gl_FragColor = vec4(mix(diffuse, hatchInk, hatchCov), diffuseColor.a);
  }
`;

/**
 * The target spacing the level is picked against (see `HATCH`), in FRAMEBUFFER
 * pixels: PITCH_PX CSS pixels times `ratio`, the renderer's pixel ratio (the
 * pixels the shader's derivatives count). Not `window.devicePixelRatio`, which
 * differs when "Retina resolution" is off (viewport/element.js).
 *
 * A missing or zero ratio counts as 1; there is no ceiling, which would shrink
 * the spacing on a 3x display. The viewport re-runs `setCutHatch` whenever it
 * changes the ratio.
 */
function hatchPitchPx(ratio) {
  return PITCH_PX * (ratio > 0 ? ratio : 1);
}

/**
 * The patch, as one module-level function shared by every cap material.
 *
 * three.js's default `customProgramCacheKey` returns
 * `onBeforeCompile.toString()`, so one function object means one compiled
 * program for all caps, while a patched material still differs from an
 * unpatched one.
 *
 * Per-part numbers therefore travel as uniforms, never in a closure, which
 * `toString()` cannot see (every cap would silently get the first compiled
 * program). They are read off `this.userData.hatch` — three.js calls
 * `material.onBeforeCompile(parameters, renderer)`, so `this` is the material —
 * giving one uniform set per material with a shared program. The `shader`
 * object is kept on `material.userData.hatchShader` so `setCutHatch` can change
 * values in place without a recompile.
 *
 * The pitch follows the pixel ratio of `renderer`, the second argument, and is
 * set here as well as in `setCutHatch` so a scene that is never toggled is
 * right too.
 *
 * The five identifiers only exist because `HATCH_UNIFORMS` is spliced ahead of
 * three.js's uniform block; without it the shader fails to compile.
 */
export function hatchShader(shader, renderer) {
  const p = this && this.userData && this.userData.hatch;
  if (p) {
    shader.uniforms.hatchDirX = { value: p.dirX };
    shader.uniforms.hatchDirY = { value: p.dirY };
    shader.uniforms.hatchPhase = { value: p.phase };
    shader.uniforms.hatchOn = { value: p.on };
    shader.uniforms.hatchPitch = {
      value: hatchPitchPx(renderer && renderer.getPixelRatio()),
    };
    this.userData.hatchShader = shader;
  }
  shader.fragmentShader = shader.fragmentShader
    .replace(UNIFORM_ANCHOR, UNIFORM_ANCHOR + HATCH_UNIFORMS)
    .replace(MARKER, MARKER + HATCH);
}

/**
 * Patch one cap material with one part's numbers, or leave it as it was.
 *
 * `USE_UV` makes `vUv` exist: since r152 three declares the uv varying only for
 * materials that ask for it, and a cap material has no map.
 *
 * Materials are never shared between caps: the library builds one per
 * (plane, solid) and uses `material.id` for render order, which keeps a solid's
 * stencil pass adjacent to its cap. Sharing would break the stencil isolation.
 *
 * The numbers live on `material.userData.hatch`, which `hatchShader` compiles
 * from; the patch function stays closure-free for the cache key's sake.
 */
function patchCapMaterial(material, params) {
  if (!material) return false;
  if (material.onBeforeCompile === hatchShader) {
    // Same function, same cache key, same program, and no `needsUpdate`, so a
    // re-render does not recompile. The numbers reach only the next compile,
    // not the live uniforms; `setCutHatch` writes both. `safeHatch` runs once
    // per `show()` on fresh caps, so no path reaches here with new numbers.
    material.userData.hatch = params;
    return true;
  }
  if (typeof material.onBeforeCompile !== "function") return false;
  material.defines = { ...(material.defines || {}), USE_UV: "" };
  material.userData = { ...(material.userData || {}), hatch: params };
  material.onBeforeCompile = hatchShader;
  material.needsUpdate = true;
  return true;
}

/**
 * The hatch parameters for every cap of the part named `key`: angle and phase.
 *
 * Both come from the key alone through one mixed hash, so they are stable
 * across revisions and independent of where the part sits. Nothing here reads
 * the cap, the clipping region or the part's bounding box: a number derived
 * from those would make the pitch follow the part.
 *
 * The slope is one of HATCH_SLOPES; the phase comes from a second mix, so two
 * keys on one slope usually still hatch out of step. The phase is in [0,1) and
 * the shader reads it as an offset in the plane, not a fraction of the period —
 * the level nesting depends on that (see `HATCH`).
 */
function capUniforms(key) {
  const h = mix(hashKey(key));
  const slope = HATCH_SLOPES[h % HATCH_SLOPES.length];
  // The stripes run perpendicular to the dot direction, hence the +90.
  const rad = (slope + 90) * Math.PI / 180;
  return {
    dirX: Math.cos(rad),
    dirY: Math.sin(rad),
    phase: (mix(h ^ 0x9e3779b9) % 1000) / 1000,
  };
}

/**
 * Hatch every cut face in the scene, one field per part. Safe to call again.
 *
 * Called after `render()`, when the cap meshes exist: the library builds them
 * in `Clipping._createStencils`, one per (plane, solid), grouped per solid into
 * `_capUnits`. The library's other rebuild path, `rebuildStencils` (from
 * `addPart`/`updatePart` and `ensureStencilSize`), is not used here, since
 * changing the scene is `clear()` plus `render()`; if it ever is, the hatch has
 * to be re-applied there too.
 *
 * `_capUnits` is a private field, so this reads it defensively and gives up
 * quietly. `on` is the checkbox's current state: a scene rendered with the box
 * unticked is patched but hatches nothing, so the later toggle is a uniform
 * write.
 */
export function hatchSectionCaps(g, on = true) {
  const units = g && g.clipping && g.clipping._capUnits;
  if (!Array.isArray(units) || units.length === 0) {
    // Not an error on its own: `hatchSectionCaps` is called on every render and
    // a scene the library built no units for is a scene with no solids in it.
    return 0;
  }
  const flag = on ? 1 : 0;
  let done = 0;
  let total = 0;
  for (const unit of units) {
    const caps = unit && unit.capMeshes;
    const solid = unit && unit.solid;
    const key = solid && typeof solid.name === "string" && solid.name;
    // ONE FIELD PER PART: the hash runs once per unit, so every cap of the
    // solid — one per clip plane — is a window onto the same hatch. Each still
    // gets its own object below, because `patchCapMaterial` keeps it on the
    // material and `setCutHatch` writes the toggle into it.
    const params = key ? capUniforms(key) : null;
    const count = Array.isArray(caps) ? caps.length : 0;
    for (let k = 0; k < count; k++) {
      total += 1;
      if (params && patchCapMaterial(caps[k] && caps[k].material,
                                     { ...params, on: flag })) {
        done += 1;
      }
    }
  }
  // ONCE PER CALL AND NOT ONCE PER CAP — twelve identical lines from one moved
  // field is noise — and no once-per-page latch, which would be module state the
  // suite then has to prove it resets between tests. A render is the unit here.
  if (done < total) {
    console.warn("section hatch: the library's cap units are not where this "
                 + "expects them; the cut will be drawn as a plain fill");
  }
  return done;
}

/**
 * Flip the hatch without touching a shader: every patched cap's `hatchOn`
 * uniform is rewritten in place, with the program, cache key and geometry
 * untouched.
 *
 * Writes both `userData.hatch` (so a later recompile keeps the state) and the
 * live uniform from `userData.hatchShader`. Unpatched materials are skipped
 * quietly; this runs on every state event.
 *
 * The pitch is updated on the same walk, since this is the one path that
 * reaches every live shader; the viewport calls it after changing the pixel
 * ratio. The renderer is reached through the display (`Display.setupUI`).
 */
export function setCutHatch(g, on) {
  const units = g && g.clipping && g.clipping._capUnits;
  if (!Array.isArray(units)) return 0;
  const flag = on ? 1 : 0;
  const viewer = g.display && g.display.viewer;
  const renderer = viewer && viewer.renderer;
  const pitch = hatchPitchPx(renderer && renderer.getPixelRatio());
  let flipped = 0;
  for (const unit of units) {
    const caps = unit && unit.capMeshes;
    if (!Array.isArray(caps)) continue;
    for (const cap of caps) {
      const m = cap && cap.material;
      const ud = m && m.userData;
      if (!m || m.onBeforeCompile !== hatchShader || !ud || !ud.hatch) continue;
      ud.hatch.on = flag;
      const uniforms = ud.hatchShader && ud.hatchShader.uniforms;
      const live = uniforms && uniforms.hatchOn;
      if (live) {
        live.value = flag;
        if (uniforms.hatchPitch) uniforms.hatchPitch.value = pitch;
        flipped += 1;
      }
    }
  }
  return flipped;
}

/**
 * `hatchSectionCaps` wrapped so it cannot throw — the one the viewport calls.
 *
 * Reaching into the library's private shape can throw (a getter, a proxy, a
 * revoked reference). The call site is inside `show()`, whose catch draws the
 * error panel instead of the model and sets `loadFailed`, so an escaped error
 * would take the viewer down. The guard lives here rather than at the call site
 * so a test can make the patching throw and check it.
 */
export function safeHatch(g, on) {
  try {
    return hatchSectionCaps(g, on);
  } catch (error) {
    console.warn("section hatch", error);
    return 0;
  }
}

/** The chunk this splices at, so the suite can ask whether three.js still has
 *  it. Nothing at runtime can: by the time a shader is compiled the hatch has
 *  already silently not happened, and the page renders perfectly without it. */
export const hatchMarker = MARKER;

/** The three measurements, exported for the suite — the pitch in CSS pixels, the
 *  line and its band in framebuffer ones (see PITCH_PX for why the units
 *  differ). The pitch tests read the numbers back out of the uniform the patch
 *  writes and the GLSL it splices, which is where all three are applied. */
export const HATCH_PITCH_PX = PITCH_PX;
export const HATCH_LINE_PX = LINE_PX;
export const HATCH_AA_PX = AA_PX;
