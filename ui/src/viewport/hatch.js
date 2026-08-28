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
// clip normal, so uv IS the section plane, in world proportions. Two things
// follow for free, and both are what a draughtsman would want:
//
//   * every cap of one clip plane shares that frame — same size, same
//     orientation, same origin — so the lines run STRAIGHT ACROSS THE WHOLE
//     CUT, through part after part, instead of restarting per solid;
//   * the pitch is a fraction of the clipping region, i.e. of the model's own
//     extent, so a 400 mm assembly and a 4 mm bracket are hatched alike, and a
//     small part in a big assembly gets few lines exactly as it should.
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

/** Line pitch, as periods per unit of the cap's uv — i.e. across the whole
 *  clipping region. 26 puts a line about every 1.4 mm on a 36 mm scene and
 *  about every 15 mm on a 400 mm one. */
const PERIODS = 26.0;

/** Half a line's width, in those same period units: the lines cover 2 x this.
 *  A fifth of the pitch reads as a drawn line rather than as stripes. */
const HALF_WIDTH = 0.1;

/**
 * The hatch itself.
 *
 * `vUv` is the section plane (see the header). The direction is the uv
 * diagonal, which is the 45 degrees a section is conventionally hatched at, and
 * it turns with the plane rather than with the camera.
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
 */
const HATCH = `
  {
    float hatchS = dot(vUv - 0.5, vec2(0.7071067811865476)) * ${PERIODS.toFixed(1)};
    float hatchW = fwidth(hatchS);
    float hatchF = abs(fract(hatchS) - 0.5);
    float hatchSharp = 1.0 - smoothstep(${HALF_WIDTH} - hatchW,
                                        ${HALF_WIDTH} + hatchW, hatchF);
    float hatchCov = mix(hatchSharp, ${(2 * HALF_WIDTH).toFixed(2)},
                         smoothstep(${HALF_WIDTH}, ${(3 * HALF_WIDTH).toFixed(2)},
                                    hatchW));
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
 * needed, and the condition under which that would change is worth writing
 * down: a `toString()` cannot see a CLOSURE, so the day any hatch parameter
 * becomes per-material (a pitch from the model, a per-part angle) the key has to
 * be declared explicitly or every cap will silently share whichever program was
 * compiled first.
 */
export function hatchShader(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(MARKER, MARKER + HATCH);
}

/**
 * Patch one cap material, or leave it exactly as it was.
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
 */
function patchCapMaterial(material) {
  if (!material) return false;
  if (material.onBeforeCompile === hatchShader) return true;
  if (typeof material.onBeforeCompile !== "function") return false;
  material.defines = { ...(material.defines || {}), USE_UV: "" };
  material.onBeforeCompile = hatchShader;
  material.needsUpdate = true;
  return true;
}

/**
 * Hatch every cut face in the scene. Safe to call again; does nothing twice.
 *
 * CALLED AFTER `render()` AND NOWHERE ELSE, because that is when the cap meshes
 * exist: the library builds them in `Clipping._createStencils`, one per (plane,
 * solid). There is a second path that rebuilds them — `rebuildStencils`, from
 * `addPart`/`updatePart` growing the bounds and from the public
 * `ensureStencilSize` — and this viewport uses neither, since changing what is
 * on screen here is `clear()` plus `render()`. If one is ever reached for, the
 * hatch has to be re-applied there too or it will disappear with nothing said.
 *
 * `_planeMeshGroup` is the library's own private field, so this asks
 * defensively and gives up quietly: a viewer that has moved it should cost the
 * page its hatch and nothing else.
 */
export function hatchSectionCaps(g) {
  const group = g && g.clipping && g.clipping._planeMeshGroup;
  const caps = group && group.children;
  if (!Array.isArray(caps) || caps.length === 0) {
    // Not an error on its own: `hatchSectionCaps` is called on every render and
    // a scene the library built no caps for is a scene with no solids in it.
    return 0;
  }
  let done = 0;
  for (const cap of caps) if (patchCapMaterial(cap && cap.material)) done += 1;
  // ONCE PER CALL AND NOT ONCE PER CAP — twelve identical lines from one moved
  // field is noise — and no once-per-page latch, which would be module state the
  // suite then has to prove it resets between tests. A render is the unit here.
  if (done < caps.length) {
    console.warn("section hatch: the library's cap materials are not where this "
                 + "expects them; the cut will be drawn as a plain fill");
  }
  return done;
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
export function safeHatch(g) {
  try {
    return hatchSectionCaps(g);
  } catch (error) {
    console.warn("section hatch", error);
    return 0;
  }
}

/** The chunk this splices at, so the suite can ask whether three.js still has
 *  it. Nothing at runtime can: by the time a shader is compiled the hatch has
 *  already silently not happened, and the page renders perfectly without it. */
export const hatchMarker = MARKER;
