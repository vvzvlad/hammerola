// Hatching the cut face, the way a section drawing has always been read.
//
// The library draws the cut with the classic stencil trick: a front and a back
// stencil pass with `colorWrite: false`, then a `PlaneGeometry(2, 2)` cap quad
// where the stencil says the solid was opened. That quad is a
// `MeshStandardMaterial` and it is drawn as a flat fill, so a section here came
// out as a coloured silhouette — the shape of the cut and nothing about it.
// Fusion draws two layers instead: the fill in the component's colour
// (`clipObjectColors`, options.js) and a diagonal hatch over it, `Show Hatch`,
// on by default and with no settings of its own. This file is the second layer.
//
// IN THE PLANE OF THE CUT, NOT ON THE SCREEN — the pattern AND the period it
// repeats at. The one thing measured on the screen is the TARGET spacing, and
// all it does is pick which discrete LEVEL the period sits at; the nuance is the
// second bullet below. A screen-space hatch reads as a film laid over the
// picture: it stands still while the model turns under it. The cap quad already
// carries the frame this needs — `uv` runs 0..1 across a quad that
// `PlaneMesh.updateMatrixWorld` scales to `0.5 * size` and turns to face the
// clip normal, so uv IS the section plane, in world proportions. Direction and
// phase are read out of that plane and turn with the model, exactly as they
// always did.
//
// PER PART, AND NOT ONE FIELD ACROSS THE CUT (issue #13). The first version
// hatched every cap out of the quad's own frame, which made one clip plane's
// stripes run through wall, board and lid unbroken — the cut read as one body,
// which is the one reading a section exists to correct. What stayed per part
// after that, and what pointedly did not, are the two decisions below — both
// the owner's, and neither re-opens from here:
//
//   * every SOLID gets its own field AND its own angle, so neighbouring bodies
//     differ in slope — the drawing convention — even where their phases
//     happen to coincide. The angle is hashed from the solid's tree path
//     (`solid.name`) and is DETERMINISTIC on purpose: an angle taken from
//     position or a random source would jump between revisions and break
//     comparing two revisions by eye. The price of that stability is that two
//     particular keys can hash onto one slope; the set below is what keeps the
//     rest of the convention, and the phase, taken from different bits of the
//     same hash, is what separates the rare pair that collides;
//   * ONE PITCH FOR EVERY CUT FACE IN THE SCENE, and it is ANCHORED TO THE
//     PART. The period is a distance in the PLANE OF THE CUT, so WITHIN a level
//     nothing on the face moves whatever the camera does; the period keeps up
//     with the apparent scale in discrete LEVELS — powers of two of that
//     in-plane distance — and steps to the next one when the lines are about to
//     merge. PITCH_PX is what "about to merge" means: the TARGET on-screen
//     spacing, in CSS PIXELS, that the level is picked against. A level change
//     is reached by ZOOMING or by TILTING a face far enough to change its own
//     foreshortening — both routes are ordinary trackball use, not a corner — and
//     because the levels NEST (see `HATCH`) crossing one halves or doubles the
//     line count and moves nothing that survives it. The lines themselves stay
//     measured in FRAMEBUFFER pixels, a different unit on a retina display and
//     deliberately so (see PITCH_PX and LINE_PX, and issue #96 for the grain
//     that came of using one unit for both), and very thin: Fusion's hatch,
//     which is what the owner asked for.
//     This replaces a period held at a constant number of SCREEN pixels, which
//     was the pattern painted on the glass rather than on the part: turning the
//     model changes the foreshortening, so the same point of the part landed in
//     a different stripe and the whole field crept across the cut face. Further
//     back it replaces a pitch that followed each part's own bounding box: that
//     gave a big part wide bands and a small one fine lines, and the two side by
//     side read as two different drawings.
//     Two costs are accepted for that. The hatch is not a scale — a 5 mm boss
//     and a 500 mm plate hatch identically, and a part small on screen gets
//     fewer lines across it rather than the same number. And the hatch is no
//     longer the same density everywhere on the screen: each face sits at
//     whatever level its own foreshortening picks, so across the scene the
//     spacing steps between one and two times the target. WITHIN one face it is
//     uniform — this camera is orthographic, so the gradient is one constant
//     over a face (see `HATCH`) and a level boundary can fall inside a face only
//     through float noise at the exact threshold.
//
// WHY `onBeforeCompile` AND NOT A MATERIAL OF OUR OWN. The cap material carries
// the stencil test that makes the cap appear only where the solid was opened,
// the polygon offset that keeps it off the face, the other two clip planes and
// its own colour. Rebuilding all of that outside the library would be copying
// its geometry code and would go stale silently; patching the shader of the
// material it already built leaves every one of those properties alone.
//
// THE ONE FRAGILITY, named so nobody has to rediscover it: this is string
// surgery on three.js's own shader chunks, so it is pinned to the THREE version
// inside the vendored bundle (r184 today) rather than to a release of
// three-cad-viewer. `patchCapMaterial` therefore checks that the marker it
// splices at is still there and says so once if it is not — a hatch that
// quietly stopped happening is the failure worth catching, because the page
// still renders perfectly.

const MARKER = "#include <opaque_fragment>";

/** The anchor the uniform declarations splice at: the first line of three.js's
 *  own uniform block in `meshphysical_frag`, which is at GLOBAL scope — the
 *  hatch's own declarations must be, since the marker below sits inside
 *  `main()`, where a declaration would not compile. First occurrence is the
 *  only one in that shader, and the suite proves it sits ahead of `MARKER` in
 *  the vendored bundle. */
const UNIFORM_ANCHOR = "uniform vec3 diffuse;";

/** The two measurements of the hatch, IN TWO DIFFERENT PIXELS, and the split is
 *  the whole of issue #96: the lines sit PITCH_PX CSS pixels apart — the TARGET
 *  the level ladder is picked against, so the spacing on screen is between that
 *  and twice it, see `HATCH` — and each is LINE_PX FRAMEBUFFER pixels across, on
 *  every cut face in the scene and at every zoom. The shader is where they are
 *  applied — see `HATCH`.
 *
 *  WHY NOT ONE UNIT FOR BOTH, which is what this was and what made the hatch
 *  read as scanner noise rather than as lines. The library renders at
 *  `renderer.setPixelRatio(window.devicePixelRatio)`, so a period of 8
 *  FRAMEBUFFER pixels is four CSS pixels on a 2x display, with a line three
 *  quarters of a CSS pixel wide inside it — that is grain, and on a close-up it
 *  fills the screen with it. The two numbers answer different questions:
 *
 *    * the DISTANCE BETWEEN LINES is legibility, and what the reader perceives
 *      is CSS pixels, so the target is `PITCH_PX * devicePixelRatio`
 *      framebuffer pixels (`hatchPitchPx`) and the spacing comes out between 8
 *      and 16 CSS pixels on every display;
 *    * the WIDTH is ink, and stays framebuffer: a pixel and a half OF THE
 *      FRAMEBUFFER is what reads as a drawn hairline, while the same 1.5 taken
 *      as CSS pixels would be three device pixels on a retina screen and read
 *      as a band — which is the band this fix must not re-create while widening
 *      the spacing. */
const PITCH_PX = 8.0;
const LINE_PX = 1.5;

/** The anti-aliasing band, also IN FRAMEBUFFER PIXELS and for the same reason as
 *  LINE_PX: a transition of about one pixel in total, half a pixel each side of
 *  a line's edge. See `HALF_AA_PX` for what the shader is handed. */
const AA_PX = 1.0;

/** The set every part's line direction is drawn from, in DEGREES, as the
 *  direction the lines RUN in the cap quad's uv plane. Six slopes covering the
 *  half turn, no two closer than 30 degrees — a drawing-office gap: adjacent
 *  choices have to read as different hatches at a glance, and fifteen degrees
 *  apart does not. 45 degrees is the conventional section angle and stays in
 *  the set; the mirrored slopes (>90) are deliberately there too, because a
 *  hash has to be able to put two neighbours on opposite leans. Order matters
 *  only in deciding which key gets which slope; it carries no meaning beyond
 *  that. Exported for the suite, which holds the set to the gap this paragraph
 *  claims. */
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

/** Half a line and half its anti-aliasing band, IN FRAMEBUFFER PIXELS, spelled
 *  as GLSL float literals: the shader counts in PERIOD units and converts each
 *  of these through the period's own pixel size to get there.
 *
 *  THE CONVERSION IS THE SHADER'S, and that is the point rather than a detail.
 *  These were `LINE_PX / 2 / PITCH_PX` and `0.5 / PITCH_PX`, computed here as
 *  fractions of the period, which was fine while the period was a constant. It
 *  is neither constant nor knowable here any more: it follows the display's
 *  density (see PITCH_PX) and then the LEVEL the shader picks for the face (see
 *  `HATCH`), so a fraction taken against the old constant would leave the line
 *  and the band at a fixed share of a period that MOVES — widening the line from
 *  1.5 framebuffer pixels to 3 on a 2x display, and doubling it again at every
 *  level change, which is exactly the band the split exists to avoid. Handing
 *  the shader pixel counts and letting it divide by the period's own pixel size
 *  keeps all three in step by construction, at whatever ratio and whatever
 *  level.
 *
 *  RETUNED FOR A THIN LINE, not carried over. The band this replaced was
 *  `fwidth(hatchS)` on each side — two pixels across a line that is now 1.5
 *  wide, which leaves no fully inked middle at all and washes the whole hatch
 *  into an even grey. That is the failure to watch for if these numbers move:
 *  it looks like a colour choice rather than a bug. */
const HALF_LINE_PX = (LINE_PX / 2).toFixed(4);
const HALF_AA_PX = (AA_PX / 2).toFixed(4);

/** The hatch's five uniforms, declared at global scope just ahead of three.js's
 *  own — see UNIFORM_ANCHOR. Plain `float`s and nothing structured, because no
 *  THREE constructor is reachable from this module to build a Vector2 with.
 *
 *  `hatchPitch` is the one that is neither per part nor constant: it is the
 *  TARGET spacing in framebuffer pixels — what the level is picked against, see
 *  `HATCH` — which depends on the display the canvas is on (see
 *  `hatchPitchPx`). A UNIFORM and not a number baked into `HATCH`, because
 *  `HATCH` has to stay one module-level string — three.js keys its program cache
 *  off `onBeforeCompile.toString()`, and a source that varied with the display
 *  would mean a second compiled program, or worse, one program silently shared
 *  by caps that wanted different ones. See `hatchShader`. */
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
 * `vUv` is the section plane (see the header). The line direction comes in as
 * the `hatchDirX`/`hatchDirY` pair — one slope out of HATCH_SLOPES, turned 90
 * degrees because the stripes are the LEVEL SETS of `dot(p, dir)` and so run
 * perpendicular to it — and the phase in as `hatchPhase`. Those two are per
 * part and are the only per-part numbers there are; see `capUniforms` for where
 * they come from. The pitch is not among them: `hatchPitch` is one number for
 * the whole scene, PITCH_PX CSS pixels expressed in framebuffer ones — see
 * `hatchPitchPx`, which is where the display's density enters — and it is the
 * TARGET spacing that picks the level rather than the period itself.
 *
 * THE PERIOD IS A DISTANCE IN THE PLANE OF THE CUT, which is the whole of the
 * fix. `hatchUv` is measured in the cap quad's uv, and that uv IS the section
 * plane in world proportions (see the header), so a period counted in those
 * units is painted ON THE PART: the camera can turn and every stripe stays over
 * the same material. Holding it at a constant number of SCREEN pixels instead —
 * `hatchUv` divided by its own screen gradient, which is what this used to do —
 * made the whole field creep across the face as the foreshortening changed, the
 * pattern behaving like a film on the glass rather than ink on the cut.
 *
 * THE LEVELS ARE POWERS OF TWO, in that same in-plane frame, and that is how the
 * spacing keeps up with the apparent scale. `hatchGrad` is how much uv one framebuffer
 * pixel covers ACROSS THE STRIPES, so `hatchPitch * hatchGrad` is the target
 * spacing expressed in uv, and `exp2(ceil(log2(...)))` is the smallest power of
 * two at least that big. `ceil` is what makes the guarantee one-sided: the
 * level's spacing on screen lands between `hatchPitch` and `2 * hatchPitch`
 * pixels, so the lines are never about to merge and never open up further than
 * twice the target.
 *
 * POWERS OF TWO AND NOT SOME OTHER LADDER, for two reasons that both have to
 * hold. The first is that the levels NEST, and that is a property of the two
 * lines below rather than of `exp2` alone: `hatchS` puts the line centres on the
 * INTEGERS of the step and `hatchPhase` is a fixed offset in the PLANE, not a
 * fraction of the period, so the lines stand at `hatchUv = n * hatchStep -
 * hatchPhase`. Double the step and every EVEN line of the fine grid is a line of
 * the coarse one, at the same place on the part: a level change HALVES or
 * DOUBLES the line count and moves nothing that survives it. Write the phase as
 * a fraction of the period instead — which is what this did for one review round
 * — and every crossing slides the whole field by up to half a period, which is
 * the jumping this change exists to remove. The second reason is arithmetic:
 * both steps are exact powers of two, so `(hatchUv + hatchPhase) / hatchStep`
 * divides without rounding and doubling the step halves `hatchS` BIT FOR BIT —
 * the even lines land on exactly the float they were on, so the nesting above
 * is exact rather than within an ulp, and a level is not a new source of drift.
 *
 * WHAT MOVES, AND WHEN. Within a level nothing on the part moves, whatever the
 * camera does. A level change is a discrete step, and it is reached by ZOOMING
 * or by TILTING a face: the level comes out of `hatchGrad`, which is the face's
 * own foreshortening. Tilting a face to 60 degrees multiplies the gradient
 * across the stripes by up to two — a level on its own in the worst case, and
 * by nothing at all for a part whose slope happens to run along the tilt axis,
 * which the trackball sweeps anyway. Ordinary
 * trackball use therefore crosses boundaries all the time, which is precisely
 * why the nesting above is not optional — with it, a crossing costs half the
 * lines or twice them and nothing slides.
 *
 * THE INK IS STILL COUNTED IN FRAMEBUFFER PIXELS, at every level, and that is
 * what `hatchGrad / hatchStep` is doing in the two lines below. `hatchS` counts
 * periods of `hatchStep` uv, and one such period is `hatchStep / hatchGrad`
 * pixels wide, so a pixel count becomes a fraction of a period by dividing by
 * that — HALF_LINE_PX and HALF_AA_PX go through exactly that conversion. The
 * two factors cancel, so the hairline stays 1.5 framebuffer pixels across and
 * the band about one whether the level is fine or coarse. Ink that thickened or
 * thinned at a level change is the tell that this cancellation got broken.
 *
 * `length` AND NOT `fwidth`, which is the trap this spent a review on: `fwidth`
 * is `abs(dFdx) + abs(dFdy)`, the L1 sum and not the length, so it runs from
 * the true gradient up to 1.41 times it depending on how the stripes happen to
 * lie on the screen. As the width of an anti-aliasing band that overshoot is
 * harmless, which is what it used to be here; in `hatchGrad` it feeds both the
 * number the level is chosen against and the pixel conversion above — every
 * slope in HATCH_SLOPES a different density, and a face sitting near a level
 * boundary flipping levels as the model turns, which is the creep this fixes
 * wearing another hat. One ladder for every angle means the Euclidean length.
 *
 * The `max` is a floor against a ZERO gradient, which is uv that does not
 * change from one pixel to the next — a degenerate cap, or one magnified until
 * the difference falls under float precision. It is not a tolerance, and it
 * carries more than it used to: `log2(0)` is minus infinity, so without the
 * floor `hatchStep` would come out zero and every line below would divide by
 * it. A cap turned edge-on is the opposite case and needs no floor: its
 * gradient is huge, the ladder simply picks a coarse level, and the sliver on
 * screen comes out as one flat tone.
 *
 * EXACT RATHER THAN APPROXIMATE, and it is the camera that makes it so: this
 * viewport is ORTHOGRAPHIC by construction (`ortho: true`, options.js), so the
 * map from a flat cap's uv to pixels is ONE CONSTANT LINEAR MAP over the whole
 * face — foreshortened along one axis where the cap is tilted, but the same map
 * at every fragment, which is what makes the gradient the SAME NUMBER over the
 * whole face. Constant, not isotropic: that foreshortening is why the length is
 * taken per fragment here and could not be computed once on the CPU. The lines
 * therefore come out straight and evenly spaced, and `hatchStep` is one level
 * for the whole face — a level boundary can fall inside a face only through
 * float noise, where the gradient sits on the threshold and rounds two ways.
 * Under a perspective camera the ratio would drift across the face: this would
 * be a near-enough approximation, and a level boundary would be a visible seam
 * crossing the cut.
 *
 * FLAT, and deliberately: this REPLACES `gl_FragColor` rather than tinting the
 * lit result. A `MeshStandardMaterial` would shade the lines along with the
 * fill, and a cut face that is darker at one end because of where a lamp
 * happens to be is a cut face nobody can read a hatch off. It is spliced in
 * before `tonemapping_fragment` and `colorspace_fragment`, so the colour
 * written here is in the working (linear) space exactly like `diffuse` and goes
 * out through the same conversions as the rest of the scene.
 *
 * THE ANTI-ALIASING IS THE SMOOTHSTEP'S BAND AND NOTHING ELSE — AA_PX, about a
 * pixel in total. There is no moire crossfade any more: an on-screen period the
 * ladder never lets fall below PITCH_PX pixels cannot shrink towards a pixel
 * however small the part is on screen, so the case that code existed for stopped
 * being reachable.
 *
 * `hatchOn` gates the whole thing and is the reason the checkbox costs no
 * recompile: at 0 the coverage multiplies out and the cap is a flat fill in the
 * part's own colour, with the compiled program, the cache key and the geometry
 * all untouched. FLAT, not the face the library would draw on its own: the
 * block below replaces `gl_FragColor` UNCONDITIONALLY, so an unticked box
 * removes the lines and not the flatness — the lit `MeshStandardMaterial`
 * shading is gone from the cut face either way, and deliberately, for the
 * reason the paragraph above gives.
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
 * pixels — PITCH_PX CSS pixels converted through the density of whatever display
 * the canvas is on.
 *
 * The conversion is needed because the library renders at
 * `renderer.setPixelRatio(window.devicePixelRatio)` (its `Viewer` constructor),
 * so the pixels the shader's derivatives count are framebuffer ones while the
 * spacing the reader judges is in CSS ones. See PITCH_PX for why the width does
 * NOT go through here.
 *
 * DEFENSIVE ONLY ABOUT THE NUMBER: a missing or zero ratio is 1, and nothing
 * else is read or clamped — this must track what `setPixelRatio` was actually
 * given, so a ceiling here would silently halve the spacing on a 3x display.
 *
 * SAMPLED WHEN A UNIFORM IS WRITTEN, AND NOT TRACKED. A window dragged between
 * displays of different densities keeps the old target until the next render or
 * the next flip of the checkbox, both of which rewrite the uniform. That is
 * accepted deliberately: a `matchMedia` listener, a resize hook or any other
 * live-tracking machinery would be permanent apparatus for a case that corrects
 * itself the moment the reader does anything at all.
 */
function hatchPitchPx() {
  const ratio = window.devicePixelRatio;
  return PITCH_PX * (ratio > 0 ? ratio : 1);
}

/**
 * The patch, as ONE module-level function shared by every cap material.
 *
 * That sharing is load-bearing rather than tidiness. three.js's default
 * `customProgramCacheKey` returns `onBeforeCompile.toString()`, so one function
 * object means one cache key means ONE compiled program for all of the caps —
 * and a patched material still differs from an unpatched one, which is what the
 * default is there for. It also means no `customProgramCacheKey` of our own is
 * needed.
 *
 * WHICH IS WHY THE PER-PART NUMBERS TRAVEL AS UNIFORMS AND NEVER AS A CLOSURE.
 * A `toString()` cannot see a closure, so baking `capUniforms`' numbers in here
 * would put every cap on whichever program was compiled first — silently. They
 * are read off `this.userData.hatch` instead: three.js calls
 * `material.onBeforeCompile(parameters, renderer)`, so `this` IS the material,
 * and the numbers land in `shader.uniforms` as plain `{ value }` floats — one
 * uniform set per MATERIAL while the compiled program stays shared. The
 * `shader` object is kept on `material.userData.hatchShader` so `setCutHatch`
 * can flip a value in place later, without a recompile.
 *
 * THE PITCH IS SET HERE TOO, and it is the one uniform that comes from neither
 * the material nor a constant: `hatchPitchPx()` reads the display's density at
 * compile time. Set at PATCH time and not only from `setCutHatch`, so a scene
 * that renders once and is never toggled is already right.
 *
 * DECLARED, NOT JUST READ: the five identifiers exist for the GLSL compiler
 * only because `HATCH_UNIFORMS` is spliced in ahead of three.js's own uniform
 * block. Losing that splice is a shader that fails to compile — loud in the
 * console, and the suite holds the anchor to the vendored bundle for it.
 */
export function hatchShader(shader) {
  const p = this && this.userData && this.userData.hatch;
  if (p) {
    shader.uniforms.hatchDirX = { value: p.dirX };
    shader.uniforms.hatchDirY = { value: p.dirY };
    shader.uniforms.hatchPhase = { value: p.phase };
    shader.uniforms.hatchOn = { value: p.on };
    shader.uniforms.hatchPitch = { value: hatchPitchPx() };
    this.userData.hatchShader = shader;
  }
  shader.fragmentShader = shader.fragmentShader
    .replace(UNIFORM_ANCHOR, UNIFORM_ANCHOR + HATCH_UNIFORMS)
    .replace(MARKER, MARKER + HATCH);
}

/**
 * Patch one cap material with one part's numbers, or leave it exactly as it
 * was.
 *
 * `USE_UV` is what makes `vUv` exist at all: since r152 three declares the
 * generic uv varying only for materials that asked for it, and a cap material
 * has no map of any kind to ask on its behalf.
 *
 * MATERIALS ARE NEVER SHARED BETWEEN CAPS, and this must not start sharing
 * them: the library builds one per (plane, solid) and leans on `material.id`
 * for render order, which is what keeps a solid's stencil pass and its own cap
 * adjacent. Collapsing them into one would reorder the draws and break the
 * stencil isolation the caps depend on.
 *
 * The numbers themselves live on `material.userData.hatch` — the source of
 * truth `hatchShader` compiles from — and never in the patching function, which
 * has to stay closure-free for the cache key's sake (see `hatchShader`).
 */
function patchCapMaterial(material, params) {
  if (!material) return false;
  if (material.onBeforeCompile === hatchShader) {
    // Same function object, same cache key, same program, and NO `needsUpdate`
    // — that is what keeps a re-render from recompiling. What this leaves
    // behind is worth being exact about: the numbers land where the NEXT
    // compile reads them, and not in the uniforms a compiled shader is already
    // drawing from, so a cap patched twice with different numbers goes on
    // showing the first set. `setCutHatch` is the one that writes both,
    // because the checkbox has to move a live cap. No product path reaches
    // this branch with different numbers — `safeHatch` runs once per `show()`,
    // on caps the library has just built — so the branch stays as it is
    // rather than growing a second uniform writer for a case nobody has.
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
 * The hatch parameters for every cap of the part named `key`.
 *
 * ANGLE AND PHASE, AND NOTHING ELSE — which is all that is left of the per-part
 * arithmetic now that the pitch is one number for the whole scene, turned into a
 * level by the shader (see `HATCH`). Nothing here reads the cap, the clipping
 * region's size or the part's bounding box, and nothing should start to: a
 * number derived from any of those is a pitch that follows the part again,
 * which is the decision the header records the owner reversing.
 *
 * Both come from the part's key alone, through one mixed hash, so they are
 * stable across revisions and independent of where the part sits. The slope is
 * one of HATCH_SLOPES, all pairwise far enough apart to read as different; the
 * phase takes the bits a second mix produces, so two keys that do land on one
 * slope still hatch out of step — by their phase difference taken modulo the
 * current step, so the separation is a property of the level rather than a
 * fixed fraction of the period — and two that coincide in BOTH are the rare
 * pair the header accepts. A number in [0,1), which the shader reads as an
 * offset IN THE PLANE rather than as a fraction of the period: see `HATCH`, and
 * do not turn it back into a fraction — that is what the levels nest on.
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
 * Hatch every cut face in the scene, one field per part. Safe to call again;
 * does nothing twice.
 *
 * CALLED AFTER `render()` AND NOWHERE ELSE, because that is when the cap meshes
 * exist: the library builds them in `Clipping._createStencils`, one per (plane,
 * solid), grouped per solid into `_capUnits` — the field this reads, because
 * the parameters are hashed from the SOLID and applied to its caps. There is a
 * second path that rebuilds them — `rebuildStencils`, from
 * `addPart`/`updatePart` growing the bounds and from the public
 * `ensureStencilSize` — and this viewport uses neither, since changing what is
 * on screen here is `clear()` plus `render()`. If one is ever reached for, the
 * hatch has to be re-applied there too or it will disappear with nothing said.
 *
 * `_capUnits` is the library's own private field, so this asks defensively and
 * gives up quietly: a viewer that has moved it should cost the page its hatch
 * and nothing else. `on` is the checkbox's current answer — a scene rendered
 * while the box is unticked comes up patched but hatching nothing, which keeps
 * the later toggle a pure uniform write.
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
 * uniform is rewritten in place and the next frame draws the new answer, with
 * the compiled program, the cache key and the geometry untouched.
 *
 * The twin of the `userData.hatchShader` reference `hatchShader` keeps: the
 * compile reads the numbers from `userData.hatch` (so a LATER recompile keeps
 * the answer too), and this writes both that source of truth and the live
 * uniform. Caps the scene does not have, or materials not patched, are skipped
 * quietly — this runs on every state event, and a scene with no cut in it has
 * nothing to flip.
 *
 * THE PITCH RIDES ALONG on the same walk rather than getting a writer of its
 * own. It is not part of the toggle and does not belong to `userData.hatch` —
 * it is not per part — but this is the one path that already reaches every LIVE
 * shader, and re-reading the display's density here is what lets a window moved
 * to another display recover on the next flip of the checkbox. See
 * `hatchPitchPx` for why nothing watches for that moment.
 */
export function setCutHatch(g, on) {
  const units = g && g.clipping && g.clipping._capUnits;
  if (!Array.isArray(units)) return 0;
  const flag = on ? 1 : 0;
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
        if (uniforms.hatchPitch) uniforms.hatchPitch.value = hatchPitchPx();
        flipped += 1;
      }
    }
  }
  return flipped;
}

/**
 * `hatchSectionCaps` with this module's promise about it KEPT HERE — the one
 * the viewport calls.
 *
 * The promise is the last paragraph of the header: a viewer that has moved the
 * cap meshes should cost the page its hatch and NOTHING ELSE. `hatchSectionCaps`
 * asks defensively and gives up quietly, but "defensively" is not "cannot
 * throw": every reach into the library's private shape is a property access on
 * an object this does not own, and a getter, a proxy or a revoked reference
 * throws where a plain read would have returned undefined.
 *
 * KEPT AT THE DEFINITION AND NOT AT THE CALL SITE, which is the whole reason
 * this function exists. The call site is inside `show()`, whose own catch draws
 * the error panel INSTEAD OF THE MODEL and sets `loadFailed` — so the next
 * `hmr:state` would not even retry, and a decoration would have taken the whole
 * viewer down. A `try` written around the call there would be correct exactly as
 * long as nobody edited it, and correct-by-spelling is what a test can only
 * check by reading the source. Here it is correct by construction and a test can
 * simply make the patching throw.
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
