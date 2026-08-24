// The public index at `/`.
// Data-driven exactly like a build page: index.json is rewritten on every push,
// the page itself never changes and is served straight from the image.
//
// A separate file rather than an inline <script>: the HTML responses carry
// `Content-Security-Policy: default-src 'self'`, which refuses inline script —
// and that refusal is the point, because it is what stops any content a push
// managed to smuggle into a page from executing.
const fail = (e) => {
  const box = document.getElementById("err");
  box.style.display = "block";
  box.textContent = `FAILED to load the project index\n\n${e && e.stack ? e.stack : e}`;
  console.error(e);
};

try {
  const r = await fetch("/index.json");
  if (!r.ok) throw new Error(`/index.json -> HTTP ${r.status}`);
  const idx = await r.json();
  document.getElementById("count").textContent = `${idx.length} projects`;

  // Built through the DOM, never as an HTML string: `title`, `built` and the rest
  // come from a pushed meta.json, and every project on this host shares one
  // origin, so an `<img onerror>` in one project's title would run against all of
  // them. textContent is what makes that impossible by construction.
  const cell = (cls, text) => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const grid = document.getElementById("grid");
  grid.replaceChildren(...idx.map((p) => {
    const card = document.createElement("a");
    card.className = "card";
    // The project, not one of its pointers. A card is "open this model", and
    // the URL without a pointer is the one that opens whichever of `latest` and
    // `dev` this reader was last on (SPEC 9). Linking straight to `latest` here
    // would quietly overwrite that memory on every visit to the index, which is
    // the one route somebody browsing their own projects takes most.
    card.href = `/project/${encodeURIComponent(p.pid)}/`;
    const h = document.createElement("h3");
    h.textContent = p.title;
    card.append(
      h,
      cell("s", `${String(p.commit).slice(0, 7)} · ${p.built}`),
      cell("t", `${p.parts} parts · ${p.variants} views · ${p.mb} MB`),
      cell("pid", p.pid),
    );
    return card;
  }));
} catch (e) {
  fail(e);
}
