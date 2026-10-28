// "Open in Bambu Studio" beside a 3MF's download link in both menus that offer
// the build's files: the rows of the header's Downloads menu (downloadsview.js)
// and a part's files in its right-click menu (rowmenu.js), before the row's
// Copy link (copylink.jsx), and drawn like it: a 12 px icon with the words in
// its title.
//
// Bambu Studio downloads and opens the file a link of its own scheme names:
// `bambustudioopen://<address>` on macOS, `bambustudio://open?file=<address>`
// on Windows and Linux, the address url-encoded whole. It cuts the file's name
// off a tail `&name=<name>`, at that literal, and refuses a name that is not a
// 3MF (`Plater::import_model_id` in its source), so only a 3MF row gets one.

import React from 'react';

import { css } from './style.jsx';

/** The format whose rows get the control, spelled as the menus spell one. */
export const BAMBU_FORMAT = '3MF';

/** Whether this browser runs on macOS, where Bambu Studio's scheme differs. */
export const onMac = () => /Mac/.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);

/**
 * The link that opens in Bambu Studio the file `href` downloads: `href` made
 * whole against `page`, its `?files=<key>` kept, and the file's name after it.
 */
export function bambuHref(href, page, mac) {
  const address = new URL(href, page);
  const name = decodeURIComponent(address.pathname.split('/').pop());
  const target = encodeURIComponent(`${address.href}&name=${name}`);
  return mac ? `bambustudioopen://${target}` : `bambustudio://open?file=${target}`;
}

const LINK = 'flex:none;display:flex;align-items:center;text-decoration:none;color:var(--text-faint)';

/** The control. Props: `href`, the download link's own; `style`, a css string
 *  laid over the look (the row's padding); `onClick`, the row's own. */
export default function BambuLink({ href, style = '', onClick }) {
  return (
    <a href={bambuHref(href, window.location.href, onMac())} onClick={onClick}
      title="Open in Bambu Studio" style={css(`${LINK};${style}`)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
      </svg>
    </a>
  );
}
