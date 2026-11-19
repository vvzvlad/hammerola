// The operator's own name and mark, as the hub put them on the page.
//
// The hub writes `<meta name="hmr-brand-name">` and `<meta name="hmr-brand-logo">`
// into the pages when HUB_NAME / HUB_LOGO are set (`render.brand_page`). The tags
// are read on every call rather than once at import: the page is the one source,
// and a test sets and removes them between cases.

const meta = (name) => {
  const tag = document.querySelector(`meta[name="hmr-brand-${name}"]`);
  return tag ? tag.getAttribute('content') : null;
};

/** The wordmark: HUB_NAME, or `hammerola`. */
export const brandName = () => meta('name') || 'hammerola';

/** The URL of the operator's mark, or null for hammerola's own. */
export const brandLogo = () => meta('logo') || null;

/** Whether either was replaced, which is what earns the "Powered by" line. */
export const branded = () => meta('name') !== null || meta('logo') !== null;
