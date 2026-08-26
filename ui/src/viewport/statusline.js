// Silencing the library's hover badge.
//
// `tools: false` hides the toolbar, the tree and the orientation marker, and
// that is all it hides: `div.tcv_status_line` lives in `tcv_cad_view` rather
// than in the tools panel, so `showTools(false)` never touches it. Hover
// preselection is on unconditionally (it is only skipped for the GDS format and
// in Studio mode), and every mouse move over the model writes a badge like
// `Circle: r ≈ 5.00, c ≈ (...), len ≈ 31.42` over the bottom-left of the canvas.
// In an interface that draws its own chrome that is a stray artefact of another
// design sitting on top of ours.
//
// PATCHING THE METHOD RATHER THAN HIDING THE ELEMENT, and the reason is the
// second half of what this does. `setStatusLine` is an ordinary method on
// `Display`; the text it is handed is the library's own hover measurement of
// whatever is under the cursor, computed for free on a buffer it re-renders
// anyway. A `display: none` would throw that away, while an override keeps it in
// reach — a ready-made "diameter under the cursor" for the interface to show
// later — and costs exactly the same nothing.
//
// The element is hidden as well, once, because the override only governs what
// happens NEXT: a badge already on screen when this runs would stay there.

export function muteStatusLine(vp, display) {
  if (!display || vp.statusPatched) return;
  const original = display.setStatusLine;
  if (typeof original !== "function") return;
  display.setStatusLine = (text) => {
    // Kept, not shown. Nothing reads this yet; the day the interface wants a
    // hover readout, this is where it already is.
    vp.hoverText = typeof text === "string" ? text : "";
  };
  try {
    if (display.statusLine && display.statusLine.style) {
      display.statusLine.style.display = "none";
      display.statusLine.textContent = "";
    }
  } catch (error) {
    console.warn("status line", error);
  }
  vp.statusPatched = true;
}
