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
// IN THE PLANE OF THE CUT, NOT ON THE SCREEN, and that is the decision the rest
// of the file follows from. A screen-space hatch reads as a film laid over the
// picture: it stands still while the model turns under it. The cap quad already
// carries the frame this needs — `uv` runs 0..1 across a quad that
// `PlaneMesh.updateMatrixWorld` scales to `0.5 * size` and turns to face the
// clip normal, so uv IS the section plane, in world proportions.
//
// PER PART, AND NOT ONE FIELD ACROSS THE CUT (issue #13). The first version
// hatched every cap out of the quad's own frame, which made one clip plane's
// stripes run through wall, board and lid unbroken — the cut read as one body,
// which is the one reading a section exists to correct. Two decisions, both the
// owner's, and neither re-opens from here:
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
//   * the pitch follows the PART, not the scene: roughly the same number of
//     lines on any cut face, so a small part in a big assembly stays readable.
//     The accepted cost is that the hatch is no longer a scale — two builds of
//     different extents no longer hatch with the same pitch.
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

/** Lines laid across ONE PART's extent in the plane of the cut. Twelve is the
 *  middle of the owner's 10–14 range, and it is where the two edges of that
 *  range stop working: below ten, a narrow face reads as a tint rather than as
 *  hatching; above fourteen, the moire crossfade at the bottom of the shader
 *  starts averaging the pattern away on a part that is small on screen. The
 *  pitch itself is `cap.size * TARGET_LINES / extent` — see `capUniforms`. */
const TARGET_LINES = 12.0;

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

/** Half a line's width, in period units: the lines cover 2 x this. A fifth of
 *  the pitch reads as a drawn line rather than as stripes. */
const HALF_WIDTH = 0.1;

/** The hatch's five uniforms, declared at global scope just ahead of three.js's
 *  own — see UNIFORM_ANCHOR. Plain `float`s and nothing structured, because no
 *  THREE constructor is reachable from this module to build a Vector2 with. */
const HATCH_UNIFORMS = `
uniform float hatchPeriods;
uniform float hatchDirX;
uniform float hatchDirY;
uniform float hatchPhase;
uniform float hatchOn;
`;

/**
 * The hatch itself.
 *
 * `vUv` is the section plane (see the header). The line direction comes in as
 * the `hatchDirX`/`hatchDirY` pair — one slope out of HATCH_SLOPES, turned 90
 * degrees because the stripes are the LEVEL SETS of `dot(p, dir)` and so run
 * perpendicular to it — and the pitch and phase in as `hatchPeriods` and
 * `hatchPhase`, all of them per part. See `capUniforms` for where the numbers
 * come from.
 *
 * FLAT, and deliberately: this REPLACES `gl_FragColor` rather than tinting the
 * lit result. A `MeshStandardMaterial` would shade the lines along with the
 * fill, and a cut face that is darker at one end because of where a lamp
 * happens to be is a cut face nobody can read a hatch off. It is spliced in
 * before `tonemapping_fragment` and `colorspace_fragment`, so the colour
 * written here is in the working (linear) space exactly like `diffuse` and goes
 * out through the same conversions as the rest of the scene.
 *
 * `fwidth` is the whole of the anti-aliasing AND of the behaviour when the
 * model is small on screen: once a period is a couple of pixels wide the sharp
 * coverage is crossfaded to the pattern's own average, so a cut that is too
 * small to hatch settles into an evenly darker fill instead of aliasing into
 * moire or filling in solid.
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
    float hatchS = dot(vUv - 0.5, vec2(hatchDirX, hatchDirY)) * hatchPeriods
                   + hatchPhase;
    float hatchW = fwidth(hatchS);
    float hatchF = abs(fract(hatchS) - 0.5);
    float hatchSharp = 1.0 - smoothstep(${HALF_WIDTH} - hatchW,
                                        ${HALF_WIDTH} + hatchW, hatchF);
    float hatchCov = mix(hatchSharp, ${(2 * HALF_WIDTH).toFixed(2)},
                         smoothstep(${HALF_WIDTH}, ${(3 * HALF_WIDTH).toFixed(2)},
                                    hatchW)) * hatchOn;
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
 * DECLARED, NOT JUST READ: the five identifiers exist for the GLSL compiler
 * only because `HATCH_UNIFORMS` is spliced in ahead of three.js's own uniform
 * block. Losing that splice is a shader that fails to compile — loud in the
 * console, and the suite holds the anchor to the vendored bundle for it.
 */
export function hatchShader(shader) {
  const p = this && this.userData && this.userData.hatch;
  if (p) {
    shader.uniforms.hatchPeriods = { value: p.periods };
    shader.uniforms.hatchDirX = { value: p.dirX };
    shader.uniforms.hatchDirY = { value: p.dirY };
    shader.uniforms.hatchPhase = { value: p.phase };
    shader.uniforms.hatchOn = { value: p.on };
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
 * The eight corners of a solid's bounding box, taken to world with plain
 * arithmetic over `matrixWorld.elements` (a column-major 4x4; the w row is
 * dropped because a mesh matrix is affine).
 *
 * NOT `_solidWorldBox()`: it returns one SHARED scratch Box3 that the library's
 * cull loop overwrites every frame, so a box kept past the next frame holds
 * whoever culled last. The corners land in a fresh array of 24 numbers instead.
 * `boundingBox` is computed at build time by the library (when the front mesh
 * is built) and is in LOCAL coordinates; `front.matrixWorld` folds in the group
 * transforms down to the solid.
 */
function worldCorners(solid) {
  const front = solid && solid.front;
  const bb = front && front.geometry && front.geometry.boundingBox;
  const e = front && front.matrixWorld && front.matrixWorld.elements;
  if (!bb || !bb.min || !bb.max || !e || e.length < 16) return null;
  const corners = [];
  for (const x of [bb.min.x, bb.max.x]) {
    for (const y of [bb.min.y, bb.max.y]) {
      for (const z of [bb.min.z, bb.max.z]) {
        corners.push(
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        );
      }
    }
  }
  return corners;
}

/**
 * The hatch parameters for ONE cap of the part named `key`, or null when the
 * cap does not carry what the arithmetic needs.
 *
 * PITCH. One uv unit of the cap quad is `cap.size` world units (a
 * `PlaneGeometry(2, 2)` scaled by `0.5 * size`), and `extent` is the part's
 * world-box footprint in the plane of the cut, so
 * `periods = cap.size * TARGET_LINES / extent` lays about TARGET_LINES lines
 * across the part — the pitch follows the part and not the scene, which is the
 * owner's first decision. The footprint is read as the larger of the two spans
 * the eight world corners cover along an in-plane basis.
 *
 * WHAT THAT MEASURES IS THE PART, NOT THE CUT FACE, and the two can differ by
 * any amount — so TARGET_LINES is what a cut ACROSS the part gets, not a floor
 * under every cut. A plane taken through a 5 mm boss on a 100 mm bracket cuts a
 * face one twentieth of the box it is measured against and is hatched with
 * about half a line: one diagonal stroke, not a hatch. That is the honest cost
 * of measuring a box, and it is written here rather than discovered, because
 * the number in the docstring above is otherwise read as a promise. Measuring
 * the face itself means intersecting the plane with the part's triangles —
 * which is exactly what the section outline already does (`outline.js`,
 * `planeThroughTriangles`). Its bounds are the better number to divide by;
 * nothing here reads them yet, so that is a wiring job outstanding rather than
 * a piece of work not done.
 *
 * ANGLE AND PHASE come from the part's key alone, through one mixed hash, so
 * they are stable across revisions and independent of where the part sits. The
 * slope is one of HATCH_SLOPES, all pairwise far enough apart to read as
 * different; the phase takes the bits a second mix produces, so two keys that
 * do land on one slope still hatch out of step — and two that coincide in
 * BOTH are the rare pair the header accepts.
 */
function capUniforms(key, cap, corners) {
  const n = cap && cap.plane && cap.plane.normal;
  const size = cap && cap.size;
  if (!n || typeof size !== "number" || !(size > 0) || !Number.isFinite(size)) {
    return null;
  }
  // Unit normal, normalised here rather than assumed: a scaled normal would
  // tilt the in-plane projection and quietly stretch the pitch.
  const nl = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) || 1;
  const nx = n.x / nl, ny = n.y / nl, nz = n.z / nl;
  // An in-plane basis. u is the world axis LEAST aligned with the normal,
  // rotated flat by the cross product, so it is never degenerate whatever the
  // plane's orientation; v completes it. All plain arithmetic — no THREE
  // constructor is reachable here (the vendored bundle exports no symbols).
  let ax = 0, ay = 0, az = 1;
  const dx = Math.abs(nx), dy = Math.abs(ny), dz = Math.abs(nz);
  if (dx <= dy && dx <= dz) { ax = 1; ay = 0; az = 0; }
  else if (dy <= dz) { ax = 0; ay = 1; az = 0; }
  let ux = ny * az - nz * ay, uy = nz * ax - nx * az, uz = nx * ay - ny * ax;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  // The larger of the two spans the corners cover in the plane. One reference
  // point cancels out of a span, so no plane origin is needed.
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < corners.length; i += 3) {
    const du = corners[i] * ux + corners[i + 1] * uy + corners[i + 2] * uz;
    const dv = corners[i] * vx + corners[i + 1] * vy + corners[i + 2] * vz;
    if (du < minU) minU = du;
    if (du > maxU) maxU = du;
    if (dv < minV) minV = dv;
    if (dv > maxV) maxV = dv;
  }
  const extent = Math.max(maxU - minU, maxV - minV);
  if (!Number.isFinite(extent) || extent <= 0) return null;
  const h = mix(hashKey(key));
  const slope = HATCH_SLOPES[h % HATCH_SLOPES.length];
  // The stripes run perpendicular to the dot direction, hence the +90.
  const rad = (slope + 90) * Math.PI / 180;
  return {
    periods: size * TARGET_LINES / extent,
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
 * the per-part parameters need the SOLID and its caps together. There is a
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
    const corners = key ? worldCorners(solid) : null;
    const count = Array.isArray(caps) ? caps.length : 0;
    for (let k = 0; k < count; k++) {
      total += 1;
      const params = corners && capUniforms(key, caps[k], corners);
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
      const live = ud.hatchShader && ud.hatchShader.uniforms
        && ud.hatchShader.uniforms.hatchOn;
      if (live) {
        live.value = flag;
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

/** Lines per part extent, exported for the suite — the pitch test works the
 *  owner's formula (`cap.size * TARGET_LINES / extent`) against what
 *  `hatchSectionCaps` actually stored. */
export const hatchTargetLines = TARGET_LINES;
