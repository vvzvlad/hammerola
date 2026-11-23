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
// window a pencil opens and the Files window the header's Files opens
// (files.jsx), the latter with the token only. It keeps the Files window's
// change set (`set`, changeset.js), so that closing the window keeps it, runs
// its Commit (`commitSet`) and warns before the page is left with it unsent.
// The page tells the header it changed (`onHeader`); each shuts the other's
// menus (`shutHeader`, `shutPage`).

import React from 'react';

import { isEmpty } from './changeset.js';
import DocShell, { DOCUMENTS_KIND } from './DocShell.jsx';
import { commitSet, FilesWindow, QUEUED } from './files.jsx';
import { baseUrl, filesId, sourceUrl } from './filesview.js';
import HammerolaViewer from './HammerolaViewer.jsx';
import Header from './Header.jsx';
import { buildKey, loadBuilds, PAGE, pageVariant } from './hub.js';
import { RENAME_CSS, renamedAddress, RenameWindow, saveRename } from './rename.jsx';
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
    // `set` is the Files window's change set, null for none; `commit` how its
    // Commit is going or how it ended (`commit` in files.jsx).
    this.state = {
      meta: props.meta, token: readToken(), theme: readTheme(), tabStrip: readTabStrip(), builds: null, rename: null,
      files: false, set: null, commit: null,
    };
    this.header = React.createRef();
    this.page = React.createRef();
    this.filesWindow = React.createRef();
    this.gone = false;
    // The set as it stands this moment, ahead of the render it asks for:
    // Commit and leaving the page read it right after the window hands up the
    // text typed last.
    this.set = null;
    this.committing = false;
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
    this.onFiles = () => this.setState({ files: true });
    this.toast = (said) => this.page.current.toast(said);
    // A set emptied by Revert is no set: the window is on the page's revision
    // again, and what the last Commit said is moot.
    this.onSet = (next) => {
      this.set = isEmpty(next) ? null : next;
      this.setState(this.set ? { set: this.set } : { set: null, commit: null });
    };
    this.onCommit = (over) => this.commitSet(over);
    this.onLeave = (event) => {
      if (this.filesWindow.current) this.filesWindow.current.flush();
      if (!this.set || !this.set.entries.length) return;
      event.preventDefault();
      event.returnValue = '';
    };
  }

  componentDidMount() {
    this.loadBuilds();
    // The header drew before the page existed; now it can read it.
    this.onHeader();
    window.addEventListener('beforeunload', this.onLeave);
  }

  componentDidUpdate(prev, before) {
    if (this.state.token && before.token !== this.state.token) this.loadBuilds();
  }

  componentWillUnmount() {
    window.removeEventListener('beforeunload', this.onLeave);
    this.gone = true;
  }

  /** Commit of the set, with the text typed last, `over` the paths whose
   *  version on the hub it replaces; once built, the page opens the newest
   *  revision of the set's variant. One at a time. */
  async commitSet(over) {
    if (this.committing) return;
    if (this.filesWindow.current) this.filesWindow.current.flush();
    const set = this.set;
    if (!set || !set.entries.length) return;
    this.committing = true;
    const report = (commit) => { if (!this.gone) this.setState({ commit }); };
    report({ busy: true, step: QUEUED });
    let end;
    try {
      end = await commitSet(set, over, { pid: PAGE.pid, token: this.state.token, report, gone: () => this.gone });
    } finally {
      this.committing = false;
    }
    if (!end || this.gone) return;
    if (end.done) {
      // Spent: nothing is left to warn about on the way to the new revision.
      this.set = null;
      this.leave(renamedAddress(PAGE.pid, set.variant));
      return;
    }
    report(end);
  }

  leave(address) {
    window.location.href = address;
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
    const { meta, token, theme, tabStrip, builds, rename, files, set, commit } = this.state;
    const Page = meta && meta.kind === DOCUMENTS_KIND ? DocShell : HammerolaViewer;
    // A first change starts a set only on the newest revision of a variant —
    // `latest`, or the revision builds.json calls that — never on a draft.
    const variant = pageVariant(PAGE, meta);
    const newest = !!meta && !meta.dev && (PAGE.slot === 'latest' || (!!builds && meta.commit === builds.latest));
    return (
      <div style={{ ...css(ROOT), ...FONTS }}>
        <style>{RENAME_CSS}</style>
        <Header ref={this.header} meta={meta} token={token} theme={theme} tabStrip={tabStrip} builds={builds}
                parts={this.parts} onToken={this.onToken} onTheme={this.onTheme}
                onRename={this.onRename} onFiles={this.onFiles} shutPage={this.shutPage} />
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
        {/* Keyed by the build on screen: another build taking its place opens
            the window afresh on that build's files. A set keeps it on the
            set's build, under the key it had when the set started there. */}
        {files && token && (
          <FilesWindow ref={this.filesWindow} key={set ? `${baseUrl(PAGE.pid, set.base)}#${set.base}` : filesId(PAGE, meta)}
                       source={set ? baseUrl(PAGE.pid, set.base) : sourceUrl(PAGE, meta)} token={token} theme={theme}
                       subtitle={[meta.project, set ? set.variant : variant,
                         String((set ? set.base : meta.commit) || '').slice(0, 7)].filter(Boolean).join(' · ')}
                       set={set} commit={commit}
                       start={!set && newest ? { variant, base: meta.commit } : null}
                       notNewest={!set && !newest ? { variant, href: renamedAddress(PAGE.pid, variant) } : null}
                       onSet={this.onSet} onCommit={this.onCommit}
                       toast={this.toast} onClose={() => this.setState({ files: false })} />
        )}
      </div>
    );
  }
}
