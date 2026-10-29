// The switcher of the project's variants, in the header by the title of both
// pages that show a build (HammerolaViewer.jsx, DocShell.jsx).
//
// A variant is a branch of the project's repository on the hub, and the list
// is `variants.json` (`loadVariants` in hub.js), which needs no token: every
// reader, with a link or with the password, sees and switches every variant.
// A row is a link to the `latest` of its variant, so a switch is a page load
// like any other link, and everything that hangs off the variant — the
// picker's builds, Share's `latest`, a comment on the draft — follows the
// address the new page reads (`pageVariant` in hub.js).

import React from 'react';

import { buildPath } from './hub.js';
import { FAINT_MONO, GROUP_HEAD, menuRow, popover } from './panelstyle.js';
import { Pencil, RENAME_HOST } from './rename.jsx';
import { css, SANS } from './style.jsx';

/**
 * What the switcher shows for `listing` (`variants.json`) on a page of
 * variant `current` of project `pid`: the label it wears and one row per
 * variant, in the listing's order (the default first), or null where the
 * project has one variant or the list did not come. A variant with no label
 * of its own is called by its branch.
 */
export function variantChoices(listing, pid, current) {
  const listed = listing && Array.isArray(listing.variants) ? listing.variants : [];
  const rows = listed
    .filter((entry) => entry && typeof entry.name === 'string' && entry.name)
    .map((entry) => ({
      key: entry.name,
      label: typeof entry.label === 'string' && entry.label ? entry.label : entry.name,
      href: buildPath(pid, 'latest', entry.name),
      current: entry.name === current,
    }));
  if (rows.length < 2) return null;
  const here = rows.find((row) => row.current);
  return { label: here ? here.label : current, rows };
}

// 220px, the caption included: any wider and on a phone the revision button
// no longer fits beside it and the header breaks into one more row.
const BUTTON = 'display:flex;align-items:center;gap:6px;max-width:220px;padding:5px 10px;'
  + `border:1px solid var(--line);border-radius:6px;background:var(--card-bg);font:500 12px ${SANS};cursor:pointer`;
const LABEL = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

/**
 * The switcher: a button naming the variant on screen, captioned `variant`
 * so a reader sees it is a choice of variants and not a label of the build,
 * and its menu while `open`. `onToggle(event)` opens and shuts it; a click
 * anywhere else is the page's to shut it with. With `onRename(row)`, a row
 * carries before its name the pencil that renames its variant (rename.jsx).
 * Nothing at all for `choices` null.
 */
export function VariantSwitch({ choices, open, onToggle, narrow, onRename }) {
  if (!choices) return null;
  return (
    <div style={css('position:relative;flex:none;min-width:0')}>
      <div onClick={onToggle} title="Variant" style={css(BUTTON)}>
        <span style={css(`${FAINT_MONO};flex:none`)}>variant</span>
        <span style={css(LABEL)}>{choices.label}</span>
        <span style={css('font-size:9px;color:var(--text-faint)')}>&#9662;</span>
      </div>
      <div style={css(popover({
        narrow, anchor: 'left:0;top:36px', width: '280px', radius: '9px',
        tail: 'padding:6px 0;', z: 40, open: !!open }))}>
        <div style={css(GROUP_HEAD)}>VARIANTS</div>
        {choices.rows.map((row) => (
          <a key={row.key} href={row.href} className={onRename ? RENAME_HOST : undefined}
             style={css(`${menuRow(row.current)};text-decoration:none;color:var(--text)`)}>
            {onRename && <Pencil lead title="Rename variant" onClick={() => onRename(row)} />}
            <span style={css(`${LABEL};flex:1`)}>{row.label}</span>
            {row.label !== row.key && <span style={css(FAINT_MONO)}>{row.key}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
