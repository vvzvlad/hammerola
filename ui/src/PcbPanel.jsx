// The board view's own panel, over the top right of the board's canvas: which
// layers are drawn and which one is the active layer, how strongly the copper
// zone fills are drawn, and the net of what was last clicked. KicadView.jsx
// draws it over the PCB element and hands it that element (`element`) and
// whether the board is the view on screen (`active`).
//
// It exists because `hide-chrome` drops the viewer's own panels
// (KicadView.jsx), and a board drawn with every layer at once and its zones as
// the viewer fills them is one mass of copper in which no track can be read.
//
// THE VIEWER OWNS THE STATE; this panel holds a copy it reads back
// (`getPcbViewState`, `getHighlightedNets`) after each change it makes, when
// the element reports `ecad-viewer:view-state-change` or
// `ecad-viewer:highlight-change`, and when the board comes back on screen,
// since KicadView changes the element while it is hidden (a part selected in
// another view). Hiding is `visibility`, so element, listeners and state all
// stay.
//
// THE ZONES ARE DIMMED WHEN THE BOARD OPENS, to `ZONE_OPACITY`.
//
// A CLICK ON A TRACK, A PAD, A VIA OR A ZONE LIGHTS ITS WHOLE NET. In
// `source-mode="host"` the viewer reports the click (`ecad-viewer:selection`,
// carrying `net`) and lights nothing; this panel lights the net with the
// viewer's own highlight (`setHighlightedNets`, which dims everything else)
// and names it in its header. A click on anything with no net, the bare board
// included, puts it out. Which part is selected across the views stays
// KicadView's: the same click reaches both listeners.

import React from 'react';

import { SELECTION_EVENT } from './KicadView.jsx';
import { ELLIPSIS, eyeDot, eyeOuter, FILL, SEGMENTED, SWATCH } from './panelstyle.js';
import { css, MONO, SANS } from './style.jsx';

/** What an element reports after each `setPcb…` and `applyPcbLayerPreset`. */
export const VIEW_STATE_EVENT = 'ecad-viewer:view-state-change';

/** What an element reports when its lit nets change other than through
 *  `setHighlightedNets` — `clearSelection`, which KicadView calls. */
export const HIGHLIGHT_EVENT = 'ecad-viewer:highlight-change';

/**
 * How strongly the zone fills are drawn when the board opens; the viewer's own
 * is 0.6. Chosen by looking at a four-layer board (F.Cu, In1.Cu, In2.Cu, B.Cu,
 * every one of them poured) with every layer drawn: at 0.6 the fills above a
 * layer bury its tracks and only the top layer can be read; at 0.2 a back-side
 * track shows through the three fills above it at about half its strength
 * (0.8 cubed) and a pour still reads as copper. Lower, the tracks gain little
 * and the pours fade into the bare board.
 */
export const ZONE_OPACITY = 0.2;

/** The layer presets, by the names the viewer takes (`applyPcbLayerPreset`). */
export const PRESETS = [['all', 'All'], ['front', 'Front'], ['back', 'Back'], ['copper', 'Copper']];

/** The items a selection event carries the net of. */
const NET_ITEMS = new Set(['track', 'via', 'pad', 'zone', 'net']);

/** The net a click selected, as `setHighlightedNets` takes it, or null for a
 *  click on what has none: a footprint, a drawing, the bare board. */
export function selectedNet(detail) {
  if (!detail || !NET_ITEMS.has(detail.itemType) || !detail.net) return null;
  return detail.netCode ? { name: detail.net, netCode: detail.netCode } : { name: detail.net };
}

/** The panel's copy of the element's state, or null while it has no board. */
export function readBoard(element) {
  const view = element.getPcbViewState();
  if (!view) return null;
  const nets = element.getHighlightedNets();
  return {
    layers: view.layers,
    zones: view.objectOpacity.zones,
    net: nets.length ? nets.map((net) => net.name).join(', ') : null,
  };
}

const PANEL = 'position:absolute;top:10px;right:10px;width:200px;max-width:calc(100% - 20px);max-height:calc(100% - 20px);'
  + 'box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;'
  + `background:var(--float-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 4px 16px var(--shadow-soft);font:400 11.5px ${SANS};color:var(--text);visibility:`;
const HEAD = `flex:none;display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none;font:600 11.5px ${SANS}`;
const NET_LABEL = 'flex:none;font-weight:400;color:var(--text-muted)';
const NET_NAME = `min-width:0;${ELLIPSIS};font:600 11px ${MONO};color:var(--accent-text)`;
const BODY = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border-top:1px solid var(--line-soft)';
const PRESET_ROW = `flex:none;margin:8px 10px 0;${SEGMENTED}`;
const presetPill = `flex:1 1 auto;padding:3px 6px;text-align:center;border-radius:4px;font:500 11px ${SANS};color:var(--text-soft);cursor:pointer;user-select:none`;
const ZONES = 'flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px 6px';
const ZONES_LABEL = 'flex:none;color:var(--text-soft)';
const ZONES_VALUE = `flex:none;width:30px;text-align:right;font:400 10.5px ${MONO};color:var(--text-muted)`;
const ZONES_INPUT = 'flex:1;min-width:0;margin:0;accent-color:var(--accent)';
const LIST = 'flex:1 1 auto;min-height:0;overflow:auto;padding:2px 0 6px';
const layerRow = (active) => 'display:flex;align-items:center;gap:6px;padding:3px 10px;'
  + (active ? 'background:var(--accent-bg);color:var(--accent-text)' : '');
const LAYER_NAME = `${FILL};min-width:0;display:flex;align-items:center;cursor:pointer;user-select:none`;
const EYE = 'flex:none;display:flex;padding:3px 0 3px 4px;cursor:pointer';

const CHEVRON = (open) => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
       style={{ flex: 'none', transform: open ? 'none' : 'rotate(-90deg)' }}>
    <path d="M4 6l4 4 4-4" />
  </svg>
);

/** The panel. Props: `element`, the PCB `<ecad-viewer>`; `active`, whether
 *  the board is on screen (the panel is shown with it). */
export default class PcbPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { open: true, layers: [], zones: ZONE_OPACITY, net: null };
    this.element = null;
    this.read = () => this.readBack();
    this.onSelect = (event) => this.light(selectedNet(event.detail));
    this.toggle = () => this.setState({ open: !this.state.open });
    this.onZones = (event) => this.change((element) => element.setPcbObjectOpacity('zones', Number(event.target.value)), false);
  }

  componentDidMount() {
    this.attach(this.props.element);
  }

  componentDidUpdate(prev) {
    if ((this.props.element || null) !== this.element) this.attach(this.props.element);
    else if (this.props.active && !prev.active) this.readBack();
  }

  componentWillUnmount() {
    this.attach(null);
  }

  /** Listen to `element` instead of the one before, dim its zones and read it. */
  attach(element) {
    const listeners = [[VIEW_STATE_EVENT, this.read], [HIGHLIGHT_EVENT, this.read], [SELECTION_EVENT, this.onSelect]];
    for (const [type, listener] of listeners) {
      if (this.element) this.element.removeEventListener(type, listener);
      if (element) element.addEventListener(type, listener);
    }
    this.element = element || null;
    if (!element) return;
    element.setPcbObjectOpacity('zones', ZONE_OPACITY);
    this.readBack();
  }

  readBack() {
    const board = this.element && readBoard(this.element);
    if (board) this.setState(board);
  }

  /**
   * One change made on the element, then read back. The viewer paints a net's
   * highlight for the layers drawn at the time and does not repaint it when
   * they change, so a change to the layers (`relight`) lights the same nets
   * again.
   */
  change(apply, relight = true) {
    const { element } = this;
    if (!element) return;
    apply(element);
    const nets = relight ? element.getHighlightedNets() : [];
    if (nets.length) element.setHighlightedNets(nets);
    this.readBack();
  }

  /** Light `net`, or put out whatever is lit when it is null. */
  light(net) {
    const { element } = this;
    if (!element) return;
    if (net) element.setHighlightedNets([net]);
    else if (element.getHighlightedNets().length) element.setHighlightedNets([]);
    this.readBack();
  }

  render() {
    const { open, layers, zones, net } = this.state;
    return (
      <div data-panel="pcb" style={css(PANEL + (this.props.active ? 'visible' : 'hidden'))}>
        <div onClick={this.toggle} title={open ? 'Hide the layers' : 'Show the layers'} style={css(HEAD)}>
          {CHEVRON(open)}
          <span style={css(FILL)}>Layers</span>
          {net && <span style={css(NET_LABEL)}>net</span>}
          {net && <span title={net} style={css(NET_NAME)}>{net}</span>}
        </div>
        {open && (
          <div style={css(BODY)}>
            <div style={css(PRESET_ROW)}>
              {PRESETS.map(([preset, label]) => (
                <div key={preset} data-preset={preset} style={css(presetPill)}
                     onClick={() => this.change((element) => element.applyPcbLayerPreset(preset))}>{label}</div>
              ))}
            </div>
            <label title="How strongly the copper zone fills are drawn" style={css(ZONES)}>
              <span style={css(ZONES_LABEL)}>Zones</span>
              <input type="range" min="0" max="1" step="0.05" value={zones} onChange={this.onZones} style={css(ZONES_INPUT)} />
              <span style={css(ZONES_VALUE)}>{`${Math.round(zones * 100)}%`}</span>
            </label>
            <div style={css(LIST)}>
              {layers.map((layer) => (
                <div key={layer.name} data-layer={layer.name} style={css(layerRow(layer.highlighted))}>
                  <span title={layer.highlighted ? 'The active layer, drawn over the others' : 'Draw this layer over the others'}
                        style={css(LAYER_NAME + (layer.visible ? '' : ';color:var(--text-faint)'))}
                        onClick={() => this.change((element) => element.setPcbLayerHighlight(layer.highlighted ? null : layer.name))}>
                    <span style={css(SWATCH + layer.color + (layer.visible ? '' : ';opacity:.35'))} />
                    <span style={css(ELLIPSIS)}>{layer.name}</span>
                  </span>
                  <span data-eye={layer.name} title={layer.visible ? 'Hide this layer' : 'Show this layer'} style={css(EYE)}
                        onClick={() => this.change((element) => element.setPcbLayerVisibility(layer.name, !layer.visible))}>
                    <span style={css(eyeOuter(layer.visible ? 'on' : 'off'))}>
                      <span style={css(eyeDot(layer.visible ? 'on' : 'off'))} />
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
}
