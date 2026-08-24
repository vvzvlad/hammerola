# Vendored viewer assets

`three-cad-viewer.esm.js` and `three-cad-viewer.css` are vendored, not fetched at build
time. They come from the `ocp_vscode` pip package:

```
<venv>/lib/python3.12/site-packages/ocp_vscode/static/js/three-cad-viewer.esm.js
<venv>/lib/python3.12/site-packages/ocp_vscode/static/css/three-cad-viewer.css
```

Taken from `ocp_vscode` 4.0.1 (alongside `ocp-tessellate` 3.4.1, which produces the
JSON these files render) on 2026-08-21.

## Why vendored rather than installed

Adding `ocp_vscode` to `requirements.txt` would drag `cadquery-ocp` — hundreds of
megabytes of OpenCASCADE — into the image. The hub never builds geometry: it only
serves the tessellation JSON that CI produced elsewhere. Two files are the whole
dependency.

## Upgrading

Bump `ocp-tessellate` on the model side and these files together: the JSON format
carries a `version` field (currently 3) and the renderer must understand it. Copy both
files from the same `ocp_vscode` release, then re-check a real project's build renders.

## Do not put these in `data/`

They are assets, not state. `data/` is covered by a docker volume on prod, which would
hide anything shipped there inside the image.
