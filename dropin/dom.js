'use strict';

// Snapshot/DOM capture seam for the toHaveScreenshot drop-in (`captureMode: 'snapshot'`).
//
// Unlike the standalone drop-in package, THIS port delegates the heavy lifting to this repo's own
// `captureDOM` (index.js) — the exact capture `percySnapshot()` uses — so the drop-in inherits the
// readiness gate, responsive DOM capture, and cross-origin iframe serialization for free and the
// two entry points can never drift apart.
//
// What this seam adds on top:
//   • Locator subjects → SCOPED snapshots: the element is marked with a data attribute that
//     survives serialization and the snapshot is posted with `scope`, so Percy's server-side
//     render clips to the element (you cannot screenshot "part of a DOM" any other way).
//   • toHaveScreenshot-only options (clip/mask/animations/…) are surfaced at debug as ignored —
//     they apply to raw pixels, not a server-side render.
//
// SEMANTICS (vs screenshot mode):
//   • width: the test's viewport width is sent as `widths: [width]` so Percy renders at the same
//     width the assertion ran at — keeping snapshot identity aligned with the committed-baseline
//     naming. Percy's project-level width config does not multiply drop-in snapshots.
//   • browser: Percy renders web snapshots in ITS OWN browsers (project settings), not the
//     Playwright browser the test ran in — `browser_family` identity is server-controlled here.
const utils = require('@percy/sdk-utils');

const log = utils.logger('playwright-dropin');

// Lazy-required at capture time: the root module may itself be mid-load when the drop-in entry is
// evaluated (specs import both as ESM), and a top-level require here trips Node's CJS↔ESM
// interop on a partially-initialized module.
function rootCaptureDOM(...args) {
  return require('../index.js').captureDOM(...args);
}

const SCOPE_ATTR = 'data-percy-dropin-scope';

// toHaveScreenshot options that only make sense for the raw-pixel screenshot flow.
const SCREENSHOT_ONLY_OPTS = Object.freeze([
  'clip', 'fullPage', 'mask', 'maskColor', 'omitBackground', 'scale', 'animations', 'caret', 'style', 'stylePath'
]);

// A Locator exposes `.page()`; a Page does not.
function resolvePageAndLocator(pageOrLocator) {
  const isLocator = pageOrLocator && typeof pageOrLocator.page === 'function';
  return isLocator
    ? { page: pageOrLocator.page(), locator: pageOrLocator }
    : { page: pageOrLocator, locator: null };
}

// Capture the serialized DOM for a Page or Locator subject. Returns
//   { domSnapshot, url, scope, viewport }
// — everything dropin/index.js needs to build the postSnapshot options. Throws on capture failure;
// the caller's never-fail-the-suite catch owns the policy. `deps` is injectable for tests.
async function captureDomSnapshot(pageOrLocator, options = {}, deps = {}) {
  const fetchPercyDOM = deps.fetchPercyDOM || (() => utils.fetchPercyDOM());
  const capture = deps.captureDOM || rootCaptureDOM;

  const { page, locator } = resolvePageAndLocator(pageOrLocator);

  const ignored = SCREENSHOT_ONLY_OPTS.filter(k => options && options[k] !== undefined);
  if (ignored.length) {
    log.debug(`Percy: snapshot mode ignores screenshot-only option(s): ${ignored.join(', ')}`);
  }

  // Inject the DOM serialization script, exactly as percySnapshot() does.
  const percyDOM = await fetchPercyDOM();
  await page.evaluate(percyDOM);

  // Locator subject → mark the element so the server-side render can be scoped to it. The marker
  // attribute survives serialization (no fragile CSS-selector reconstruction) and is removed right
  // after capture so the live page is left untouched.
  let scope = null;
  if (locator) {
    await locator.evaluate((el, attr) => el.setAttribute(attr, ''), SCOPE_ATTR);
    scope = `[${SCOPE_ATTR}]`;
  }

  let domSnapshot;
  try {
    // Reuse the repo's full capture: readiness gate, responsive capture, CORS iframes, cookies.
    // toHaveScreenshot options are NOT forwarded — they are pixel-flow options (logged above);
    // Percy-level snapshot options are not part of the toHaveScreenshot signature.
    domSnapshot = await capture(page, {}, percyDOM);
  } finally {
    if (locator) {
      await locator.evaluate((el, attr) => el.removeAttribute(attr), SCOPE_ATTR).catch(() => {});
    }
  }

  const viewport = (page && typeof page.viewportSize === 'function' && page.viewportSize()) || null;
  return { domSnapshot, url: page.url(), scope, viewport };
}

module.exports = { captureDomSnapshot, resolvePageAndLocator, SCOPE_ATTR, SCREENSHOT_ONLY_OPTS };
