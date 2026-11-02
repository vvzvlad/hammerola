// The build page's root, which `ui/src/main.jsx` mounts at `hmr_root` with the
// build's meta.json: the header (Header.jsx) and under it the page the build
// has — the model's (HammerolaViewer.jsx), or for `"kind": "documents"` the
// one of a build with no model (DocShell.jsx). It holds what belongs to
// neither and hands it down as props: the build on screen (`meta`, which the
// model's page reports through `onBuild` on its load and a swap in place),
// the token the header's Save and Remove write, the theme its toggle sets,
// whether the header draws its strip of projects (`tabStrip`, which the model
// page's Settings card sets through `onTabStrip`) and the variant's
// `builds.json`, read with the token; and it draws the rename
// window a pencil opens. The page tells the header it changed (`onHeader`);
// each shuts the other's menus (`shutHeader`, `shutPage`).

import React from 'react';

import DocShell, { DOCUMENTS_KIND } from './DocShell.jsx';
import HammerolaViewer from './HammerolaViewer.jsx';
import Header from './Header.jsx';
import { buildKey, loadBuilds, PAGE, pageVariant } from './hub.js';
import { RENAME_CSS, RenameWindow, saveRename } from './rename.jsx';
import { readTabStrip, readTheme, readToken, writeTabStrip, writeTheme } from './store.js';
import { css, FONTS, PAGE_BG, PAGE_FG, SANS } from './style.jsx';

// position:fixed, because this is the WHOLE page: build.html carries nothing
// but the div this mounts into.
const ROOT = `position:fixed;inset:0;display:flex;flex-direction:column;background:${PAGE_BG};color:${PAGE_FG};`
  + `font-family:${SANS};font-size:13px;overflow:hidden;z-index:5`;
// Under the header, the box the page fills.
const BODY = 'position:relative;flex:1;min-height:0';

/** The page. `meta` is the build's meta.json as main.jsx read it, or null
 *  where it did not load (the model's page has the error screen for it). */
export default class BuildPage extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      meta: props.meta, token: readToken(), theme: readTheme(), tabStrip: readTabStrip(), builds: null, rename: null,
    };
    this.header = React.createRef();
    this.page = React.createRef();
    this.gone = false;
    this.parts = () => (this.page.current ? this.page.current.headerParts() : {});
    this.onBuild = (meta) => this.takeBuild(meta);
    this.onHeader = () => this.header.current.forceUpdate();
    this.shutHeader = () => this.header.current.shut();
    this.shutPage = () => this.page.current.closeMenus();
    // The list was read under the token, so it goes with it.
    this.onToken = (token) => this.setState(token ? { token } : { token: null, builds: null });
    this.onTheme = (value) => this.setState({ theme: writeTheme(value) });
    this.onTabStrip = (on) => this.setState({ tabStrip: writeTabStrip(on) });
    // A rename goes on the branch of the page's variant unless the subject
    // names another (a variant's row).
    this.onRename = (subject) => this.setState({ rename: { variant: pageVariant(PAGE, this.state.meta), ...subject } });
    this.toast = (said) => this.page.current.toast(said);
  }

  componentDidMount() {
    this.loadBuilds();
    // The header drew before the page existed; now it can read it.
    this.onHeader();
  }

  componentDidUpdate(prev, before) {
    if (this.state.token && before.token !== this.state.token) this.loadBuilds();
  }

  componentWillUnmount() {
    this.gone = true;
  }

  /** The build the model's page loaded or swapped in. Another build than the
   *  one on screen reads its variant's list again: a swap may cross to another
   *  variant, and a newly published revision has to reach the picker. */
  takeBuild(meta) {
    const moved = buildKey(meta) !== buildKey(this.state.meta);
    this.setState({ meta }, () => {
      if (moved) this.loadBuilds();
    });
  }

  /** builds.json of the variant on screen, with the token, which it is behind
   *  (`loadBuilds` in hub.js). A failure leaves the picker as it was; an
   *  answer for a variant the page has left by the time it lands is dropped. */
  loadBuilds() {
    const { token, meta } = this.state;
    if (!token) return;
    const variant = pageVariant(PAGE, meta);
    loadBuilds(token, variant).then((builds) => {
      if (!this.gone && variant === pageVariant(PAGE, this.state.meta)) this.setState({ builds });
    }, (error) => console.warn('builds', error));
  }

  render() {
    const { meta, token, theme, tabStrip, builds, rename } = this.state;
    const Page = meta && meta.kind === DOCUMENTS_KIND ? DocShell : HammerolaViewer;
    return (
      <div style={{ ...css(ROOT), ...FONTS }}>
        <style>{RENAME_CSS}</style>
        <Header ref={this.header} meta={meta} token={token} theme={theme} tabStrip={tabStrip} builds={builds}
                parts={this.parts} onToken={this.onToken} onTheme={this.onTheme}
                onRename={this.onRename} shutPage={this.shutPage} />
        <div style={css(BODY)}>
          <Page ref={this.page} meta={meta} token={token} theme={theme} builds={builds}
                tabStrip={tabStrip} onTabStrip={this.onTabStrip}
                onBuild={this.onBuild} onHeader={this.onHeader} shutHeader={this.shutHeader}
                onRename={this.onRename} />
        </div>
        {rename && (
          <RenameWindow subject={rename}
                        onSave={(name) => saveRename(PAGE.pid, rename, name, token, this.toast)}
                        onClose={() => this.setState({ rename: null })} />
        )}
      </div>
    );
  }
}
